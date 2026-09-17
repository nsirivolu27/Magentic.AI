import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "../client.js";
import { EmbeddingCache } from "./cache.js";
import { packSources, retrieve, type RetrievalDeps, type RetrievalUsage } from "./corpus.js";
import type { ScoredChunk } from "./chunk.js";
import {
  llmConfigFromEnv,
  loadChatModel,
  loadEmbeddings,
  type ChatModelLike,
  type EmbeddingsLike,
  type LlmConfig,
} from "./provider.js";

/**
 * The two tools the language model integration adds, and nothing else.
 *
 * Both are read-only and neither writes anything back to the relay. That is a
 * deliberate boundary, not a first cut: a model's reading of a conversation
 * is a derivation, and the moment a derivation is stored next to the
 * conversation it stops being obvious which is which. If a person wants an
 * answer kept, they save it as a conversation through the tools that already
 * exist, with their own name on it.
 *
 * Neither tool is registered when no provider is configured. The adapter
 * gates its write tools the same way and for the same reason: a tool a model
 * cannot see is a tool it will not build a plan around, so an operator who
 * has not opted into sending conversation text anywhere never gets a proposal
 * to do it.
 */

const searchSchema = {
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(50).default(8),
  minScore: z.number().min(0).max(1).default(0.2),
  perConversation: z.number().int().min(1).max(20).default(3),
  conversationIds: z.array(z.string().uuid()).max(100).optional(),
  recent: z.number().int().min(0).max(200).default(25),
};

const askSchema = {
  question: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(30).default(8),
  minScore: z.number().min(0).max(1).default(0.2),
  perConversation: z.number().int().min(1).max(20).default(3),
  conversationIds: z.array(z.string().uuid()).max(100).optional(),
  recent: z.number().int().min(0).max(200).default(25),
};

const searchObject = z.object(searchSchema);
const askObject = z.object(askSchema);

export interface LlmToolDeps {
  config: LlmConfig;
  /** Overridable so tests can drive the whole path without a network or a package. */
  embeddings?: () => Promise<EmbeddingsLike>;
  chatModel?: () => Promise<ChatModelLike>;
}

export function registerLlmTools(
  server: McpServer,
  client: LnkzClientLike,
  deps: LlmToolDeps | undefined = defaultDeps(),
): void {
  if (!deps) return;
  const { config } = deps;
  const cache = new EmbeddingCache(config.cacheSize);
  const embeddings = deps.embeddings ?? (() => loadEmbeddings(config));
  const chatModel = deps.chatModel ?? (() => loadChatModel(config));

  const where = config.baseUrl ?? (config.provider === "openai" ? "OpenAI" : "the configured Ollama server");
  const egress = `Conversation text from this instance is sent to ${where} for embedding.`;

  const search = async (input: unknown) => {
    const options = searchObject.parse(input);
    const retrieval: RetrievalDeps = { client, config, embeddings: await embeddings(), cache };
    const result = await retrieve(retrieval, {
      query: options.query,
      limit: Math.min(options.limit, config.maxChunks),
      minScore: options.minScore,
      perConversation: options.perConversation,
      recent: options.recent,
      ...(options.conversationIds ? { conversationIds: options.conversationIds } : {}),
    });
    return {
      content: [{ type: "text" as const, text: searchToMarkdown(options.query, result.chunks, result.usage) }],
      structuredContent: {
        query: options.query,
        matches: result.chunks.map(toMatch),
        usage: result.usage,
      },
    };
  };

  server.registerTool(
    "semantic_search",
    {
      title: "Search conversations by meaning",
      description:
        "Finds passages whose meaning matches the query, rather than passages that share its words. "
        + "Use it when search_conversations returns nothing but the subject was certainly discussed, "
        + "or when the question is about a decision, a constraint or a commitment rather than a term. "
        + "Candidates come from the relay's own keyword search plus the most recent conversations, and "
        + "are then ranked by embedding similarity. Every match names the conversation and the messages "
        + `it came from. ${egress}`,
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    search,
  );

  server.registerTool(
    "ask_conversations",
    {
      title: "Answer a question from stored conversations",
      description:
        "Answers a question using only the stored conversations, with a numbered citation on every "
        + "claim, and says so plainly when the conversations do not contain the answer. Use it for "
        + "questions that span conversations, such as what was decided about a subject or what is "
        + "still open. This does not store the answer; save it as a conversation if it should be kept. "
        + egress,
      inputSchema: askSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input: unknown) => {
      const options = askObject.parse(input);
      const retrieval: RetrievalDeps = { client, config, embeddings: await embeddings(), cache };
      const result = await retrieve(retrieval, {
        query: options.question,
        limit: Math.min(options.limit, config.maxChunks),
        minScore: options.minScore,
        perConversation: options.perConversation,
        recent: options.recent,
        ...(options.conversationIds ? { conversationIds: options.conversationIds } : {}),
      });

      if (result.chunks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No stored conversation is close enough to this question to answer it." }],
          structuredContent: { question: options.question, answer: null, sources: [], usage: result.usage },
        };
      }

      const packed = packSources(result.chunks, config.maxContextChars);
      const model = await chatModel();
      const response = await model.invoke(groundedPrompt(options.question, packed.text));
      const answer = textOf(response.content).trim();

      return {
        content: [{ type: "text" as const, text: answerToMarkdown(answer, packed.sources) }],
        structuredContent: {
          question: options.question,
          answer,
          sources: packed.sources.map(toMatch),
          usage: { ...result.usage, contextChars: packed.usedChars },
        },
      };
    },
  );
}

/** Configuration from the environment, or undefined when the integration is off. */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): LlmToolDeps | undefined {
  const config = llmConfigFromEnv(env);
  return config ? { config } : undefined;
}

/**
 * The prompt is a plain string on purpose.
 *
 * LangChain's ChatPromptTemplate would let us write this with placeholders,
 * at the cost of a templating language whose escaping rules apply to
 * conversation text we do not control. A conversation containing braces would
 * either throw or interpolate. A template string has neither failure mode,
 * and the structure below is the part that matters anyway: sources arrive
 * numbered, the instruction to refuse comes before the sources rather than
 * after them, and the question comes last so it is the most recent thing the
 * model read.
 */
function groundedPrompt(question: string, sources: string): string {
  return [
    "Answer the question using only the numbered sources below.",
    "Cite the source number in square brackets after each claim, like [2].",
    "If the sources do not contain the answer, say exactly that and stop; do not answer from general knowledge.",
    "Quote a decision in the words it was made in rather than paraphrasing it.",
    "",
    "Sources:",
    sources,
    "",
    `Question: ${question}`,
  ].join("\n");
}

/** Chat models return a string or an array of content parts, depending on the model. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function toMatch(chunk: ScoredChunk) {
  return {
    conversationId: chunk.conversationId,
    title: chunk.title,
    chunkIndex: chunk.index,
    messageIds: chunk.messageIds,
    score: Number(chunk.score.toFixed(4)),
    excerpt: chunk.text.length > 600 ? `${chunk.text.slice(0, 600)}...` : chunk.text,
  };
}

function searchToMarkdown(query: string, chunks: readonly ScoredChunk[], usage: RetrievalUsage): string {
  if (chunks.length === 0) {
    return `No passage scored high enough for "${query}". ${describeUsage(usage)}`;
  }
  const lines = [`# Semantic matches for "${query}"`, ""];
  for (const [position, chunk] of chunks.entries()) {
    lines.push(
      `## ${position + 1}. ${chunk.title} (${chunk.score.toFixed(2)})`,
      `Conversation ${chunk.conversationId}, ${chunk.messageIds.length} messages.`,
      "",
      chunk.text.length > 800 ? `${chunk.text.slice(0, 800)}...` : chunk.text,
      "",
    );
  }
  lines.push("---", describeUsage(usage));
  return lines.join("\n");
}

function answerToMarkdown(answer: string, sources: readonly ScoredChunk[]): string {
  const lines = [answer, "", "## Sources", ""];
  for (const [position, source] of sources.entries()) {
    lines.push(`[${position + 1}] ${source.title} - conversation ${source.conversationId}, messages ${source.messageIds.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Printed with every result. Retrieval that sends text to a provider should
 * say how much it sent, in the same place a person reads the answer, rather
 * than in a log they will not open.
 */
function describeUsage(usage: RetrievalUsage): string {
  return `Read ${usage.conversationsRead} of ${usage.candidates} candidate conversations, `
    + `${usage.chunks} passages: ${usage.embedded} embedded in ${usage.batches} request(s), ${usage.cached} from cache.`;
}
