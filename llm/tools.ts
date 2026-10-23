import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "../client.js";
import { EmbeddingCache } from "./cache.js";
import { packSources, retrieve, retrieveLexically, type RetrievalDeps, type RetrievalUsage } from "./corpus.js";
import { chooseChatModel, type ModelTier } from "./sampling.js";
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

/**
 * Retrieval settings for an instance that configured no provider at all.
 *
 * The lexical path still needs to know how big a chunk is and how much text
 * may reach a model. These are the same numbers the configured path defaults
 * to, so turning a provider on later changes what retrieval can do without
 * changing how it is shaped.
 */
const LEXICAL_DEFAULTS = {
  maxConversations: 40,
  maxChunks: 12,
  chunkChars: 1_600,
  maxContextChars: 24_000,
} as const;

export function registerLlmTools(
  server: McpServer,
  client: LnkzClientLike,
  deps: LlmToolDeps | undefined = defaultDeps(),
): void {
  const config = deps?.config;
  const cache = new EmbeddingCache(config?.cacheSize ?? 0);
  const embeddings = deps?.embeddings ?? (config ? () => loadEmbeddings(config) : undefined);
  const chatModel = deps?.chatModel ?? (config ? () => loadChatModel(config) : undefined);
  const shape = config ?? LEXICAL_DEFAULTS;

  const where = config
    ? (config.baseUrl ?? (config.provider === "openai" ? "OpenAI" : "the configured Ollama server"))
    : undefined;
  const egress = where
    ? `Conversation text from this instance is sent to ${where} for embedding.`
    : "Retrieval runs on this instance and the answer is written by your own client's model, so no conversation text reaches a third party this instance configured.";

  const search = async (input: unknown) => {
    const options = searchObject.parse(input);
    if (!embeddings || !config) {
      return { isError: true as const, content: [{ type: "text" as const, text: "semantic_search needs an embedding model, and this instance has no MAGENTIC_LLM_PROVIDER configured. Use search_conversations, or ask_conversations, which works without one." }] };
    }
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

  // Only with a provider. There is no protocol request for "vectorise this",
  // so sampling cannot stand in for an embedding model.
  if (embeddings && config) server.registerTool(
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

  const ask = async (input: unknown) => {
    const options = askObject.parse(input);

    const chosen = await chooseChatModel(server, chatModel);
    if (!chosen) {
      return { isError: true as const, content: [{ type: "text" as const, text: "This instance has no language model available: your client does not offer sampling and no MAGENTIC_LLM_PROVIDER is configured." }] };
    }

    // Embeddings when an operator paid for them, the relay's own index when
    // not. Both produce the same shape, and the caption says which ran.
    const limit = Math.min(options.limit, shape.maxChunks);
    const result = embeddings && config
      ? await retrieve(
          { client, config, embeddings: await embeddings(), cache } satisfies RetrievalDeps,
          {
            query: options.question,
            limit,
            minScore: options.minScore,
            perConversation: options.perConversation,
            recent: options.recent,
            ...(options.conversationIds ? { conversationIds: options.conversationIds } : {}),
          },
        )
      : await retrieveLexically(client, shape, {
          query: options.question,
          limit,
          perConversation: options.perConversation,
          ...(options.conversationIds ? { conversationIds: options.conversationIds } : {}),
        });
    const retrievalTier: RetrievalTier = embeddings && config ? "semantic" : "lexical";

    if (result.chunks.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No stored conversation matched this question. ${describeTiers(retrievalTier, chosen.tier)}` }],
        structuredContent: {
          question: options.question, answer: null, sources: [],
          usage: { ...result.usage, retrieval: retrievalTier, model: chosen.tier },
        },
      };
    }

    const packed = packSources(result.chunks, shape.maxContextChars);
    const response = await chosen.model.invoke(groundedPrompt(options.question, packed.text));
    const answer = textOf(response.content).trim();

    return {
      content: [{
        type: "text" as const,
        text: `${answerToMarkdown(answer, packed.sources)}\n\n${describeTiers(retrievalTier, chosen.tier)}`,
      }],
      structuredContent: {
        question: options.question,
        answer,
        sources: packed.sources.map(toMatch),
        usage: {
          ...result.usage,
          contextChars: packed.usedChars,
          retrieval: retrievalTier,
          model: chosen.tier,
        },
      },
    };
  };

  const askConfig = {
    title: "Answer a question from stored conversations",
    description:
      "Answers a question using only the stored conversations, with a numbered citation on every "
      + "claim, and says so plainly when the conversations do not contain the answer. Use it for "
      + "questions that span conversations, such as what was decided about a subject or what is "
      + "still open. This does not store the answer; save it as a conversation if it should be kept. "
      + egress,
    inputSchema: askSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  };

  // Always registered, which is a deliberate exception to the rule the write
  // tools follow.
  //
  // Those are hidden when the operator turned them off, because that is
  // knowable before a client connects and a model should not plan around a
  // tool it can never have. Whether this one works depends on the *client*
  // offering its model, and that is only known after initialize. Registering
  // the first tool that late cannot work: capabilities are negotiated during
  // initialize, so a server that declared no tools then has no tools
  // capability to add one to.
  //
  // So it is visible, and when there is no model it says exactly which of
  // the two things to fix. Most clients do offer sampling, and hiding the
  // feature from all of them to spare the few is the worse trade.
  server.registerTool("ask_conversations", askConfig, ask);
}

/** Which retrieval path found the sources. */
type RetrievalTier = "semantic" | "lexical";

/**
 * Printed with every answer. Someone reading a thin result deserves to know
 * whether it was retrieved by meaning or by keyword, and whose model wrote
 * it, without opening a log.
 */
function describeTiers(retrieval: RetrievalTier, model: ModelTier): string {
  const found = retrieval === "semantic"
    ? "Retrieved by meaning."
    : "Retrieved by keyword, because this instance has no embedding model configured.";
  const wrote = model === "sampling"
    ? "Answered by your own client's model."
    : "Answered by the model this instance is configured with.";
  return `${found} ${wrote}`;
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
