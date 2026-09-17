import type { Conversation } from "../contract.js";

/**
 * Cutting a conversation into retrievable pieces.
 *
 * The obvious approach is a character splitter over the whole transcript,
 * which is what most retrieval code does and what LangChain's
 * RecursiveCharacterTextSplitter would give us. It is wrong for this corpus.
 * A conversation is already split: into messages, by turn, each with an
 * author and a time. Cutting through the middle of a turn produces a chunk
 * that says "yes, do that" with no way to tell what "that" was, and loses the
 * message id, which is the only thing that lets an answer point back at the
 * exact turn it came from.
 *
 * So the unit is the message, and a chunk is whole messages packed until the
 * next one would not fit. Every chunk carries the ids of the messages inside
 * it, which is what makes a citation checkable.
 */
export interface Chunk {
  conversationId: string;
  title: string;
  /** Position within the conversation, so chunks can be read back in order. */
  index: number;
  /** Ids of the messages packed into this chunk. Citations resolve through these. */
  messageIds: string[];
  text: string;
}

/**
 * One message of trailing overlap. A decision usually lands one turn after
 * the question that prompted it, and a chunk boundary between them makes both
 * halves useless. One message is enough to keep the pair together and cheap
 * enough not to inflate the index.
 */
const OVERLAP_MESSAGES = 1;

export function chunkConversation(conversation: Conversation, chunkChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: { messageIds: string[]; lines: string[]; length: number } | undefined;

  const flush = () => {
    if (!current || current.lines.length === 0) return;
    chunks.push({
      conversationId: conversation.id,
      title: conversation.title,
      index: chunks.length,
      messageIds: [...current.messageIds],
      text: current.lines.join("\n\n"),
    });
  };

  for (const message of conversation.messages) {
    const line = renderMessage(message.role, message.author, message.content);
    if (!line) continue;

    if (current && current.length + line.length > chunkChars) {
      flush();
      // Carry the tail of the chunk we just closed into the next one, so the
      // boundary is a seam rather than a cut.
      const carried = current.lines.slice(-OVERLAP_MESSAGES);
      const carriedIds = current.messageIds.slice(-OVERLAP_MESSAGES);
      current = {
        lines: [...carried],
        messageIds: [...carriedIds],
        length: carried.reduce((total, entry) => total + entry.length, 0),
      };
    }

    current ??= { lines: [], messageIds: [], length: 0 };
    current.lines.push(line);
    current.messageIds.push(message.id);
    current.length += line.length;

    // A single message longer than the budget gets its own chunk rather than
    // being cut. Retrieval that returns half a specification is worse than
    // retrieval that returns a long one.
    if (current.length >= chunkChars) {
      flush();
      current = undefined;
    }
  }
  flush();
  return chunks;
}

function renderMessage(role: string, author: string | undefined, content: string): string {
  const text = content.trim();
  if (!text) return "";
  const speaker = author?.trim() ? `${role} (${author.trim()})` : role;
  return `${speaker}: ${text}`;
}

/**
 * Cosine similarity, written here rather than imported.
 *
 * LangChain's MemoryVectorStore would do this, but it lives in the `langchain`
 * umbrella package, which pulls in agents, chains, output parsers and their
 * transitive dependencies to get thirty lines of arithmetic. For a corpus
 * bounded at a few hundred chunks per query, a linear scan over an array is
 * both faster than a vector database and one less thing to install.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * Rank chunks against a query vector, then thin the result so that one
 * talkative conversation cannot fill every slot. A question about a decision
 * usually wants the two or three conversations that touched it, not eight
 * consecutive chunks of the longest one.
 */
export function rankChunks(
  queryVector: readonly number[],
  entries: readonly { chunk: Chunk; vector: readonly number[] }[],
  options: { limit: number; minScore: number; perConversation: number },
): ScoredChunk[] {
  const scored = entries
    .map((entry) => ({ ...entry.chunk, score: cosineSimilarity(queryVector, entry.vector) }))
    .filter((entry) => entry.score >= options.minScore)
    .sort((left, right) => right.score - left.score);

  const taken = new Map<string, number>();
  const kept: ScoredChunk[] = [];
  for (const entry of scored) {
    if (kept.length >= options.limit) break;
    const used = taken.get(entry.conversationId) ?? 0;
    if (used >= options.perConversation) continue;
    taken.set(entry.conversationId, used + 1);
    kept.push(entry);
  }
  return kept;
}
