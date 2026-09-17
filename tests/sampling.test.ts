import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LnkzClientLike } from "../client.js";
import type { Conversation } from "../contract.js";
import { retrieveLexically } from "../llm/corpus.js";
import { lexicalOverlap } from "../llm/chunk.js";
import { registerLlmTools } from "../llm/tools.js";

const now = "2026-01-01T00:00:00.000Z";

function conversationOf(id: string, title: string, lines: string[]): Conversation {
  return {
    id, version: 1, title,
    source: { provider: "chatgpt" },
    participants: ["Nihal"], tags: [],
    messages: lines.map((content, index) => ({
      id: `${id}-m${index}`, role: index % 2 === 0 ? "user" : "assistant", content, createdAt: now,
    })),
    createdAt: now, updatedAt: now,
  };
}

const STORAGE = conversationOf("11111111-1111-4111-8111-111111111111", "Storage choice", [
  "Should we run sqlite or postgres for the relay?",
  "Postgres for the hosted instance, sqlite for a personal one.",
]);
const DEPLOY = conversationOf("22222222-2222-4222-8222-222222222222", "Deploy target", [
  "Where does the adapter deploy?",
  "Fly, and we deploy on monday.",
]);

function relayClient(corpus: readonly Conversation[], counts = { search: 0, get: 0 }): LnkzClientLike {
  return {
    searchConversations: async (input: unknown) => {
      counts.search += 1;
      const query = String((input as { query: string }).query).toLowerCase();
      const terms = query.split(/\s+/).filter((term) => term.length > 3);
      return {
        matches: corpus
          .filter((entry) => entry.messages.some((message) => terms.some((term) => message.content.toLowerCase().includes(term))))
          .map((entry) => ({ ...entry, messageCount: entry.messages.length, relevance: 0.8, snippet: "" })),
      };
    },
    listConversations: async () => ({ conversations: corpus.map((entry) => ({ ...entry, messageCount: entry.messages.length })) }),
    getConversation: async (id: string) => {
      counts.get += 1;
      const hit = corpus.find((entry) => entry.id === id);
      if (!hit) throw new Error("not found");
      return { conversation: hit, analysis: undefined as never };
    },
  } as unknown as LnkzClientLike;
}

/** A client that offers its model, and records what the server asked it. */
async function connectSampling(server: McpServer, reply: string, seen: { prompts: string[]; params: unknown[] }) {
  const client = new Client({ name: "sampling-test", version: "1.0.0" }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    seen.params.push(request.params);
    const first = request.params.messages[0]?.content;
    const asText = !first || Array.isArray(first) ? "" : first.type === "text" ? first.text : "";
    seen.prompts.push(asText);
    return { role: "assistant", model: "client-model", content: { type: "text", text: reply } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** A client that does not. */
async function connectPlain(server: McpServer) {
  const client = new Client({ name: "plain-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// ------------------------------------------------------------------ lexical retrieval

test("retrieval works with no embedding model at all", async () => {
  const result = await retrieveLexically(
    relayClient([STORAGE, DEPLOY]),
    { chunkChars: 1_600, maxConversations: 40 },
    { query: "postgres", limit: 5, perConversation: 3 },
  );
  assert.equal(result.chunks[0]?.conversationId, STORAGE.id);
  assert.equal(result.usage.embedded, 0, "nothing was sent to an embedding model");
  assert.equal(result.usage.batches, 0);
});

test("term overlap is a share of the query's distinct terms", () => {
  assert.equal(lexicalOverlap("postgres sqlite", "we chose postgres"), 0.5);
  assert.equal(lexicalOverlap("postgres", "we chose postgres"), 1);
  assert.equal(lexicalOverlap("a of to", "anything"), 0, "short words are not terms");
  assert.equal(lexicalOverlap("", "anything"), 0);
});

test("a relay that cannot search yields nothing rather than throwing", async () => {
  const broken = { searchConversations: async () => { throw new Error("down"); } } as unknown as LnkzClientLike;
  const result = await retrieveLexically(broken, { chunkChars: 1_600, maxConversations: 40 }, { query: "x", limit: 5, perConversation: 3 });
  assert.deepEqual(result.chunks, []);
});

// ------------------------------------------------------------------ the sampling tier

test("with no provider and no sampling, the tool is visible and says which of the two to fix", async (t) => {
  // Unlike the write tools, this one cannot be gated at construction:
  // whether it works depends on the connecting client, and a server that
  // declared no tools during initialize cannot add one afterwards.
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), undefined);
  const { client, close } = await connectPlain(server);
  t.after(close);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names, ["ask_conversations"]);
  assert.equal(names.includes("semantic_search"), false, "that one is gated on the operator, which is knowable up front");

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "anything" } });
  assert.equal(result.isError, true);
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  assert.match(text, /does not offer sampling/);
  assert.match(text, /LNKZ_LLM_PROVIDER/);
});

test("a client that offers its model gets ask_conversations, and semantic_search stays absent", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE, DEPLOY]), undefined);
  const seen = { prompts: [] as string[], params: [] as unknown[] };
  const { client, close } = await connectSampling(server, "unused", seen);
  t.after(close);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names, ["ask_conversations"]);
  assert.equal(names.includes("semantic_search"), false, "sampling cannot stand in for an embedding model");
});

test("the whole path runs with nothing installed and nothing configured", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE, DEPLOY]), undefined);
  const seen = { prompts: [] as string[], params: [] as unknown[] };
  const { client, close } = await connectSampling(server, "Postgres for hosted, sqlite for personal [1].", seen);
  t.after(close);

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "which database did we pick for postgres" } });
  const structured = result.structuredContent as {
    answer: string; sources: { conversationId: string }[];
    usage: { retrieval: string; model: string; embedded: number };
  };

  assert.match(structured.answer, /Postgres for hosted/);
  assert.equal(structured.sources[0]?.conversationId, STORAGE.id);
  assert.equal(structured.usage.retrieval, "lexical");
  assert.equal(structured.usage.model, "sampling");
  assert.equal(structured.usage.embedded, 0);
});

test("the answer says which tiers produced it, so a thin result explains itself", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), undefined);
  const seen = { prompts: [] as string[], params: [] as unknown[] };
  const { client, close } = await connectSampling(server, "An answer [1].", seen);
  t.after(close);

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "postgres" } });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.match(text, /Retrieved by keyword/);
  assert.match(text, /no embedding model configured/);
  assert.match(text, /Answered by your own client's model/);
});

test("the sampling request carries the grounded prompt and does not sample creatively", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), undefined);
  const seen = { prompts: [] as string[], params: [] as unknown[] };
  const { client, close } = await connectSampling(server, "ok", seen);
  t.after(close);

  await client.callTool({ name: "ask_conversations", arguments: { question: "postgres" } });
  const prompt = seen.prompts[0] ?? "";
  assert.match(prompt, /using only the numbered sources/);
  assert.match(prompt, /do not answer from general knowledge/);
  assert.match(prompt, /Postgres for the hosted instance/, "the relay's own text reached the model");

  const params = seen.params[0] as { temperature?: number; includeContext?: string; maxTokens?: number };
  assert.equal(params.temperature, 0, "a grounded reading has a right answer");
  assert.equal(params.includeContext, "none", "the server is not asking the client to go and use its own context");
  assert.ok((params.maxTokens ?? 0) > 0);
});

test("sampling is preferred over a configured provider", async (t) => {
  let providerCalls = 0;
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), {
    config: {
      provider: "ollama", chatModel: "c", embeddingModel: "e",
      maxConversations: 40, maxChunks: 12, chunkChars: 1_600,
      batchSize: 64, maxContextChars: 24_000, cacheSize: 100,
    },
    embeddings: async () => ({
      embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
      embedQuery: async () => [1, 0],
    }),
    chatModel: async () => { providerCalls += 1; return { invoke: async () => ({ content: "from the provider" }) }; },
  });
  const seen = { prompts: [] as string[], params: [] as unknown[] };
  const { client, close } = await connectSampling(server, "from sampling [1].", seen);
  t.after(close);

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "postgres", minScore: 0 } });
  const structured = result.structuredContent as { answer: string; usage: { model: string; retrieval: string } };
  assert.equal(structured.usage.model, "sampling", "the person's own model is the one they chose");
  assert.equal(structured.usage.retrieval, "semantic", "a configured embedding model is still used for retrieval");
  assert.match(structured.answer, /from sampling/);
  assert.equal(providerCalls, 0, "the configured provider was never constructed");
});

test("a client that returns something other than text yields an empty answer, not a stringified object", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), undefined);
  const client = new Client({ name: "odd", version: "1.0.0" }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    role: "assistant", model: "m", content: { type: "image", data: "AAAA", mimeType: "image/png" },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "postgres" } });
  const structured = result.structuredContent as { answer: string };
  assert.equal(structured.answer, "");
});

test("a client that refuses to sample surfaces the refusal rather than inventing an answer", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, relayClient([STORAGE]), undefined);
  const client = new Client({ name: "refuser", version: "1.0.0" }, { capabilities: { sampling: {} } });
  client.setRequestHandler(CreateMessageRequestSchema, async () => { throw new Error("user declined sampling"); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({ name: "ask_conversations", arguments: { question: "postgres" } });
  assert.equal(result.isError, true);
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  assert.match(text, /declined/i);
});
