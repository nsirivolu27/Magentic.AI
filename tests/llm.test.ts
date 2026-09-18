import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LnkzClientLike } from "../client.js";
import type { Conversation } from "../contract.js";
import { EmbeddingCache } from "../llm/cache.js";
import { chunkConversation, cosineSimilarity, rankChunks } from "../llm/chunk.js";
import { packSources, retrieve } from "../llm/corpus.js";
import { llmConfigFromEnv, type ChatModelLike, type EmbeddingsLike, type LlmConfig } from "../llm/provider.js";
import { registerLlmTools } from "../llm/tools.js";

const now = "2026-01-01T00:00:00.000Z";

/**
 * A deterministic stand-in for an embedding model: a bag of words over a
 * fixed vocabulary. It is not a good embedding, but it has the two
 * properties the retrieval code depends on, which are that similar text
 * scores higher and that the same text always produces the same vector. That
 * is enough to test every line of the path without a network, a key or a
 * package.
 */
const VOCABULARY = ["postgres", "sqlite", "deploy", "fly", "handoff", "redact", "budget", "monday"];

class CountingEmbeddings implements EmbeddingsLike {
  documentCalls = 0;
  documentsEmbedded = 0;
  queryCalls = 0;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.documentCalls += 1;
    this.documentsEmbedded += texts.length;
    return texts.map((text) => vectorize(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    this.queryCalls += 1;
    return vectorize(text);
  }
}

function vectorize(text: string): number[] {
  const lowered = text.toLowerCase();
  return VOCABULARY.map((term) => (lowered.split(term).length - 1));
}

class EchoChatModel implements ChatModelLike {
  prompts: string[] = [];
  constructor(private readonly reply: string) {}
  async invoke(input: string): Promise<{ content: unknown }> {
    this.prompts.push(input);
    return { content: this.reply };
  }
}

function conversationOf(id: string, title: string, lines: string[]): Conversation {
  return {
    id,
    version: 1,
    title,
    source: { provider: "chatgpt" },
    participants: ["Nihal"],
    tags: [],
    messages: lines.map((content, index) => ({
      id: `${id}-m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content,
      createdAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

const storeConversation = conversationOf("11111111-1111-4111-8111-111111111111", "Storage choice", [
  "Should we run sqlite or postgres for the relay?",
  "Postgres for the hosted instance, sqlite for a personal one.",
]);
const deployConversation = conversationOf("22222222-2222-4222-8222-222222222222", "Deploy target", [
  "Where does the adapter deploy?",
  "Fly, and we deploy on monday.",
]);

/** Only the four methods retrieval touches; the rest would be dead weight. */
function retrievalClient(corpus: readonly Conversation[], counts = { search: 0, list: 0, get: 0 }): LnkzClientLike {
  const partial = {
    searchConversations: async (input: unknown) => {
      counts.search += 1;
      const query = String((input as { query: string }).query).toLowerCase();
      return {
        matches: corpus
          .filter((entry) => entry.messages.some((message) => query.split(/\s+/).some((word) => word.length > 3 && message.content.toLowerCase().includes(word))))
          .map((entry) => ({ ...entry, messageCount: entry.messages.length, relevance: 1, snippet: "" })),
      };
    },
    listConversations: async () => {
      counts.list += 1;
      return { conversations: corpus.map((entry) => ({ ...entry, messageCount: entry.messages.length })) };
    },
    getConversation: async (id: string) => {
      counts.get += 1;
      const found = corpus.find((entry) => entry.id === id);
      if (!found) throw new Error("not found");
      return { conversation: found, analysis: undefined as never };
    },
  };
  return partial as unknown as LnkzClientLike;
}

function configOf(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "ollama",
    chatModel: "test-chat",
    embeddingModel: "test-embed",
    maxConversations: 40,
    maxChunks: 12,
    chunkChars: 1_600,
    batchSize: 64,
    maxContextChars: 24_000,
    cacheSize: 1_000,
    ...overrides,
  };
}

// ------------------------------------------------------------------ configuration

test("the integration is off unless an operator names a provider", () => {
  assert.equal(llmConfigFromEnv({}), undefined);
  assert.equal(llmConfigFromEnv({ MAGENTIC_LLM_PROVIDER: "   " }), undefined);
  assert.throws(() => llmConfigFromEnv({ MAGENTIC_LLM_PROVIDER: "anthropic" }), /openai or ollama/);
});

test("numeric settings are clamped rather than trusted", () => {
  const config = llmConfigFromEnv({
    MAGENTIC_LLM_PROVIDER: "openai",
    MAGENTIC_LLM_MAX_CONVERSATIONS: "100000",
    MAGENTIC_LLM_BATCH_SIZE: "0",
    MAGENTIC_LLM_CHUNK_CHARS: "not a number",
  });
  assert.ok(config);
  assert.equal(config.maxConversations, 500);
  assert.equal(config.batchSize, 1);
  assert.equal(config.chunkChars, 1_600);
  assert.equal(config.embeddingModel, "text-embedding-3-small");
});

test("a base URL carrying credentials is refused", () => {
  assert.throws(
    () => llmConfigFromEnv({ MAGENTIC_LLM_PROVIDER: "ollama", MAGENTIC_LLM_BASE_URL: "http://user:pass@host:11434" }),
    /must not contain credentials/,
  );
});

// ------------------------------------------------------------------ chunking

test("chunks are whole messages and carry the ids they came from", () => {
  const chunks = chunkConversation(storeConversation, 1_600);
  assert.equal(chunks.length, 1);
  const first = chunks[0];
  assert.ok(first);
  assert.deepEqual(first.messageIds, ["11111111-1111-4111-8111-111111111111-m0", "11111111-1111-4111-8111-111111111111-m1"]);
  assert.match(first.text, /^user: Should we run sqlite/);
});

test("a chunk boundary overlaps by one message so a question keeps its answer", () => {
  const long = conversationOf("33333333-3333-4333-8333-333333333333", "Long", [
    "a".repeat(120),
    "b".repeat(120),
    "c".repeat(120),
  ]);
  const chunks = chunkConversation(long, 200);
  assert.ok(chunks.length >= 2);
  const [first, second] = chunks;
  assert.ok(first && second);
  const carried = first.messageIds[first.messageIds.length - 1];
  assert.ok(carried);
  assert.ok(second.messageIds.includes(carried), "the last message of one chunk opens the next");
});

test("cosine similarity ranks the closer text higher", () => {
  const query = vectorize("postgres");
  assert.ok(cosineSimilarity(query, vectorize("we chose postgres")) > cosineSimilarity(query, vectorize("we deploy on fly")));
});

test("ranking will not let one conversation fill every slot", () => {
  const entries = [0, 1, 2, 3].map((index) => ({
    chunk: { conversationId: "same", title: "T", index, messageIds: [`m${index}`], text: "postgres" },
    vector: vectorize("postgres"),
  }));
  const kept = rankChunks(vectorize("postgres"), entries, { limit: 4, minScore: 0, perConversation: 2 });
  assert.equal(kept.length, 2);
});

// ------------------------------------------------------------------ cache

test("the cache is keyed by model, so switching models does not mix vectors", () => {
  assert.notEqual(EmbeddingCache.key("model-a", "text"), EmbeddingCache.key("model-b", "text"));
  assert.equal(EmbeddingCache.key("model-a", "text"), EmbeddingCache.key("model-a", "text"));
});

test("the cache evicts the least recently used entry", () => {
  const cache = new EmbeddingCache(2);
  cache.set("a", [1]);
  cache.set("b", [2]);
  cache.get("a");
  cache.set("c", [3]);
  assert.ok(cache.get("a"), "a was read most recently and survives");
  assert.equal(cache.get("b"), undefined, "b was coldest and was evicted");
  assert.equal(cache.stats.size, 2);
});

test("a cache size of zero disables caching without breaking reads", () => {
  const cache = new EmbeddingCache(0);
  cache.set("a", [1]);
  assert.equal(cache.get("a"), undefined);
});

// ------------------------------------------------------------------ retrieval

test("retrieval finds the conversation that answers the question", async () => {
  const embeddings = new CountingEmbeddings();
  const cache = new EmbeddingCache(100);
  const config = configOf();
  const result = await retrieve(
    { client: retrievalClient([storeConversation, deployConversation]), config, embeddings, cache },
    { query: "postgres", limit: 5, minScore: 0.01, perConversation: 3, recent: 25 },
  );
  const top = result.chunks[0];
  assert.ok(top);
  assert.equal(top.conversationId, storeConversation.id);
  assert.equal(result.usage.embedded, 2);
  assert.equal(result.usage.cached, 0);
});

test("a repeated query embeds nothing, which is the point of the cache", async () => {
  const embeddings = new CountingEmbeddings();
  const cache = new EmbeddingCache(100);
  const config = configOf();
  const deps = { client: retrievalClient([storeConversation, deployConversation]), config, embeddings, cache };
  const request = { query: "postgres", limit: 5, minScore: 0.01, perConversation: 3, recent: 25 };

  await retrieve(deps, request);
  const firstPass = embeddings.documentsEmbedded;
  const second = await retrieve(deps, request);

  assert.equal(embeddings.documentsEmbedded, firstPass, "no chunk was sent to the model twice");
  assert.equal(embeddings.queryCalls, 1, "the query vector was cached too");
  assert.equal(second.usage.embedded, 0);
  assert.equal(second.usage.cached, second.usage.chunks);
});

test("embedding is batched to the configured size", async () => {
  const embeddings = new CountingEmbeddings();
  const many = Array.from({ length: 6 }, (_, index) =>
    conversationOf(`4444444${index}-4444-4444-8444-444444444444`, `C${index}`, [`postgres ${index}`]),
  );
  const result = await retrieve(
    { client: retrievalClient(many), config: configOf({ batchSize: 2 }), embeddings, cache: new EmbeddingCache(100) },
    { query: "postgres", limit: 10, minScore: 0, perConversation: 3, recent: 25 },
  );
  assert.equal(result.usage.chunks, 6);
  assert.equal(embeddings.documentCalls, 3, "six chunks at a batch size of two is three requests");
  assert.equal(result.usage.batches, 3);
});

test("identical text across two conversations is embedded once", async () => {
  const embeddings = new CountingEmbeddings();
  const copied = conversationOf("55555555-5555-4555-8555-555555555555", "Storage choice", [
    "Should we run sqlite or postgres for the relay?",
    "Postgres for the hosted instance, sqlite for a personal one.",
  ]);
  // Same text, different conversation: exactly what a handoff produces.
  const result = await retrieve(
    { client: retrievalClient([storeConversation, copied]), config: configOf(), embeddings, cache: new EmbeddingCache(100) },
    { query: "postgres", limit: 5, minScore: 0, perConversation: 3, recent: 25 },
  );
  assert.equal(result.usage.chunks, 2);
  assert.equal(embeddings.documentsEmbedded, 1, "the duplicate was deduplicated before the request");
  assert.equal(result.chunks.length, 2, "both chunks still rank, each against its own conversation");
});

test("an unreadable conversation narrows the answer instead of failing it", async () => {
  const client = retrievalClient([storeConversation, deployConversation]);
  const guarded = {
    ...client,
    getConversation: async (id: string) => {
      if (id === deployConversation.id) throw new Error("forbidden");
      return client.getConversation(id);
    },
  } as unknown as LnkzClientLike;
  const result = await retrieve(
    { client: guarded, config: configOf(), embeddings: new CountingEmbeddings(), cache: new EmbeddingCache(10) },
    { query: "postgres", limit: 5, minScore: 0, perConversation: 3, recent: 25 },
  );
  assert.equal(result.usage.conversationsRead, 1);
  assert.equal(result.usage.candidates, 2);
});

test("naming conversations skips candidate selection entirely", async () => {
  const counts = { search: 0, list: 0, get: 0 };
  const client = retrievalClient([storeConversation, deployConversation], counts);
  await retrieve(
    { client, config: configOf(), embeddings: new CountingEmbeddings(), cache: new EmbeddingCache(10) },
    { query: "postgres", limit: 5, minScore: 0, perConversation: 3, recent: 25, conversationIds: [deployConversation.id] },
  );
  assert.equal(counts.search, 0);
  assert.equal(counts.list, 0);
  assert.equal(counts.get, 1);
});

// ------------------------------------------------------------------ context budget

test("grounding text stops at the ceiling rather than being truncated in the middle", () => {
  const chunks = [0, 1, 2].map((index) => ({
    conversationId: `c${index}`,
    title: "T",
    index,
    messageIds: [`m${index}`],
    text: "x".repeat(400),
    score: 1 - index / 10,
  }));
  const packed = packSources(chunks, 900);
  assert.equal(packed.sources.length, 2, "the third would have crossed the ceiling");
  assert.ok(packed.usedChars <= 900);
  assert.ok(packed.text.includes("[1]") && packed.text.includes("[2]"));
});

test("one oversized chunk is still packed, so a long answer is not silently dropped", () => {
  const packed = packSources(
    [{ conversationId: "c", title: "T", index: 0, messageIds: ["m"], text: "y".repeat(5_000), score: 1 }],
    100,
  );
  assert.equal(packed.sources.length, 1);
  assert.equal(packed.text.length, 100);
});

// ------------------------------------------------------------------ tools

async function connect(server: McpServer) {
  const client = new Client({ name: "lnkz-llm-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("no provider means no semantic_search, because an operator decides that one", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  // A marker tool so the server still advertises a tools capability. Without
  // one, listTools would fail as unimplemented and the test would pass for
  // the wrong reason.
  server.registerTool("marker", { description: "marker", inputSchema: {} }, async () => ({ content: [] }));
  registerLlmTools(server, retrievalClient([storeConversation]), undefined);
  const { client, close } = await connect(server);
  t.after(close);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  // Embeddings need a provider and there is no protocol request for them, so
  // this one is genuinely unavailable and stays hidden. ask_conversations can
  // still run on the client's own model, so it is offered; sampling.test.ts
  // covers what it does when the client cannot.
  assert.deepEqual(names, ["ask_conversations", "marker"]);
  assert.equal(names.includes("semantic_search"), false);
});

test("a configured provider exposes exactly the two read tools", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, retrievalClient([storeConversation]), {
    config: configOf(),
    embeddings: async () => new CountingEmbeddings(),
    chatModel: async () => new EchoChatModel("unused"),
  });
  const { client, close } = await connect(server);
  t.after(close);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ask_conversations", "semantic_search"]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.ok(tools.every((tool) => /sent to/.test(tool.description ?? "")), "each tool says where the text goes");
});

test("semantic_search returns the matching conversation with its message ids", async (t) => {
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, retrievalClient([storeConversation, deployConversation]), {
    config: configOf(),
    embeddings: async () => new CountingEmbeddings(),
    chatModel: async () => new EchoChatModel("unused"),
  });
  const { client, close } = await connect(server);
  t.after(close);

  const result = await client.callTool({ name: "semantic_search", arguments: { query: "postgres", minScore: 0.01 } });
  const structured = result.structuredContent as { matches: { conversationId: string; messageIds: string[] }[] };
  const top = structured.matches[0];
  assert.ok(top);
  assert.equal(top.conversationId, storeConversation.id);
  assert.ok(top.messageIds.length > 0);
});

test("ask_conversations grounds the prompt and reports its sources", async (t) => {
  const chat = new EchoChatModel("Postgres for hosted, sqlite for personal [1].");
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, retrievalClient([storeConversation, deployConversation]), {
    config: configOf(),
    embeddings: async () => new CountingEmbeddings(),
    chatModel: async () => chat,
  });
  const { client, close } = await connect(server);
  t.after(close);

  const result = await client.callTool({
    name: "ask_conversations",
    arguments: { question: "which postgres database did we pick", minScore: 0.01 },
  });
  const structured = result.structuredContent as { answer: string; sources: { conversationId: string }[] };
  assert.match(structured.answer, /Postgres for hosted/);
  assert.ok(structured.sources.length > 0);

  const prompt = chat.prompts[0];
  assert.ok(prompt);
  assert.match(prompt, /using only the numbered sources/);
  assert.match(prompt, /do not answer from general knowledge/);
  assert.ok(prompt.indexOf("Sources:") < prompt.indexOf("Question:"), "the refusal instruction precedes the sources");
  assert.match(prompt, /Postgres for the hosted instance/);
});

test("ask_conversations says nothing matched rather than answering from the model", async (t) => {
  const chat = new EchoChatModel("should never be called");
  const server = new McpServer({ name: "lnkz", version: "test" });
  registerLlmTools(server, retrievalClient([storeConversation]), {
    config: configOf(),
    embeddings: async () => new CountingEmbeddings(),
    chatModel: async () => chat,
  });
  const { client, close } = await connect(server);
  t.after(close);

  const result = await client.callTool({
    name: "ask_conversations",
    arguments: { question: "what is the capital of France", minScore: 0.99 },
  });
  const structured = result.structuredContent as { answer: string | null; sources: unknown[] };
  assert.equal(structured.answer, null);
  assert.deepEqual(structured.sources, []);
  assert.equal(chat.prompts.length, 0, "the chat model was never reached");
});

test("the real server picks the tools up through surfaces, and only when configured", async (t) => {
  const { createMagenticMcpServer } = await import("../mcp.js");
  const client = retrievalClient([storeConversation]);

  const withoutProvider = createMagenticMcpServer(client);
  const plain = await connect(withoutProvider);
  t.after(plain.close);
  const before = new Set((await plain.client.listTools()).tools.map((tool) => tool.name));
  assert.equal(before.has("semantic_search"), false, "embeddings need a provider, so this one waits for one");
  assert.equal(before.has("ask_conversations"), true, "this one can run on the client's model, so it is always offered");

  // Registration only reads configuration; the provider package is not
  // imported until a tool is called, so this needs nothing installed.
  const previous = process.env.MAGENTIC_LLM_PROVIDER;
  process.env.MAGENTIC_LLM_PROVIDER = "ollama";
  t.after(() => {
    if (previous === undefined) delete process.env.MAGENTIC_LLM_PROVIDER;
    else process.env.MAGENTIC_LLM_PROVIDER = previous;
  });

  const withProvider = createMagenticMcpServer(client);
  const configured = await connect(withProvider);
  t.after(configured.close);
  const after = new Set((await configured.client.listTools()).tools.map((tool) => tool.name));
  assert.ok(after.has("semantic_search"));
  assert.ok(after.has("ask_conversations"));
  assert.equal(after.size, before.size + 1, "configuring a provider adds semantic_search and nothing else");
});
