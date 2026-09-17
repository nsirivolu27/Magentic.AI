/**
 * A language model the adapter can use, without the adapter depending on one.
 *
 * LangChain is an optional integration here, not a dependency. Three rules
 * make that true rather than aspirational:
 *
 *   1. Nothing in this repository imports a @langchain package at the top
 *      level. The imports below are dynamic and their specifiers are
 *      variables, which means neither TypeScript nor esbuild resolves them.
 *      The adapter typechecks, tests, bundles and runs with none of these
 *      packages installed.
 *   2. The rest of the code depends on the two interfaces below, not on
 *      LangChain's classes. Anything with these two methods works, which is
 *      how the tests run a whole retrieval path with no network.
 *   3. Nothing loads until a tool that needs it is actually called. An MCP
 *      client spawns this adapter as a subprocess for every session, so
 *      startup cost is paid on every session, and an integration nobody used
 *      should cost nothing.
 *
 * The provider is also the reason the LLM tools are off by default. Embedding
 * a conversation means sending it somewhere. On a relay whose whole premise is
 * that conversations stay on the instance that holds them, that has to be a
 * decision the operator makes out loud, which is what LNKZ_LLM_PROVIDER is.
 */

/** The shape LangChain's Embeddings classes already have. */
export interface EmbeddingsLike {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** The shape LangChain's chat models already have, narrowed to what we call. */
export interface ChatModelLike {
  invoke(input: string): Promise<{ content: unknown }>;
}

export type LlmProviderId = "openai" | "ollama";

export interface LlmConfig {
  provider: LlmProviderId;
  chatModel: string;
  embeddingModel: string;
  /** Base URL for Ollama, or for an OpenAI-compatible server that is not OpenAI. */
  baseUrl?: string;
  /** Conversations pulled from the relay to rank. The cost ceiling for one query. */
  maxConversations: number;
  /** Chunks kept after ranking and, for ask_conversations, put in front of the model. */
  maxChunks: number;
  /** Characters per chunk before the next message starts a new one. */
  chunkChars: number;
  /** Texts per embedDocuments call. */
  batchSize: number;
  /** Hard ceiling on the grounding text handed to the chat model. */
  maxContextChars: number;
  /** Cached embedding vectors held in this process. */
  cacheSize: number;
}

const DEFAULTS = {
  openai: { chatModel: "gpt-4o-mini", embeddingModel: "text-embedding-3-small" },
  ollama: { chatModel: "llama3.1", embeddingModel: "nomic-embed-text" },
} as const satisfies Record<LlmProviderId, { chatModel: string; embeddingModel: string }>;

/**
 * Read the integration's configuration, or undefined when the operator has
 * not turned it on. Undefined is the normal case and is not an error.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
  const declared = (env.LNKZ_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!declared) return undefined;
  if (declared !== "openai" && declared !== "ollama") {
    throw new Error("LNKZ_LLM_PROVIDER must be openai or ollama.");
  }
  const provider: LlmProviderId = declared;
  const defaults = DEFAULTS[provider];
  const baseUrl = env.LNKZ_LLM_BASE_URL?.trim();
  if (baseUrl) assertPlainHttpUrl(baseUrl);
  return {
    provider,
    chatModel: env.LNKZ_LLM_CHAT_MODEL?.trim() || defaults.chatModel,
    embeddingModel: env.LNKZ_LLM_EMBEDDING_MODEL?.trim() || defaults.embeddingModel,
    // exactOptionalPropertyTypes: an absent base URL is an absent key, not an
    // explicit undefined.
    ...(baseUrl ? { baseUrl } : {}),
    maxConversations: bounded(env.LNKZ_LLM_MAX_CONVERSATIONS, 40, 1, 500),
    maxChunks: bounded(env.LNKZ_LLM_MAX_CHUNKS, 12, 1, 100),
    chunkChars: bounded(env.LNKZ_LLM_CHUNK_CHARS, 1_600, 200, 20_000),
    batchSize: bounded(env.LNKZ_LLM_BATCH_SIZE, 64, 1, 512),
    maxContextChars: bounded(env.LNKZ_LLM_MAX_CONTEXT_CHARS, 24_000, 500, 400_000),
    cacheSize: bounded(env.LNKZ_LLM_CACHE_SIZE, 4_000, 0, 200_000),
  };
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function assertPlainHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LNKZ_LLM_BASE_URL must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LNKZ_LLM_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("LNKZ_LLM_BASE_URL must not contain credentials; use the provider's key variable.");
  }
}

/**
 * Import a package that may not be installed.
 *
 * The specifier arrives as a parameter rather than a literal so that no build
 * step tries to resolve it. That is load-bearing: a literal here would make
 * esbuild fail the bundle on a machine that never wanted the integration.
 */
async function loadOptional(specifier: string, install: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `${specifier} is not installed, and LNKZ_LLM_PROVIDER asks for it. Install it with: pnpm add ${install}`,
      { cause },
    );
  }
}

function construct<T>(module: Record<string, unknown>, exportName: string, args: Record<string, unknown>): T {
  const Ctor = module[exportName];
  if (typeof Ctor !== "function") {
    throw new Error(`${exportName} was not found in the installed package; the integration expects a newer version.`);
  }
  return new (Ctor as new (args: Record<string, unknown>) => T)(args);
}

/** Loaded once per process, because constructing a client per query is waste. */
let embeddingsOnce: Promise<EmbeddingsLike> | undefined;
let chatOnce: Promise<ChatModelLike> | undefined;

/** Drop the memoized clients. Only tests need this. */
export function resetLoadedModels(): void {
  embeddingsOnce = undefined;
  chatOnce = undefined;
}

export function loadEmbeddings(config: LlmConfig): Promise<EmbeddingsLike> {
  embeddingsOnce ??= buildEmbeddings(config);
  return embeddingsOnce;
}

export function loadChatModel(config: LlmConfig): Promise<ChatModelLike> {
  chatOnce ??= buildChatModel(config);
  return chatOnce;
}

async function buildEmbeddings(config: LlmConfig): Promise<EmbeddingsLike> {
  if (config.provider === "ollama") {
    const module = await loadOptional("@langchain/ollama", "@langchain/ollama");
    return construct<EmbeddingsLike>(module, "OllamaEmbeddings", {
      model: config.embeddingModel,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }
  const module = await loadOptional("@langchain/openai", "@langchain/openai");
  return construct<EmbeddingsLike>(module, "OpenAIEmbeddings", {
    model: config.embeddingModel,
    apiKey: requireOpenAiKey(),
    // One request per batch instead of one per chunk. LangChain's default
    // already batches; naming it keeps it aligned with our own batch size so
    // the two layers do not disagree about what a batch is.
    batchSize: config.batchSize,
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
  });
}

async function buildChatModel(config: LlmConfig): Promise<ChatModelLike> {
  if (config.provider === "ollama") {
    const module = await loadOptional("@langchain/ollama", "@langchain/ollama");
    return construct<ChatModelLike>(module, "ChatOllama", {
      model: config.chatModel,
      temperature: 0,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }
  const module = await loadOptional("@langchain/openai", "@langchain/openai");
  return construct<ChatModelLike>(module, "ChatOpenAI", {
    model: config.chatModel,
    // Grounded answering over someone's own conversations is a task with a
    // right answer. Sampling would only add ways to get it wrong.
    temperature: 0,
    apiKey: requireOpenAiKey(),
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
  });
}

function requireOpenAiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required when LNKZ_LLM_PROVIDER is openai.");
  return key;
}
