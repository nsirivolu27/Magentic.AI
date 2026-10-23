import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * The update feed: one small JSON document published next to each release.
 * The launcher reads it once at start, compares versions and says so in the
 * log. Nothing is downloaded or installed automatically; a download that is
 * verified here is refused when its hash does not match the feed.
 */
export const feedSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url().startsWith("https://"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().url().optional(),
}).strict();
export type UpdateFeed = z.infer<typeof feedSchema>;

/** Semantic order on x.y.z strings: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

export type UpdateCheck = { status: "current" } | { status: "available"; feed: UpdateFeed } | { status: "unreachable"; reason: string };

/** Reads the feed once. Any failure is reported, never retried, and never blocks start. */
export async function checkForUpdate(feedUrl: string, current: string, fetcher: typeof fetch = fetch): Promise<UpdateCheck> {
  try {
    const url = new URL(feedUrl);
    if (url.protocol !== "https:") return { status: "unreachable", reason: "The update feed must be an https address." };
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { Accept: "application/json" } });
    if (!response.ok) return { status: "unreachable", reason: `The update feed answered HTTP ${response.status}.` };
    const text = await response.text();
    if (text.length > 4_096) return { status: "unreachable", reason: "The update feed is larger than expected." };
    const feed = feedSchema.parse(JSON.parse(text));
    return compareVersions(current, feed.version) < 0 ? { status: "available", feed } : { status: "current" };
  } catch (error) {
    return { status: "unreachable", reason: error instanceof Error ? error.message.slice(0, 200) : "The update feed could not be read." };
  }
}

/** True only when the file's SHA256 equals the digest the feed promised. */
export async function verifyDownload(path: string, expected: string): Promise<boolean> {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  return digest === expected.toLowerCase();
}

export function describe(check: UpdateCheck, current: string): string {
  if (check.status === "available") return `Update available: ${check.feed.version} (this is ${current}). Download ${check.feed.url}, verify the SHA256 in the feed, uninstall, then install the new package. Saved workspaces are kept.`;
  if (check.status === "current") return `Up to date (${current}).`;
  return `Update check skipped: ${check.reason}`;
}
