import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { editorAssistantSchema, type EditorAssistant } from "./editor-session.js";
import { workspacesDirectory } from "./storage.js";

/**
 * How the editor extension reaches the local workbench's assistants.
 *
 * The extension is a standalone client: it presents the MCP token from the
 * workbench's data directory to the pipeline MCP endpoint and asks which
 * assistants can work. It only ever talks to a loopback address, so the
 * token never leaves the machine, and it takes the binding fresh before
 * each request, so a retired release stops the work the same minute.
 */

export const assistantListingSchema = z.object({
  id: z.string().uuid(), name: z.string(), project: z.string(), projectId: z.string(), release: z.string(), usable: z.boolean(), reason: z.string(),
}).strict();
/** What the panel shows about an assistant's learning: the rhythm and the last cycle. */
export const learningStatusSchema = z.object({
  schedules: z.array(z.object({ projectId: z.string(), cadence: z.string(), pattern: z.string(), paused: z.boolean(), nextRunAt: z.string().nullable(), lastRunAt: z.string().optional() }).passthrough()),
  runs: z.array(z.object({ projectId: z.string(), status: z.string(), summary: z.string(), startedAt: z.string(), trigger: z.string() }).passthrough()),
});
export type LearningStatus = z.infer<typeof learningStatusSchema>;
export type AssistantListing = z.infer<typeof assistantListingSchema>;

/** Where the local application keeps the standalone client token. */
export function workbenchTokenFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(workspacesDirectory(env, platform), "mcp-token");
}

export async function readWorkbenchToken(file: string): Promise<string> {
  let token: string;
  try { token = (await readFile(file, "utf8")).trim(); }
  catch { throw new Error(`No workbench token at ${file}. Start Magentic Developer once so it creates one, or set magentic.workbenchTokenFile.`); }
  if (!token) throw new Error(`The workbench token file ${file} is empty.`);
  return token;
}

/** The workbench URL must be this machine. A token is never sent anywhere else. */
export function workbenchEndpoint(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Set magentic.workbenchUrl to the address Magentic Developer shows, such as http://127.0.0.1:4173."); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("magentic.workbenchUrl must be a loopback http address; the workbench runs on this machine only.");
  return new URL("/api/pipeline-mcp", parsed);
}

async function call(url: string, token: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const client = new Client({ name: "magentic-vscode", version: "1" });
  const transport = new StreamableHTTPClientTransport(workbenchEndpoint(url), { requestInit: { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) } });
  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const response = await client.callTool({ name: tool, arguments: args }, undefined, signal ? { signal } : {}) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = response.content?.find((item) => item.type === "text")?.text ?? "";
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("The workbench returned something that is not JSON."); }
    if (response.isError) throw new Error(typeof value === "object" && value && "error" in value ? String((value as { error: unknown }).error) : "The workbench refused the request.");
    return value;
  } catch (error) {
    if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/.test(error.message)) throw new Error(`Cannot reach the workbench at ${url}. Start Magentic Developer and check magentic.workbenchUrl.`);
    if (error instanceof Error && /401|403|Unauthorized|access token/.test(error.message)) throw new Error("The workbench refused the token. Restart Magentic Developer or point magentic.workbenchTokenFile at its current token.");
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listWorkbenchAssistants(url: string, token: string, signal?: AbortSignal): Promise<AssistantListing[]> {
  return z.array(assistantListingSchema).parse(await call(url, token, "list_assistants", {}, signal));
}

/** The binding for one assistant, taken fresh so a retired release is refused here and not discovered later. */
export async function getWorkbenchAssistant(url: string, token: string, assistantId: string, signal?: AbortSignal): Promise<EditorAssistant> {
  return editorAssistantSchema.parse(await call(url, token, "get_assistant", { assistantId }, signal));
}

export async function getWorkbenchLearning(url: string, token: string, projectId: string, signal?: AbortSignal): Promise<LearningStatus> {
  return learningStatusSchema.parse(await call(url, token, "get_learning_schedule", { projectId }, signal));
}

/** Run one learning cycle for the assistant's project now. The workbench decides what it may do; the result says where it stopped. */
export async function runWorkbenchLearning(url: string, token: string, projectId: string, signal?: AbortSignal): Promise<{ status: string; summary: string }> {
  return z.object({ status: z.string(), summary: z.string() }).passthrough().parse(await call(url, token, "run_learning_now", { projectId }, signal));
}
