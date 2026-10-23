import type { LnkzClientLike } from "./client.js";
import type { ConversationSummary } from "./contract.js";

/**
 * What a person types instead of a UUID.
 *
 * Every tool here takes conversation ids, and nobody knows a conversation id.
 * The protocol has an answer for this, argument completion, and the reason it
 * works is that the value it inserts has to be something a person recognises.
 * Completing a uuid from a uuid prefix helps nobody.
 *
 * So two things happen together and neither works alone. Completion offers
 * titles, and the tools accept a title where they used to demand an id. The
 * second half is what makes the first half worth having.
 *
 * Completion fires on every keystroke. "s", "st", "sto", "stor" must cost one
 * relay request, not four, which is what the cache below is for.
 */

/** How long a listing stays warm. Long enough to cover typing, short enough to not go stale. */
const TTL_MS = 15_000;

/** Suggestions returned for one prefix. The protocol caps this, and so do we. */
const MAX_SUGGESTIONS = 25;

/** Conversations pulled to suggest from. Beyond this, typing narrows rather than scrolling. */
const POOL = 100;

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

/**
 * One in-flight request per key, reused while warm.
 *
 * Storing the promise rather than the result matters: four keystrokes in the
 * same tick all attach to the first request instead of starting four.
 */
export class SuggestionCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly ttlMs: number = TTL_MS) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;

    const value = load().catch((error: unknown) => {
      // A failed lookup must not be remembered as a failure for fifteen
      // seconds. Completion is a convenience; it fails quietly and retries.
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { at: now, value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface Suggestions {
  conversationTitles(prefix: string): Promise<string[]>;
  tags(prefix: string): Promise<string[]>;
  providers(prefix: string): Promise<string[]>;
  /** Recent conversations, for a resource template's list callback. */
  conversations(): Promise<ConversationSummary[]>;
}

export function createSuggestions(client: LnkzClientLike, cache = new SuggestionCache()): Suggestions {
  const pool = () => cache.get("conversations", async () => {
    const { conversations } = await client.listConversations({ limit: POOL });
    return conversations;
  });

  return {
    conversations: pool,

    async conversationTitles(prefix: string) {
      // A completion that throws takes the whole request with it, and the
      // cost of an empty suggestion list is that someone types the id. The
      // cost of a thrown error is a broken client.
      const found = await pool().catch(() => [] as ConversationSummary[]);
      return matchTitles(found, prefix);
    },

    async tags(prefix: string) {
      const found = await pool().catch(() => [] as ConversationSummary[]);
      const all = new Set<string>();
      for (const conversation of found) for (const tag of conversation.tags) all.add(tag);
      return rank([...all], prefix);
    },

    async providers(prefix: string) {
      const found = await pool().catch(() => [] as ConversationSummary[]);
      const all = new Set<string>();
      for (const conversation of found) if (conversation.source.provider) all.add(conversation.source.provider);
      return rank([...all], prefix);
    },
  };
}

/**
 * Titles first, then ids, and a title that appears twice is disambiguated
 * rather than offered twice. Two conversations called "Storage choice" is a
 * normal thing on a relay whose whole purpose is copying conversations
 * between instances, and a completion list with the same word twice is a
 * list you cannot choose from.
 */
function matchTitles(conversations: readonly ConversationSummary[], prefix: string): string[] {
  const seen = new Map<string, number>();
  const labels: string[] = [];
  for (const conversation of conversations) {
    const count = (seen.get(conversation.title) ?? 0) + 1;
    seen.set(conversation.title, count);
    labels.push(count === 1 ? conversation.title : `${conversation.title} (${shortId(conversation.id)})`);
  }
  return rank(labels, prefix);
}

/** The first eight characters of a uuid, which is enough to tell two apart by eye. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Prefix matches before substring matches, because someone typing "de" means
 * "Deploy target" more often than they mean "Storage decided".
 */
function rank(values: readonly string[], prefix: string): string[] {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return [...values].sort().slice(0, MAX_SUGGESTIONS);

  const starts: string[] = [];
  const contains: string[] = [];
  for (const value of values) {
    const lowered = value.toLowerCase();
    if (lowered.startsWith(needle)) starts.push(value);
    else if (lowered.includes(needle)) contains.push(value);
  }
  starts.sort();
  contains.sort();
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

export interface ResolvedConversation {
  id: string;
  title: string;
}

export type ConversationLookup =
  | { ok: true; conversation: ResolvedConversation }
  | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn whatever a person or a model typed into one conversation.
 *
 * Accepts a full id, a short id as completion renders it, an exact title, or
 * a title prefix that matches one conversation. An ambiguous reference is an
 * error that lists the candidates, never a silent pick of the first: choosing
 * for someone between two conversations with the same name is how the wrong
 * thread gets handed to the wrong person.
 */
export async function resolveConversation(
  client: LnkzClientLike,
  reference: string,
  suggestions: Suggestions,
): Promise<ConversationLookup> {
  const value = reference.trim();
  if (!value) return { ok: false, message: "Name a conversation by title or id." };

  if (UUID.test(value)) {
    try {
      const { conversation } = await client.getConversation(value.toLowerCase());
      return { ok: true, conversation: { id: conversation.id, title: conversation.title } };
    } catch {
      return { ok: false, message: `No conversation with id ${value}.` };
    }
  }

  const pool = await suggestions.conversations().catch(() => [] as ConversationSummary[]);
  if (pool.length === 0) {
    return { ok: false, message: "No conversations are available to match against." };
  }

  // A short id, as it appears in a disambiguated completion label.
  const byShortId = pool.filter((conversation) => shortId(conversation.id) === value.toLowerCase());
  if (byShortId.length === 1) return found(byShortId[0]);

  // A completion label carries its disambiguating suffix; strip it back off.
  const bare = value.replace(/\s*\([0-9a-f]{8}\)$/i, "").trim();
  const suffix = /\(([0-9a-f]{8})\)$/i.exec(value)?.[1]?.toLowerCase();

  const exact = pool.filter((conversation) =>
    conversation.title.toLowerCase() === bare.toLowerCase()
    && (!suffix || shortId(conversation.id) === suffix));
  if (exact.length === 1) return found(exact[0]);
  if (exact.length > 1) return ambiguous(exact);

  const partial = pool.filter((conversation) => conversation.title.toLowerCase().startsWith(bare.toLowerCase()));
  if (partial.length === 1) return found(partial[0]);
  if (partial.length > 1) return ambiguous(partial);

  return { ok: false, message: `No conversation matches "${value}". Use list_conversations to see what is here.` };
}

function found(conversation: ConversationSummary | undefined): ConversationLookup {
  if (!conversation) return { ok: false, message: "No conversation matched." };
  return { ok: true, conversation: { id: conversation.id, title: conversation.title } };
}

function ambiguous(candidates: readonly ConversationSummary[]): ConversationLookup {
  const listed = candidates
    .slice(0, 6)
    .map((conversation) => `${conversation.title} (${shortId(conversation.id)})`)
    .join(", ");
  return {
    ok: false,
    message: `That matches ${candidates.length} conversations: ${listed}. Use the id, or the title with its short id in brackets.`,
  };
}
