import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { setting } from "../env.js";
import { atomicJson } from "./bot-project.js";
import { findSecretKinds } from "./studio/dataset.js";

const connection = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  channel: z.string().regex(/^#[a-z0-9_-]{1,80}$/),
  webhookSetting: z.string().regex(/^MAGENTIC_SLACK_WEBHOOK(?:_[A-Z0-9]+)*$/),
}).strict();
export const slackConfigSchema = z.object({ connections: z.array(connection).max(100) }).strict().superRefine(({ connections }, ctx) => {
  const seen = new Set<string>();
  connections.forEach((entry, index) => {
    if (seen.has(entry.workspaceId)) ctx.addIssue({ code: "custom", path: ["connections", index, "workspaceId"], message: "Duplicate workspace." });
    seen.add(entry.workspaceId);
  });
});
export const slackCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), kind: z.enum(["audit", "message"]), note: z.string().trim().max(1000) }).strict(),
  z.object({ action: z.literal("send"), previewId: z.string().uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const receiptSchema = z.object({ id: z.string().uuid(), actor: z.string(), at: z.string(), channel: z.string(),
  contentHash: z.string(), state: z.enum(["sent", "unknown"]) }).strict();
export type SlackReceipt = z.infer<typeof receiptSchema>;
export interface SlackSummary { configured: boolean; ready: boolean; channel?: string; canSend: boolean; receipts: SlackReceipt[] }
export interface SlackPreview { id: string; channel: string; text: string; hash: string; expiresAt: string }
interface ReceiptStore { read(workspace: string): SlackReceipt[]; write(workspace: string, rows: SlackReceipt[]): void }
export class SlackError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function webhook(raw: string | undefined): string {
  // A webhook is an outbound capability; a tenant cannot turn it into an arbitrary HTTP client.
  if (!raw || !/^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(raw))
    throw new SlackError(503, "Configure a valid Slack incoming webhook on the company server.");
  return raw;
}
export function createSlack(raw: unknown, store: ReceiptStore, readSetting = setting, fetcher: typeof fetch = fetch, now = Date.now) {
  const config = slackConfigSchema.parse(raw);
  const previews = new Map<string, { value: SlackPreview; actor: string; workspace: string; targetHash: string }>();
  function target(workspace: string) {
    const entry = config.connections.find(item => item.workspaceId === workspace);
    if (!entry) throw new SlackError(404, "Slack is not configured for this company workspace.");
    return entry;
  }
  return {
    summary(workspace: string, canSend: boolean): SlackSummary {
      const entry = config.connections.find(item => item.workspaceId === workspace);
      if (!entry) return { configured: false, ready: false, canSend: false, receipts: [] };
      let ready = false; try { webhook(readSetting(entry.webhookSetting)); ready = true; } catch { /* A missing secret is setup, not connectivity proof. */ }
      return { configured: true, ready, channel: entry.channel, canSend,
        receipts: store.read(workspace).slice(-10).reverse() };
    },
    preview(workspace: string, actor: string, kind: "audit" | "message", note: string, audit: string): SlackPreview {
      const entry = target(workspace), url = webhook(readSetting(entry.webhookSetting));
      if (kind === "message" && note.trim().length < 3) throw new SlackError(400, "Write a team update before previewing.");
      const text = kind === "audit" ? audit + (note ? "\n\nOperator note: " + note : "") : note;
      if (text.length > 2900 || findSecretKinds(text).length || /https:\/\/hooks\.slack(?:-gov)?\.com\/services\//i.test(text))
        throw new SlackError(400, "Remove possible credentials or shorten the message before sending.");
      for (const [id, item] of previews) if (Date.parse(item.value.expiresAt) <= now()) previews.delete(id);
      if (previews.size >= 100) throw new SlackError(429, "Too many pending previews. Wait for older previews to expire.");
      const value = { id: randomUUID(), channel: entry.channel, text, hash: hash(text),
        expiresAt: new Date(now() + 300_000).toISOString() };
      previews.set(value.id, { value, workspace, actor, targetHash: hash(url) }); return value;
    },
    async send(workspace: string, actor: string, id: string, expectedHash: string): Promise<SlackReceipt> {
      const previous = store.read(workspace).find(item => item.id === id);
      if (previous) {
        if (previous.actor !== actor || previous.contentHash !== expectedHash) throw new SlackError(409, "This preview belongs to another request.");
        return previous;
      }
      const item = previews.get(id);
      if (!item || item.workspace !== workspace || item.actor !== actor || item.value.hash !== expectedHash || Date.parse(item.value.expiresAt) <= now())
        throw new SlackError(409, "Preview expired or changed. Review a new preview.");
      const entry = target(workspace), url = webhook(readSetting(entry.webhookSetting));
      if (hash(url) !== item.targetHash) throw new SlackError(409, "The Slack destination changed. Preview again.");
      const rows = store.read(workspace);
      if (rows.length >= 1000) throw new SlackError(409, "Slack receipt storage is full. Archive it before sending more messages.");
      // Record uncertainty before the network call. A crash or retry cannot silently send this preview twice.
      const receipt: SlackReceipt = { id, actor, at: new Date(now()).toISOString(), channel: entry.channel,
        contentHash: expectedHash, state: "unknown" };
      store.write(workspace, [...rows, receipt]);
      previews.delete(id);
      try {
        const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: item.value.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
            blocks: [{ type: "section", text: { type: "plain_text", text: item.value.text, emoji: false } }],
            mrkdwn: false, unfurl_links: false, unfurl_media: false }) });
        const reader = response.body?.getReader();
        let acknowledgment = "";
        if (reader) {
          try {
            while (acknowledgment.length <= 16) { const part = await reader.read(); if (part.done) break; acknowledgment += new TextDecoder().decode(part.value); }
          } finally { await reader.cancel(); }
        }
        if (response.status === 200 && acknowledgment.trim() === "ok") receipt.state = "sent";
      } catch { /* A timeout may follow a successful post. Keep the outcome unknown and never auto-retry. */ }
      const current = store.read(workspace);
      store.write(workspace, current.map(row => row.id === id ? receipt : row));
      return receipt;
    },
  };
}
export type Slack = ReturnType<typeof createSlack>;

export function loadSlack(directory: string): Slack | undefined {
  const file = setting("MAGENTIC_SLACK_FILE");
  if (!file) return undefined;
  let config: unknown;
  try { config = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("MAGENTIC_SLACK_FILE must name a readable JSON configuration."); }
  const parsed = slackConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error("MAGENTIC_SLACK_FILE: " + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "));
  return createSlack(parsed.data, {
    read(workspace) {
      try { return z.array(receiptSchema).max(1000).parse(JSON.parse(readFileSync(join(directory, hash(workspace) + ".json"), "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new SlackError(503, "Slack delivery records could not be read. Sending is unavailable.");
      }
    },
    write(workspace, rows) {
      try { mkdirSync(directory, { recursive: true }); atomicJson(join(directory, hash(workspace) + ".json"), rows); }
      catch { throw new SlackError(503, "Slack delivery records could not be saved. Check the channel before retrying."); }
    },
  });
}
