import { createHash } from "node:crypto";

/**
 * A bounded, content-addressed cache of embedding vectors.
 *
 * This is the single largest saving in the integration. Without it, every
 * query re-embeds every candidate conversation: the same unchanged text, sent
 * to the same model, priced the same way, for an answer that cannot differ.
 * Ten questions about one project re-embed that project ten times.
 *
 * The key is a hash of the model name and the chunk text, which gets three
 * properties at once. Unchanged text is never re-embedded, whichever
 * conversation or query brought it back. Appending a message to a
 * conversation re-embeds the one chunk that changed and none of the others.
 * And changing the embedding model invalidates everything, rather than
 * silently mixing vectors from two models in one similarity comparison, which
 * produces rankings that look plausible and mean nothing.
 *
 * Bounded because this process is long lived and a cache without a ceiling is
 * a leak with good intentions. Eviction is least recently used, which a Map
 * gives us: Maps iterate in insertion order, so deleting and re-setting a key
 * on read moves it to the end and the first key is always the coldest.
 */
export class EmbeddingCache {
  private readonly entries = new Map<string, readonly number[]>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly maxEntries: number) {}

  static key(model: string, text: string): string {
    return createHash("sha256").update(model).update("|").update(text).digest("base64url");
  }

  get(key: string): readonly number[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, vector: readonly number[]): void {
    if (this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, vector);
    while (this.entries.size > this.maxEntries) {
      const coldest = this.entries.keys().next();
      if (coldest.done) break;
      this.entries.delete(coldest.value);
    }
  }

  get stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hitCount, misses: this.missCount };
  }
}
