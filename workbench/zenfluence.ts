import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { setting } from "../env.js";
import { findSecretKinds } from "./studio/dataset.js";
import { materialSchema } from "./materials.js";

const identifier = z.string().regex(/^[1-9]\d{0,29}$/);
// A workspace is a company UUID on the company server or a local name such as
// "workspace" in local mode; the same rule the ontology configuration uses.
const workspaceIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const connectionSchema = z.object({
  workspaceId: workspaceIdentifier,
  site: z.string().regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/),
  project: z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/), spaceId: identifier,
  emailSetting: z.string().regex(/^MAGENTIC_ATLASSIAN_EMAIL(?:_[A-Z0-9]+)*$/),
  tokenSetting: z.string().regex(/^MAGENTIC_ATLASSIAN_TOKEN(?:_[A-Z0-9]+)*$/),
}).strict();
export const zenfluenceConfigSchema = z.object({ connections: z.array(connectionSchema).max(100) }).strict().superRefine(({ connections }, context) => {
  const seen = new Set<string>();
  connections.forEach((connection, i) => {
    if (seen.has(connection.workspaceId)) context.addIssue({ code: "custom", path: ["connections", i, "workspaceId"], message: "Duplicate company connection." });
    seen.add(connection.workspaceId);
  });
});
export const zenfluenceReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("jira"), id: z.string().regex(/^[A-Z][A-Z0-9]{1,19}-[1-9]\d*$/).max(60) }).strict(),
  z.object({ kind: z.literal("confluence"), id: identifier }).strict(),
]);
export const zenfluenceCommandSchema = z.object({
  action: z.enum(["read", "attach"]), source: zenfluenceReadSchema,
  runId: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "attach" && (!value.runId || !value.expectedRevision || !value.expectedSourceHash)) context.addIssue({ code: "custom", message: "Attaching requires runId, expectedRevision and expectedSourceHash." });
  if (value.action === "read" && (value.runId || value.expectedRevision || value.expectedSourceHash)) context.addIssue({ code: "custom", message: "Read accepts only a source." });
});
export class ZenfluenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface ZenfluenceSource {
  kind: "jira" | "confluence"; id: string; title: string; text: string; revision: string;
  url: string; contentHash: string; retrievedAt: string; truncated: boolean;
}

function adfText(raw: unknown): string {
  const text: string[] = []; let nodes = 0;
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== "object") return;
    if (++nodes > 4000 || depth > 30) throw new ZenfluenceError(502, "This document is too complex to read.");
    const node = value as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") text.push(node.text);
    if (Array.isArray(node.content)) for (const child of node.content) visit(child, depth + 1);
  }
  visit(raw, 0); return text.join(" ");
}
export function createZenfluenceDirectory(raw: unknown, readSetting = setting, fetcher: typeof fetch = fetch) {
  const config = zenfluenceConfigSchema.parse(raw);
  return (workspace: string) => {
    const configEntry = config.connections.find(item => item.workspaceId === workspace);
    if (!configEntry) return undefined;
    const entry = configEntry;
    return {
      summary() {
        // Which settings are present, never their values. The names tell the
        // person what to set; the values stay on the server.
        const emailConfigured = Boolean(readSetting(entry.emailSetting)?.trim());
        const tokenConfigured = Boolean(readSetting(entry.tokenSetting)?.trim());
        return { configured: true, site: entry.site, project: entry.project, spaceId: entry.spaceId,
          ready: emailConfigured && tokenConfigured,
          settings: { email: { name: entry.emailSetting, configured: emailConfigured }, token: { name: entry.tokenSetting, configured: tokenConfigured } } };
      },
      async read(rawSource: unknown): Promise<ZenfluenceSource> {
        const source = zenfluenceReadSchema.parse(rawSource);
        if (source.kind === "jira" && !source.id.startsWith(entry.project + "-")) throw new ZenfluenceError(403, "Choose a ticket in the configured project.");
        const email = readSetting(entry.emailSetting)?.trim(), token = readSetting(entry.tokenSetting)?.trim();
        if (!email || !token) throw new ZenfluenceError(503, "The company Atlassian connection needs credentials on the server.");
        const path = source.kind === "jira" ? `/rest/api/3/issue/${source.id}?fields=summary,status,project,updated,description`
          : `/wiki/api/v2/pages/${source.id}?body-format=atlas_doc_format`;
        try {
          const response = await fetcher(entry.site + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
            headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` } });
          if (!response.ok) { await response.body?.cancel(); throw new ZenfluenceError(502, `Atlassian read failed (HTTP ${response.status}). Check company access.`); }
          const reader = response.body?.getReader(); if (!reader) throw new ZenfluenceError(502, "Atlassian returned an empty response.");
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 128_000) throw new ZenfluenceError(502, "This source exceeds the 128 KB read limit.");
              chunks.push(chunk.value);
            }
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          let title: string, text: string, revision: string, url: string;
          if (source.kind === "jira") {
            const issue = z.object({ key: z.string(), fields: z.object({ summary: z.string().max(255), status: z.object({ name: z.string().max(100) }),
              project: z.object({ key: z.string() }), updated: z.string().max(100), description: z.unknown() }) }).parse(raw);
            if (issue.key !== source.id || issue.fields.project.key !== entry.project) throw new ZenfluenceError(403, "The ticket is outside this company's project.");
            title = issue.fields.summary; revision = issue.fields.updated;
            text = `Status: ${issue.fields.status.name}\n${adfText(issue.fields.description)}`;
            url = `${entry.site}/browse/${source.id}`;
          } else {
            const page = z.object({ id: z.string(), spaceId: z.string(), status: z.literal("current"), title: z.string().max(255),
              version: z.object({ number: z.number().int().positive() }), body: z.object({ atlas_doc_format: z.object({ value: z.string() }) }) }).parse(raw);
            if (page.id !== source.id || page.spaceId !== entry.spaceId) throw new ZenfluenceError(403, "The page is outside this company's Confluence space.");
            title = page.title; revision = String(page.version.number); text = adfText(JSON.parse(page.body.atlas_doc_format.value));
            url = `${entry.site}/wiki/pages/viewpage.action?pageId=${source.id}`;
          }
          if (findSecretKinds(title + "\n" + text).length) throw new ZenfluenceError(409, "The source contains a possible credential. Remove it before importing.");
          const contentHash = createHash("sha256").update(JSON.stringify({ source, title, text, revision, url })).digest("hex");
          return { ...source, title, text: text.slice(0, 4500), revision, url, contentHash, retrievedAt: new Date().toISOString(), truncated: text.length > 4500 };
        } catch (error) {
          if (error instanceof ZenfluenceError) throw error;
          throw new ZenfluenceError(502, "Atlassian could not return valid data. Check the connection and source.");
        }
      },
    };
  };
}
export type ZenfluenceDirectory = ReturnType<typeof createZenfluenceDirectory>;
export function loadZenfluenceDirectory(): ZenfluenceDirectory {
  const path = setting("MAGENTIC_ZENFLUENCE_FILE");
  if (!path) return createZenfluenceDirectory({ connections: [] });
  let raw: unknown;
  try { if (statSync(path).size > 128_000) throw new Error(); raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("MAGENTIC_ZENFLUENCE_FILE must name a readable JSON file under 128 KB."); }
  const checked = zenfluenceConfigSchema.safeParse(raw);
  if (!checked.success) throw new Error(`MAGENTIC_ZENFLUENCE_FILE: ${checked.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return createZenfluenceDirectory(checked.data);
}
export function zenfluenceMaterial(source: ZenfluenceSource) {
  return materialSchema.parse({ id: randomUUID(), title: `${source.kind}: ${source.title}`.slice(0, 120), url: source.url,
    content: `Source: ${source.kind} ${source.id}. Revision: ${source.revision}. SHA-256: ${source.contentHash}. Retrieved: ${source.retrievedAt}.${source.truncated ? " Excerpt truncated." : ""}\n${source.text}` });
}
