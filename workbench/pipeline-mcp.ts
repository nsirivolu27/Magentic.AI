import { configurableCatalog } from "./agent-configurables.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Role } from "../registry/roles.js";
import { registerBotInspection } from "./bot-mcp.js";
import type { BotRuntime } from "./bot-runtime.js";
import { registerJiraInspection } from "./jira-mcp.js";
import type { JiraRuntime } from "./jira-runtime.js";
import type { PipelineEngine } from "./pipeline.js";
import type { AssistantDirectory } from "./assistant-resolver.js";
import { CADENCES, type LearningEngine } from "./learning-schedule.js";
import type { DocumentsEngine } from "./documents.js";

export async function handlePipelineMcp(engine: PipelineEngine, workspace: string, actor: string, roles: readonly Role[],
  approvals: number, request: IncomingMessage, response: ServerResponse, raw: unknown, bots?: BotRuntime, jira?: Pick<JiraRuntime, "inspect">, assistants?: AssistantDirectory, learning?: LearningEngine, documents?: DocumentsEngine): Promise<void> {
  const server = new McpServer({ name: "magentic-pipelines", version: "0.1.0" }, {
    instructions: bots ? "Track workflows and inspect bot timelines. Bot execution and file application require the local application session." : "Track manual development handoffs and Jira previews. These tools do not execute code, invoke LLMs, send Jira requests, merge, or deploy.",
  });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  server.registerTool("get_pipeline", { description: "Read the workspace pipeline configuration and compact run summaries.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => {
    const snapshot = engine.snapshot(workspace);
    return result({ config: snapshot.config, agentConfigurations: configurableCatalog(snapshot.config), version: snapshot.version, storage: snapshot.storage, jiraDelivery: snapshot.jiraDelivery,
      runs: snapshot.runs.map(({ id, title, status, current, version, revision }) => ({ id, title, status, current, version, revision })) });
  });
  server.registerTool("get_pipeline_run", { description: "Read one run, its stage outputs, review evidence, history, and Jira previews.",
    inputSchema: z.object({ runId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true } }, async ({ runId }) => {
    const run = engine.snapshot(workspace).runs.find(item => item.id === runId);
    return run ? result(run) : { ...result({ error: "Run not found in this workspace." }), isError: true };
  });
  server.registerTool("start_pipeline_run", { description: "Start a manual development run. A repeated requestId reuses the same run. Jira actions remain previews.",
    inputSchema: z.object({ requestId: z.string().uuid(), title: z.string().min(3).max(160), brief: z.string().min(1).max(4000), issueKey: z.string().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }, async (input) => {
    try { const snapshot = engine.execute(workspace, actor, roles, { ...input, action: "start" }, approvals);
      return result(snapshot.runs.find(run => run.requestId === input.requestId));
    } catch (error) { return { ...result({ error: error instanceof Error ? error.message : "Run could not start." }), isError: true }; }
  });
  server.registerTool("update_pipeline_run", { description: "Record a manual output or review, pause/resume, block/retry, or cancel. Requires the latest revision; never sends Jira or executes agents.",
    inputSchema: z.object({ action: z.enum(["complete", "approve", "pause", "resume", "block", "retry", "cancel"]), runId: z.string().uuid(),
      expectedRevision: z.number().int().min(1), note: z.string().min(1).max(4000).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async (input) => {
    try { const snapshot = engine.execute(workspace, actor, roles, input, approvals); return result(snapshot.runs.find(run => run.id === input.runId)); }
    catch (error) { return { ...result({ error: error instanceof Error ? error.message : "Run could not update." }), isError: true }; }
  });
  if (bots) server.registerTool("get_bot_timeline", {
    description: "Read configured project, phase bot attempts, proposal evidence and actual validation results. Does not execute bots or change files.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => result(bots.snapshot(workspace)));
  if (bots) registerBotInspection(server, engine, bots, workspace, approvals);
  if (jira) registerJiraInspection(server, jira, workspace);
  // Assistants as workers. A client learns which approved assistants can work
  // and gets one's binding (model, instructions). It never gets a disabled
  // assistant or a retired release; the studio's own rules decide.
  if (assistants) server.registerTool("list_assistants", {
    description: "List Model Studio assistants in this workspace: which can work now (active, on an approved release) and why the others cannot. Read only.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => result(assistants.list(workspace)));
  if (assistants) server.registerTool("get_assistant", {
    description: "Read one usable assistant's binding: its name, release, the base model it was trained from and its instructions. Refuses an assistant that cannot work now.",
    inputSchema: z.object({ assistantId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ assistantId }) => {
    try { return result(assistants.get(workspace, assistantId)); }
    catch (error) { return { ...result({ error: error instanceof Error ? error.message : "The assistant is unavailable." }), isError: true }; }
  });
  // The learning schedule: how an assistant keeps learning from new content.
  // Setting or running one takes an author; reading is open to any member.
  const learningError = (error: unknown) => ({ ...result({ error: error instanceof Error ? error.message : "The learning schedule could not be changed." }), isError: true });
  if (learning) server.registerTool("get_learning_schedule", {
    description: "Read the learning schedules in this workspace (one per Model Studio project): cadence, import pattern, owner, next and last run, and the most recent learning runs with their steps.",
    inputSchema: z.object({ projectId: z.string().uuid().optional() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ projectId }) => {
    const snapshot = learning.snapshot(workspace);
    const keep = (item: { projectId: string }) => !projectId || item.projectId === projectId;
    return result({ schedules: snapshot.schedules.filter(keep), runs: snapshot.runs.filter(keep).slice(-20) });
  });
  if (learning) server.registerTool("set_learning_schedule", {
    description: "Set or change a project's learning schedule: manual, daily or weekly; an optional import folder file pattern such as case-notes-*.jsonl; paused or not. A cycle validates new content, trains, evaluates and requests a release. It never approves or assigns.",
    inputSchema: z.object({ projectId: z.string().uuid(), cadence: z.enum(CADENCES), pattern: z.string().max(200).optional(), paused: z.boolean().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (input) => { try { return result(learning.set(workspace, actor, roles, input)); } catch (error) { return learningError(error); } });
  if (learning) server.registerTool("run_learning_now", {
    description: "Run one learning cycle for a project now, whatever its cadence. Returns the run with each step's outcome and where it stopped.",
    inputSchema: z.object({ projectId: z.string().uuid() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ projectId }) => { try { return result(learning.runNow(workspace, actor, roles, projectId)); } catch (error) { return learningError(error); } });
  // The documentation portal: what the workspace has been given, and connecting it. Content itself is never returned over MCP.
  const documentError = (error: unknown) => ({ ...result({ error: error instanceof Error ? error.message : "The document command failed." }), isError: true });
  if (documents) server.registerTool("list_documents", {
    description: "List the documents in this workspace's documentation portal: title, size, how many lines looked like a credential, an excerpt, and the runs and datasets each one is connected to. The content stays on the machine.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => result(documents.snapshot(workspace).documents));
  if (documents) server.registerTool("add_document", {
    description: "Add a document to the portal. It is stored once by content hash; lines that look like a credential are counted and never shown. Adding trains nothing and changes no run.",
    inputSchema: z.object({ title: z.string().trim().min(1).max(120), text: z.string().min(1).max(200_000) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (input) => { try { return result(documents.execute(workspace, actor, roles, { action: "add_document", ...input }).documents.at(-1)); } catch (error) { return documentError(error); } });
  if (documents) server.registerTool("connect_document", {
    description: "Connect a document to the LLM workspace: attach it to a running workflow as reference material (runId), or add it to a Model Studio project as a validated dataset (projectId). One of the two. A document with a credential finding is refused.",
    inputSchema: z.object({ documentId: z.string().uuid(), runId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ documentId, runId, projectId }) => {
    if (!runId === !projectId) return documentError(new Error("Give exactly one of runId or projectId."));
    try { return result(documents.execute(workspace, actor, roles, runId ? { action: "attach_to_run", documentId, runId } : { action: "add_to_project", documentId, projectId }).documents.find((item) => item.id === documentId)); }
    catch (error) { return documentError(error); }
  });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  response.once("close", () => { void server.close().catch(() => undefined); });
  try { await server.connect(transport as unknown as Parameters<typeof server.connect>[0]); await transport.handleRequest(request, response, raw); }
  catch (error) { await server.close(); throw error; }
}
