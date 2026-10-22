import { z } from "zod";
import type { ChatVault } from "./chat-vault.js";

export const connectionProvider = z.enum(["openai", "anthropic", "google"]);
export type ConnectionProvider = z.infer<typeof connectionProvider>;
const modelName = z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9._:/-]+$/);
export const connectionCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), provider: connectionProvider, apiKey: z.string().trim().min(8).max(4096).regex(/^[\x21-\x7e]+$/), models: z.array(modelName).min(1).max(20) }).strict(),
  z.object({ action: z.literal("disconnect"), provider: connectionProvider }).strict(),
]);
const savedConnection = z.object({ provider: connectionProvider, apiKey: z.string(), models: z.array(modelName), connectedAt: z.string() }).strict();
export const providerLabels = { openai: "OpenAI", anthropic: "Claude", google: "Gemini" };

async function verifyModels(provider: ConnectionProvider, key: string, models: string[], request: typeof fetch): Promise<void> {
  const names = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = provider === "openai" ? "https://api.openai.com/v1/models"
      : provider === "anthropic" ? "https://api.anthropic.com/v1/models?limit=100" + (cursor ? "&after_id=" + encodeURIComponent(cursor) : "")
      : "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100" + (cursor ? "&pageToken=" + encodeURIComponent(cursor) : "");
    const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : provider === "google" ? { "x-goog-api-key": key } : { Authorization: `Bearer ${key}` };
    let raw: unknown;
    try {
      const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error();
      raw = await response.json();
    } catch { throw new Error("Could not verify this provider connection. Check the API key and account access."); }
    if (provider === "google") {
      const data = z.object({ models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })), nextPageToken: z.string().optional() }).parse(raw);
      for (const model of data.models) if (model.supportedGenerationMethods?.includes("generateContent")) names.add(model.name.replace(/^models\//, ""));
      cursor = data.nextPageToken ?? "";
    } else {
      const data = z.object({ data: z.array(z.object({ id: z.string() })), has_more: z.boolean().optional(), last_id: z.string().optional() }).parse(raw);
      data.data.forEach(model => names.add(model.id));
      cursor = provider === "anthropic" && data.has_more ? data.last_id ?? "" : "";
    }
    if (models.every(model => names.has(model))) return;
    if (!cursor) break;
  }
  throw new Error("One or more model IDs are not listed for this API account. Copy text model IDs from the provider console.");
}

export function createChatConnections(vault: ChatVault, request: typeof fetch = fetch) {
  const scope = (workspace: string, actor: string) => JSON.stringify(["connections", workspace, actor]);
  const read = (workspace: string, actor: string) => z.array(savedConnection).parse(vault.read(scope(workspace, actor)) ?? []);
  const busy = new Set<string>();
  return {
    read,
    list(workspace: string, actor: string) { return read(workspace, actor).map(({ provider, models, connectedAt }) => ({ provider, models, connectedAt })); },
    async execute(workspace: string, actor: string, raw: unknown) {
      const input = connectionCommand.parse(raw);
      const id = scope(workspace, actor);
      if (busy.has(id)) throw new Error("A connection update is already running.");
      busy.add(id);
      try {
        if (input.action === "connect") await verifyModels(input.provider, input.apiKey, input.models, request);
        const next = read(workspace, actor).filter(item => item.provider !== input.provider);
        if (input.action === "connect") next.push({ provider: input.provider, apiKey: input.apiKey, models: [...new Set(input.models)], connectedAt: new Date().toISOString() });
        vault.write(id, next);
      } finally { busy.delete(id); }
    },
  };
}
