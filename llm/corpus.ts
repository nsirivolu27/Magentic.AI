import type { Conversation } from "../contract.js";
import type { LnkzClientLike } from "../client.js";
import { EmbeddingCache } from "./cache.js";
import { chunkConversation, lexicalOverlap, rankChunks, thin, type Chunk, type ScoredChunk } from "./chunk.js";
import type { EmbeddingsLike, LlmConfig } from "./provider.js";

/**
 * Retrieval over the relay, in two stages.
 *
 * Stage one is the relay's own keyword search, which already exists and runs
 * against an index it maintains. Stage two is semantic ranking here, over the
 * conversations stage one surfaced.
 *
 * Doing only stage two would mean pulling and embedding the whole corpus to
 * answer one question, which is the mistake most retrieval bolt-ons make: it
 * costs money in proportion to how much someone has ever stored rather than
 * to how much of it is relevant, and it gets slower the longer they use the
 * product. Doing only stage one is what the relay already does, and it misses
 * anything phrased differently than it was stored.
 *
 * Together, keyword search supplies recall cheaply and embeddings supply
 * precision over a bounded set. Recent conversations join the candidate set
 * unconditionally, because the question "what did we just decide" contains
 * none of the words of the answer.
 */

export interface RetrievalDeps {
  client: LnkzClientLike;
  config: LlmConfig;
  embeddings: EmbeddingsLike;
  cache: EmbeddingCache;
}

export interface RetrievalRequest {
  query: string;
  limit: number;
  minScore: number;
  perConversation: number;
  /** Restrict to specific conversations, skipping candidate selection entirely. */
  conversationIds?: readonly string[];
  /** Recent conversations to consider alongside the keyword hits. */
  recent: number;
}

export interface RetrievalUsage {
  candidates: number;
  conversationsRead: number;
  chunks: number;
  /** Chunks that had to be sent to the embedding model. */
  embedded: number;
  /** Chunks answered from the in-process cache. */
  cached: number;
  batches: number;
}

export interface RetrievalResult {
  chunks: ScoredChunk[];
  usage: RetrievalUsage;
}

/** Parallel reads against the relay. Enough to hide latency, few enough to be a guest. */
const READ_CONCURRENCY = 6;

export async function retrieve(deps: RetrievalDeps, request: RetrievalRequest): Promise<RetrievalResult> {
  const candidateIds = request.conversationIds?.length
    ? [...new Set(request.conversationIds)].slice(0, deps.config.maxConversations)
    : await selectCandidates(deps, request);

  const conversations = await readConversations(deps.client, candidateIds);
  const chunks = conversations.flatMap((conversation) =>
    chunkConversation(conversation, deps.config.chunkChars),
  );

  // The query and the chunks are embedded concurrently. They are independent
  // requests and waiting for one before starting the other adds a round trip
  // to every query for no reason.
  const [{ vectors, usage }, queryVector] = await Promise.all([
    embedChunks(deps, chunks),
    embedQuery(deps, request.query),
  ]);

  const entries = chunks.flatMap((chunk, index) => {
    const vector = vectors[index];
    return vector ? [{ chunk, vector }] : [];
  });

  return {
    chunks: rankChunks(queryVector, entries, {
      limit: request.limit,
      minScore: request.minScore,
      perConversation: request.perConversation,
    }),
    usage: {
      candidates: candidateIds.length,
      conversationsRead: conversations.length,
      chunks: chunks.length,
      ...usage,
    },
  };
}

async function selectCandidates(deps: RetrievalDeps, request: RetrievalRequest): Promise<string[]> {
  const ceiling = deps.config.maxConversations;
  const [matches, listing] = await Promise.all([
    deps.client
      .searchConversations({ query: request.query, limit: Math.min(50, ceiling) })
      .catch(() => ({ matches: [] })),
    request.recent > 0
      ? deps.client.listConversations({ limit: Math.min(200, request.recent) }).catch(() => ({ conversations: [] }))
      : Promise.resolve({ conversations: [] }),
  ]);

  // Keyword hits first: they are the ones the relay already believes are
  // relevant, so if the ceiling cuts the list, recency is what goes.
  const ordered = [
    ...matches.matches.map((match) => match.id),
    ...listing.conversations.map((summary) => summary.id),
  ];
  return [...new Set(ordered)].slice(0, ceiling);
}

async function readConversations(client: LnkzClientLike, ids: readonly string[]): Promise<Conversation[]> {
  const found: Conversation[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      if (id === undefined) return;
      // One unreadable conversation should narrow an answer, not fail it.
      // The relay can legitimately refuse a row this key may not read.
      const result = await client.getConversation(id).catch(() => undefined);
      if (result) found.push(result.conversation);
    }
  });
  await Promise.all(workers);
  return found;
}

async function embedChunks(
  deps: RetrievalDeps,
  chunks: readonly Chunk[],
): Promise<{ vectors: (readonly number[] | undefined)[]; usage: Pick<RetrievalUsage, "embedded" | "cached" | "batches"> }> {
  const model = deps.config.embeddingModel;
  const vectors: (readonly number[] | undefined)[] = new Array(chunks.length).fill(undefined);
  const pending: { index: number; key: string; text: string }[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const key = EmbeddingCache.key(model, chunk.text);
    const cached = deps.cache.get(key);
    if (cached) vectors[index] = cached;
    else pending.push({ index, key, text: chunk.text });
  }

  // Identical text in two conversations is one embedding, not two. Duplicated
  // transcripts are the normal case on a relay whose point is copying
  // conversations between instances.
  const unique = new Map<string, { key: string; text: string; indexes: number[] }>();
  for (const entry of pending) {
    const existing = unique.get(entry.key);
    if (existing) existing.indexes.push(entry.index);
    else unique.set(entry.key, { key: entry.key, text: entry.text, indexes: [entry.index] });
  }

  const work = [...unique.values()];
  let batches = 0;
  for (let start = 0; start < work.length; start += deps.config.batchSize) {
    const batch = work.slice(start, start + deps.config.batchSize);
    const embedded = await deps.embeddings.embedDocuments(batch.map((entry) => entry.text));
    batches += 1;
    for (const [offset, entry] of batch.entries()) {
      const vector = embedded[offset];
      if (!vector) continue;
      deps.cache.set(entry.key, vector);
      for (const index of entry.indexes) vectors[index] = vector;
    }
  }

  return {
    vectors,
    usage: { embedded: work.length, cached: chunks.length - pending.length, batches },
  };
}

async function embedQuery(deps: RetrievalDeps, query: string): Promise<number[]> {
  // Queries are cached too. People repeat themselves, and a follow-up in the
  // same session is usually the same question with one word changed.
  const key = EmbeddingCache.key(`${deps.config.embeddingModel}::query`, query);
  const cached = deps.cache.get(key);
  if (cached) return [...cached];
  const vector = await deps.embeddings.embedQuery(query);
  deps.cache.set(key, vector);
  return vector;
}

/**
 * Pack ranked chunks into grounding text under a hard character ceiling.
 *
 * The ceiling is enforced here rather than trusted to the model's context
 * window, because a context window is a limit on what fits, not a limit on
 * what an operator agreed to pay for or send. Chunks are taken in rank order
 * and the first one that would not fit ends the packing, so the text handed
 * to the model is always the best of what was found rather than a truncated
 * middle.
 */
export function packSources(
  chunks: readonly ScoredChunk[],
  maxContextChars: number,
): { sources: ScoredChunk[]; text: string; usedChars: number } {
  const sources: ScoredChunk[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const block = `[${sources.length + 1}] ${chunk.title} (conversation ${chunk.conversationId})\n${chunk.text}`;
    if (used + block.length > maxContextChars && sources.length > 0) break;
    sources.push(chunk);
    blocks.push(block.slice(0, maxContextChars));
    used += block.length;
  }
  return { sources, text: blocks.join("\n\n---\n\n"), usedChars: Math.min(used, maxContextChars) };
}

/**
 * Retrieval without an embedding model.
 *
 * This is what makes ask_conversations work on an instance that configured no
 * provider at all. The relay already maintains a keyword index and already
 * returns a relevance score, so the candidate set costs one request. Chunks
 * are then ordered by that score combined with plain term overlap.
 *
 * It is worse than embeddings, and the difference is exactly the case
 * embeddings exist for: a question phrased in different words than the
 * answer. Every result says which path produced it so nobody has to guess
 * why recall felt thin.
 */
export async function retrieveLexically(
  client: LnkzClientLike,
  config: Pick<LlmConfig, "chunkChars" | "maxConversations">,
  request: Pick<RetrievalRequest, "query" | "limit" | "perConversation" | "conversationIds">,
): Promise<RetrievalResult> {
  const ceiling = config.maxConversations;

  let relevanceById = new Map<string, number>();
  let candidateIds: string[];
  if (request.conversationIds?.length) {
    candidateIds = [...new Set(request.conversationIds)].slice(0, ceiling);
  } else {
    const { matches } = await client
      .searchConversations({ query: request.query, limit: Math.min(50, ceiling) })
      .catch(() => ({ matches: [] }));
    relevanceById = new Map(matches.map((match) => [match.id, match.relevance]));
    candidateIds = matches.map((match) => match.id).slice(0, ceiling);
  }

  const conversations = await readConversations(client, candidateIds);
  const chunks = conversations.flatMap((conversation) =>
    chunkConversation(conversation, config.chunkChars),
  );

  // The relay's own judgement is the larger half. Term overlap only orders
  // chunks within a conversation the index already picked.
  const scored = chunks
    .map((chunk) => ({
      ...chunk,
      score: 0.6 * normalized(relevanceById.get(chunk.conversationId))
        + 0.4 * lexicalOverlap(request.query, chunk.text),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score);

  return {
    chunks: thin(scored, { limit: request.limit, perConversation: request.perConversation }),
    usage: {
      candidates: candidateIds.length,
      conversationsRead: conversations.length,
      chunks: chunks.length,
      embedded: 0,
      cached: 0,
      batches: 0,
    },
  };
}

/**
 * The relay does not promise a range for relevance, so squash whatever it
 * gives into 0..1 rather than assuming. An absent score is treated as a weak
 * match rather than as zero, because the relay returned the row at all.
 */
function normalized(relevance: number | undefined): number {
  if (relevance === undefined || !Number.isFinite(relevance)) return 0.25;
  if (relevance <= 0) return 0;
  return relevance > 1 ? 1 : relevance;
}
