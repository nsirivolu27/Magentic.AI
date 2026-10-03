import { OntologyError, ontologyMaterial, type OntologyDirectory } from "./ontology.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { agentSchema } from "../catalog/schema.js";
import { hashDefinition, isServable, validApprovers } from "../registry/record.js";
import { PermissionError } from "../registry/roles.js";
import { approve, authorDraft, requestChanges, retire, submit, TransitionError, type TransitionContext } from "../registry/transition.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { handleWorkspaceMcp, workspaceMcpOverview } from "./mcp-portal.js";
import { chatRequestSchema, runBaseChat, runWorkspaceAgent, untilAborted, type ChatConfiguration, type ChatEvent } from "./chat.js";
import type { EmailPortal } from "./email.js";

import { PipelineError, type PipelineEngine } from "./pipeline.js";
import { handlePipelineMcp } from "./pipeline-mcp.js";

import { JiraApiError, type JiraRuntime } from "./jira-runtime.js";
import { JiraError } from "./jira.js";
import { StudioError, type ModelStudio } from "./studio/engine.js";
import { assistantDirectory } from "./assistant-resolver.js";
import type { Scheduler } from "./scheduler.js";
import { CADENCES, type LearningEngine } from "./learning-schedule.js";
import { DocumentError, type DocumentsEngine } from "./documents.js";
import { StudioStorageError } from "./studio/store.js";

export interface WorkspaceIdentity {
  workspaceId: string; actor: string;
  // A standalone MCP credential must not inherit local delivery authority.
  canDeliverJira?: boolean;
}
export interface WorkbenchOptions {
  context: TransitionContext;
  // Identity comes from the deployment's authentication system. Accepting an
  // actor in a submitted form would let a writer impersonate an approver.
  authenticate: (request: IncomingMessage) => Promise<WorkspaceIdentity | undefined>;
  assets: ReadonlyMap<string, { type: string; body: string | Buffer }>;
  /**
   * Runs before routing, for checks that are not about identity: which Host
   * and Origin this deployment accepts, and any one-shot session handshake.
   * Returning an error stops the request there. Undefined for every
   * deployment that had none, which is all of them until local mode.
   */
  guard?: (request: IncomingMessage, response: ServerResponse) => { status: number; message: string } | undefined;
  demo?: boolean;
  email?: EmailPortal;
  chat?: ChatConfiguration;
  ontology?: OntologyDirectory;
  pipelines?: PipelineEngine;
  jira?: JiraRuntime;
  bots?: import("./bot-runtime.js").BotRuntime;
  workspaces?: import("./workspace-directory.js").WorkspaceDirectory;
  mcpAccess?: (workspaceId: string) => { workspaceId: string; tokenFile: string };
  /** The Model Studio: projects, datasets, jobs, evaluations, releases and chatbot profiles. */
  studio?: ModelStudio;
  /** Assistants working their workflow stages on their own. Ticked after every pipeline or studio command. */
  scheduler?: Scheduler;
  /** Projects learning from new content on a rhythm. Ticked with the scheduler. */
  learning?: LearningEngine;
  /** The documentation portal: documents attached to runs or added to projects. */
  documents?: DocumentsEngine;
}

const draftSchema = z.object({ definition: agentSchema, expectedHash: z.string().optional() }).strict();
const actionSchema = z.object({
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().max(2_000).optional(),
}).strict();

const learningCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), projectId: z.string().uuid(), cadence: z.enum(CADENCES), pattern: z.string().max(200).optional(), paused: z.boolean().optional() }).strict(),
  z.object({ action: z.enum(["remove", "run"]), projectId: z.string().uuid() }).strict(),
]);
const scheduleCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.enum(["retry", "cancel"]), jobId: z.string().uuid() }).strict(),
]);

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createWorkbenchServer(options: WorkbenchOptions) {
  // Jobs run in the background; a failure is recorded on the job, never thrown at a request.
  const tickScheduler = (workspaceId: string) => {
    try { options.learning?.tick(workspaceId); } catch { /* a cycle that throws is recorded on its run; the request already answered */ }
    void options.scheduler?.tick(workspaceId).catch(() => undefined);
  };
  if (!options.context.members) throw new Error("The workbench requires a member directory.");
  // Serial writes keep the content check and the following signature on the
  // same version. A database-backed deployment needs a transaction as well.
  let pending: Promise<void> = Promise.resolve();
  const activeChats = new Set<string>();
  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const refusal = options.guard?.(request, response);
      if (refusal) throw new RequestError(refusal.status, refusal.message);
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!path.startsWith("/api/")) {
        const asset = options.assets.get(path);
        if (request.method !== "GET" || !asset) throw new RequestError(404, "Not found.");
        response.setHeader("Content-Type", asset.type);
        response.end(asset.body);
        return;
      }
      const identity = await options.authenticate(request);
      if (!identity) throw new RequestError(401, "Sign in with a workspace access token.");
      const { workspaceId, actor } = identity;
      const roles = await options.context.members!.rolesFor(workspaceId, actor);
      if (!roles.length) throw new PermissionError("You are not a member of this workspace.");
      if (request.method === "GET" && path === "/api/workspaces" && options.workspaces) {
        send(response, 200, options.workspaces.list()); return;
      }
      if (request.method === "GET" && path === "/api/workspace") {
        await pending;
        const workflow = options.context.workflow ?? DEFAULT_WORKFLOW;
        const records = await options.context.store.list(workspaceId);
        send(response, 200, {
          ...(options.pipelines ? { pipelines: options.pipelines.snapshot(workspaceId) } : {}),
          ...(options.bots ? { bots: options.bots.snapshot(workspaceId) } : {}),
          ...(options.scheduler ? { schedule: options.scheduler.snapshot(workspaceId) } : {}),
          ...(options.learning ? { learning: options.learning.snapshot(workspaceId) } : {}),
          ...(options.documents ? { documents: options.documents.snapshot(workspaceId) } : {}),
          workspaceId, actor, roles, workflow, demo: options.demo ?? false,
          ...(options.jira ? { jira: { canReview: !!identity.canDeliverJira && roles.includes("admin") } } : {}),
          ...studioSnapshot(options.studio, workspaceId),
          canAuthor: roles.includes("admin") || roles.includes(workflow.roles.author),
          records: records.map((record) => ({
            ...record, hash: hashDefinition(record.definition),
            eligible: isServable(record, workflow), validApprovers: validApprovers(record),
          })),
          chat: options.chat ? { configured: true, provider: options.chat.provider, model: options.chat.model } : { configured: false },
          ...(options.ontology?.(workspaceId) ? { ontology: options.ontology(workspaceId)!.catalog() } : {}),
          mcp: await workspaceMcpOverview(options.context, workspaceId),
          audit: await options.context.audit.list(workspaceId),
          ...(options.email ? { mail: options.email.mailbox(workspaceId, actor, roles.includes("admin")) } : {}),
        });
        return;
      }
      if (path === "/api/jira" && request.method === "GET" && options.jira) {
        const query = Object.fromEntries(new URL(request.url!, "http://localhost").searchParams);
        send(response, 200, options.jira.inspect(workspaceId, { ...query,
          ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }));
        return;
      }
      if (path === "/api/bots" && request.method === "GET" && options.bots) {
        send(response, 200, options.bots.snapshot(workspaceId)); return;
      }
      if (path === "/api/chat/models" && request.method === "GET") {
        if (!options.chat) { send(response, 200, { models: [] }); return; }
        try {
          if (options.chat.modelOptions) {
            const choices = await options.chat.modelOptions();
            send(response, 200, { models: choices.filter((model) => model.available).map((model) => model.id), options: choices });
            return;
          }
          const models = options.chat.listModels ? await options.chat.listModels() : [options.chat.model];
          send(response, 200, { models });
        } catch { throw new RequestError(503, "Could not list models. Make sure Ollama is running, then refresh models."); }
        return;
      }
      if ((path === "/api/mcp" || path === "/api/pipeline-mcp") && request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new RequestError(405, "This MCP endpoint accepts POST requests.");
      }
      if (request.method !== "POST") throw new RequestError(404, "Not found.");
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new RequestError(415, "Use application/json.");
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`
        && request.headers.origin !== `https://${request.headers.host}`) {
        throw new RequestError(403, "Cross-origin writes are not allowed.");
      }
      const raw = await body(request);
      if (path === "/api/ontology/reference") {
        const ontology = options.ontology?.(workspaceId);
        if (!ontology) throw new RequestError(404, "Ontology is not configured for this workspace.");
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        send(response, 200, ontologyMaterial(await ontology.get(raw, controller.signal)));
        return;
      }
      if (path === "/api/jira" && options.jira) {
        if (!identity.canDeliverJira) throw new PermissionError("Jira commands require the local application session.");
        send(response, 200, await options.jira.execute({ workspaceId, actor, roles }, raw));
        return;
      }
      if (path === "/api/studio") {
        if (!options.studio) throw new RequestError(404, "The Model Studio is not configured.");
        await pending;
        const run = pending.then(() => options.studio!.execute(workspaceId, actor, roles, raw, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        pending = run.then(() => undefined, () => undefined);
        send(response, 200, await run);
        tickScheduler(workspaceId);
        return;
      }
      if (path === "/api/learning") {
        if (!options.learning) throw new RequestError(404, "Learning schedules are not configured.");
        const input = learningCommandSchema.parse(raw);
        await pending;
        if (input.action === "set") options.learning.set(workspaceId, actor, roles, { projectId: input.projectId, cadence: input.cadence, pattern: input.pattern, paused: input.paused });
        else if (input.action === "remove") options.learning.remove(workspaceId, actor, roles, input.projectId);
        else options.learning.runNow(workspaceId, actor, roles, input.projectId);
        tickScheduler(workspaceId);
        send(response, 200, options.learning.snapshot(workspaceId));
        return;
      }
      if (path === "/api/documents") {
        if (!options.documents) throw new RequestError(404, "The documentation portal is not configured.");
        await pending;
        // The engine validates the command and runs the pipeline or studio command as this person.
        const state = options.documents.execute(workspaceId, actor, roles, raw);
        tickScheduler(workspaceId);
        send(response, 200, state);
        return;
      }
      if (path === "/api/schedule") {
        if (!options.scheduler) throw new RequestError(404, "The scheduler is not configured.");
        if (!roles.includes("admin") && !roles.includes("author")) throw new PermissionError("An author or admin operates the scheduler.");
        const input = scheduleCommandSchema.parse(raw);
        if (input.action === "retry") options.scheduler.retry(workspaceId, input.jobId);
        else if (input.action === "cancel") options.scheduler.cancel(workspaceId, input.jobId);
        tickScheduler(workspaceId);
        send(response, 200, options.scheduler.snapshot(workspaceId));
        return;
      }
      if (path === "/api/bots" && options.bots) {
        send(response, 200, await options.bots.execute(workspaceId, actor, roles, raw, (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals));
        return;
      }
      if (options.workspaces && (path === "/api/workspaces" || path === "/api/workspaces/open" || path === "/api/workspaces/mcp-access")) {
        if (!roles.includes("admin")) throw new PermissionError("Only the local owner may manage workspaces.");
        if (path === "/api/workspaces") send(response, 201, options.workspaces.create(raw));
        else if (path === "/api/workspaces/open") send(response, 200, options.workspaces.open(raw));
        else {
          z.object({}).strict().parse(raw);
          if (!options.mcpAccess) throw new RequestError(404, "MCP access is unavailable.");
          send(response, 200, options.mcpAccess(workspaceId));
        }
        return;
      }
      if (path === "/api/pipeline" || path === "/api/pipeline-mcp") {
        if (!options.pipelines) throw new RequestError(404, "Pipelines are not configured.");
        await pending;
        const approvals = (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals;
        if (path === "/api/pipeline-mcp") await handlePipelineMcp(options.pipelines, workspaceId, actor, roles, approvals, request, response, raw, options.bots, options.jira, options.studio ? assistantDirectory(options.studio) : undefined, options.learning, options.documents);
        else send(response, 200, options.pipelines.execute(workspaceId, actor, roles, raw, approvals));
        tickScheduler(workspaceId);
        return;
      }
      if (path === "/api/mcp") {
        await pending;
        await handleWorkspaceMcp(options.context, workspaceId, request, response, raw, options.ontology?.(workspaceId));
        return;
      }
      if (path === "/api/chat" || path === "/api/base-chat") {
        const input = chatRequestSchema.parse(raw);
        const baseChat = path === "/api/base-chat";
        if (baseChat && input.profile) throw new RequestError(400, "Base chat does not accept an assistant profile. Open the assistant to use its approved configuration.");
        if (!options.chat) throw new RequestError(503, "Configure MAGENTIC_LLM_PROVIDER and MAGENTIC_LLM_CHAT_MODEL on the server, then restart to enable chat.");
        // A profile is resolved before any model is loaded. An unapproved,
        // retired or tampered release stops here with a plain reason.
        let persona: import("./chat.js").ChatPersona | undefined;
        if (input.profile) {
          if (!options.studio) throw new RequestError(404, "The Model Studio is not configured.");
          await pending;
          const resolved = options.studio.resolveProfile(workspaceId, input.profile);
          persona = { name: resolved.profile.name, instructions: resolved.profile.instructions,
            release: `${resolved.project.name} v${resolved.release.version} (${resolved.job.artifact?.label ?? "unknown"} artifact)` };
        }
        const selectedModel = input.model ?? options.chat.model;
        if (options.chat.modelOptions) {
          const choice = (await options.chat.modelOptions()).find((model) => model.id === selectedModel);
          if (!choice) throw new RequestError(400, "Choose a model from the model selector.");
          if (!choice.available) throw new RequestError(503, choice.detail);
        } else {
          let models: string[];
          try { models = options.chat.listModels ? await options.chat.listModels() : [options.chat.model]; }
          catch { throw new RequestError(503, "Could not reach the model service. Check its connection and refresh models."); }
          if (!models.includes(selectedModel)) throw new RequestError(400, "Choose a connected model from the model selector. Refresh the list if it changed.");
        }
        const key = JSON.stringify([workspaceId, actor]);
        if (activeChats.has(key) || activeChats.size >= 4) throw new RequestError(429, "A chat is already running. Wait for it to finish or stop it before trying again.");
        activeChats.add(key);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        response.once("close", () => controller.abort());
        const emit = (event: ChatEvent) => {
          if (!response.destroyed) response.write(JSON.stringify(event) + "\n");
        };
        try {
          await pending;
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
          emit({ type: "thinking", message: "Connecting to the model…" });
          const model = await untilAborted(options.chat.loadModel(selectedModel), controller.signal);
          if (baseChat) await runBaseChat(input.messages, model, controller.signal, emit);
          else await runWorkspaceAgent(options.context, workspaceId, actor, input.messages, model, controller.signal, emit, options.ontology?.(workspaceId), persona);
        } catch {
          // Provider errors can include endpoint details or credentials. The
          // browser receives a useful failure without echoing those internals.
          emit({ type: "error", message: controller.signal.aborted
            ? "The request stopped or exceeded two minutes. Try a shorter question."
            : "The model could not complete this request. Check its connection and model settings, then try again." });
        } finally {
          clearTimeout(timeout);
          activeChats.delete(key);
          response.end();
        }
        return;
      }
      const run = pending.then(async () => {
        if (path.startsWith("/api/email/")) {
          if (!options.email) throw new RequestError(404, "Email previews are not configured.");
          if (path === "/api/email/preferences") {
            options.email.setPreferences(workspaceId, actor, raw);
            return { saved: true };
          }
          if (path === "/api/email/invitations") {
            if (!roles.includes("admin")) throw new PermissionError("Only workspace admins may draft invitations.");
            try { return options.email.invite(workspaceId, actor, raw); }
            catch (error) {
              if (error instanceof z.ZodError) throw error;
              throw new RequestError(409, (error as Error).message);
            }
          }
          const message = /^\/api\/email\/([a-f0-9-]+)\/(viewed|cancel)$/.exec(path);
          if (!message) throw new RequestError(404, "Email action not found.");
          z.object({}).strict().parse(raw);
          if (message[2] === "cancel" && !roles.includes("admin")) throw new PermissionError("Only workspace admins may cancel invitations.");
          const changed = message[2] === "viewed"
            ? options.email.markViewed(workspaceId, actor, message[1]!)
            : options.email.cancelInvitation(workspaceId, message[1]!);
          if (!changed) throw new RequestError(404, "Message not found.");
          return { saved: true };
        }
        if (path === "/api/records") {
          const input = draftSchema.parse(raw);
          const existing = await options.context.store.get(workspaceId, input.definition.name);
          if (existing && input.expectedHash !== hashDefinition(existing.definition)) {
            throw new RequestError(409, "This definition changed. Refresh and review it again.");
          }
          return authorDraft(options.context, { workspaceId, actor, definition: input.definition });
        }
        const match = /^\/api\/records\/([a-z0-9-]+)\/(submit|approve|request-changes|retire)$/.exec(path);
        if (!match) throw new RequestError(404, "Not found.");
        const input = actionSchema.parse(raw);
        const name = match[1]!;
        const record = await options.context.store.get(workspaceId, name);
        if (!record) throw new RequestError(404, "Definition not found in this workspace.");
        if (input.expectedHash !== hashDefinition(record.definition)) {
          throw new RequestError(409, "This definition changed. Refresh and review it again.");
        }
        const actions = { submit, approve, "request-changes": requestChanges, retire };
        const action = match[2] as keyof typeof actions;
        const updated = await actions[action](options.context, {
          workspaceId, actor, name, ...(input.note ? { note: input.note } : {}),
        });
        if (options.email) {
          try {
            await options.email.capture({
              workspaceId, actor, agentName: name, at: updated.updatedAt,
              action: action === "submit" ? "submitted" : action === "approve" ? "approved"
                : action === "request-changes" ? "changes-requested" : "retired",
              definitionHash: hashDefinition(updated.definition), ...(input.note ? { note: input.note } : {}),
            }, updated, options.context.members!, options.context.workflow ?? DEFAULT_WORKFLOW);
          } catch {
            // The signature has already been saved. Calling it a failed
            // approval would invite a retry of an action that succeeded.
            return { ...updated, emailWarning: "The action was saved, but its email preview could not be created." };
          }
        }
        return updated;
      });
      pending = run.then(() => undefined, () => undefined);
      send(response, 200, await run);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof RequestError || error instanceof PipelineError || error instanceof JiraApiError || error instanceof StudioError || error instanceof DocumentError) send(response, error.status, { error: error.message });
      else if (error instanceof StudioStorageError) send(response, 409, { error: error.message });
      else if (error instanceof OntologyError) send(response, 502, { error: error.message });
      else if (error instanceof PermissionError) send(response, 403, { error: error.message });
      else if (error instanceof JiraError) send(response, 409, { error: error.message });
      else if (error instanceof TransitionError) send(response, 409, { error: error.message });
      else if (error instanceof z.ZodError) send(response, 400, { error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      else if (error instanceof SyntaxError) send(response, 400, { error: "Request body must be valid JSON." });
      else send(response, 500, { error: "The workspace could not complete this request." });
    }
  });
}

/**
 * The studio's part of the workspace snapshot. A studio file that fails its
 * integrity check must not take the rest of the workspace down with it, so
 * the failure travels as a message the page can show.
 */
function studioSnapshot(studio: ModelStudio | undefined, workspaceId: string): Record<string, unknown> {
  if (!studio) return {};
  try {
    return { studio: studio.snapshot(workspaceId) };
  } catch (error) {
    if (error instanceof StudioStorageError) return { studioError: error.message };
    throw error;
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new RequestError(413, "Definition is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
