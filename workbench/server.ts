import { ZenfluenceError, type ZenfluenceDirectory } from "./zenfluence.js";
import { deploymentReport } from "./deployment-report.js";
import { SlackError, slackCommandSchema, type Slack } from "./slack.js";
import { newlyAssigned } from "./agent-configurables.js";
import { blockingTestReviews, passedCurrentTest } from "./agent-tests-model.js";
import { pipelineSchema, type PipelineConfig } from "./pipeline.js";
import { zenfluenceCommand } from "./zenfluence-api.js";
import { AutomationError, type AutomationRuntime } from "./automation-runtime.js";
import { ChatHistoryError } from "./chat-history.js";
import type { CompanyAccess } from "./company-access.js";
import { companyPage, companyClientScript } from "./company-page.js";
import { ChatAccessError, type ChatAccess } from "./chat-access.js";
import { handleChatMcp } from "./chat-mcp.js";
import { contextMessages } from "./chat-settings.js";
import { welcomePage } from "./welcome-view.js";
import type { AccountsConfig } from "./accounts.js";
import { accountPublicConfig, loginPage, accountClientScript } from "./account-portal.js";
import { BillingError, type Billing } from "./billing.js";
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
import type { AgentTestsEngine } from "./agent-tests.js";
import { handlePipelineMcp } from "./pipeline-mcp.js";

import { JiraApiError, type JiraRuntime } from "./jira-runtime.js";
import { JiraError } from "./jira.js";
import { StudioError, type ModelStudio } from "./studio/engine.js";
import { assistantDirectory } from "./assistant-resolver.js";
import type { Scheduler } from "./scheduler.js";
import { CADENCES, type LearningEngine } from "./learning-schedule.js";
import { DocumentError, type DocumentsEngine } from "./documents.js";
import { StudioStorageError } from "./studio/store.js";
import { buildAuditPackage, renderAuditPackage } from "./audit-package.js";

export interface WorkspaceIdentity {
  workspaceId: string; actor: string;
  // A standalone MCP credential must not inherit local delivery authority.
  canDeliverJira?: boolean;
  canRunAutomations?: boolean;
  canSendSlack?: boolean;
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
  accounts?: AccountsConfig;
  companies?: CompanyAccess;
  slack?: Slack;
  billing?: Billing;
  demo?: boolean;
  /** Handling marking for every page and export; see handling-marking.ts. */
  handling?: string;
  email?: EmailPortal;
  chat?: ChatConfiguration;
  chatAccess?: ChatAccess;
  ontology?: OntologyDirectory;
  pipelines?: PipelineEngine;
  jira?: JiraRuntime;
  automations?: AutomationRuntime;
  zenfluence?: ZenfluenceDirectory;
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
  /** Agent Studio tests: saved prompts run against a saved agent version, reviewed separately from execution. */
  agentTests?: AgentTestsEngine;
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
  const inspectDeployment = (workspaceId: string) => deploymentReport({
    workspaceId, mode: options.companies ? "company" : options.demo ? "demo" : "local",
    requiredApprovals: (options.context.workflow ?? DEFAULT_WORKFLOW).requiredApprovals,
    ...(options.pipelines ? { pipeline: options.pipelines.snapshot(workspaceId) } : {}),
    ...(options.studio ? { studio: options.studio } : {}),
    scheduler: !!options.scheduler,
    modelConfigured: !!options.chat?.model && options.chat.provider !== "unconfigured",
    repositoryWorker: !!options.bots, repositoryAttached: !!options.bots?.snapshot(workspaceId).project,
  });
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
      if (options.accounts) {
        const issuer = options.accounts.clerk.issuer;
        response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' ${issuer} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${issuer} https://*.protect.clerk.com; img-src 'self' https://img.clerk.com data:; frame-src https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      }
      if (options.companies && request.method === "GET" && (path === "/companies" || path === "/company-client.js")) {
        response.setHeader("Content-Type", path === "/companies" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
        response.end(path === "/companies" ? companyPage() : companyClientScript); return;
      }
      if (request.method === "GET" && path === "/welcome") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(welcomePage()); return;
      }
      if (request.method === "GET" && path === "/api/account/config") { send(response, 200, accountPublicConfig(options.accounts)); return; }
      if (request.method === "GET" && (path === "/login" || path === "/account-client.js")) {
        response.setHeader("Content-Type", path === "/login" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
        response.end(path === "/login" ? loginPage(options.accounts, new URL(request.url!, "http://localhost").searchParams.get("next")) : accountClientScript); return;
      }
      if (!path.startsWith("/api/")) {
        const asset = options.assets.get(path);
        if (request.method !== "GET" || !asset) throw new RequestError(404, "Not found.");
        response.setHeader("Content-Type", asset.type);
        response.end(asset.body);
        return;
      }
      if (options.companies && ["/api/companies", "/api/companies/open", "/api/workspaces"].includes(path)) {
        const actor = options.companies.actor(request);
        if (!actor) throw new RequestError(401, "Sign in to choose a company.");
        if (request.method === "GET" && path === "/api/companies") { send(response, 200, await options.companies.list(actor)); return; }
        if (request.method === "GET" && path === "/api/workspaces") { send(response, 200, await options.companies.listing(actor)); return; }
        if (request.method !== "POST" || path !== "/api/companies/open") throw new RequestError(405, "Use company setup to create a workspace.");
        if (!request.headers["content-type"]?.startsWith("application/json")) throw new RequestError(415, "Use application/json.");
        if (request.headers.origin && !options.accounts?.clerk.authorizedParties.includes(request.headers.origin)) throw new RequestError(403, "Use the company portal origin.");
        if (!request.headers.authorization?.startsWith("Bearer ") && !request.headers.origin) throw new RequestError(403, "Browser writes require the company portal origin.");
        send(response, 200, await options.companies.open(actor, await body(request))); return;
      }
      const identity = await options.authenticate(request);
      if (!identity) throw new RequestError(401, "Sign in with a workspace access token.");
      const { workspaceId, actor } = identity;
      const roles = await options.context.members!.rolesFor(workspaceId, actor);
      if (!roles.length) throw new PermissionError("You are not a member of this workspace.");
      if (request.method === "GET" && path === "/api/deployment-report") {
        if (new URL(request.url!, "http://localhost").search) throw new RequestError(400, "The deployment report uses the signed-in workspace; no query parameters are accepted.");
        await pending;
        send(response, 200, inspectDeployment(workspaceId)); return;
      }
      if (request.method === "GET" && path === "/api/zenfluence") {
        // The workspace id is included so an unconfigured page can show exactly
        // what to put in the connection file.
        send(response, 200, { workspaceId, ...(options.zenfluence?.(workspaceId)?.summary() ?? { configured: false }) }); return;
      }
      if (request.method === "GET" && path === "/api/automation-units" && options.automations) {
        send(response, 200, options.automations.inspect(workspaceId, Object.fromEntries(new URL(request.url!, "http://localhost").searchParams))); return;
      }
      if (request.method === "GET" && path === "/api/chat/history" && options.chatAccess) {
        send(response, 200, options.chatAccess.history.list(workspaceId, actor)); return;
      }
      if (request.method === "GET" && path === "/api/chat/access" && options.chatAccess) {
        send(response, 200, await options.chatAccess.summary(workspaceId, actor)); return;
      }
      if (request.method === "GET" && path === "/api/account") {
        const account = { managed: !!options.accounts, actor, workspaceId, canManageBilling: roles.includes("admin") };
        try { send(response, 200, { ...account, ...(account.canManageBilling && options.billing ? { billing: await options.billing.inspect(workspaceId) } : {}) }); }
        catch { send(response, 200, { ...account, billingError: "Could not verify billing with Stripe. Refresh to retry." }); }
        return;
      }
      if (request.method === "GET" && path === "/api/workspaces" && options.workspaces) {
        const listing = options.workspaces.list();
        if (options.accounts) {
          listing.workspaces = listing.workspaces.filter(entry => options.accounts!.members.some(member => member.workspaceId === entry.id && member.actor === actor));
          listing.lastWorkspaceId = workspaceId;
          listing.directory = "Managed workspace";
        }
        send(response, 200, listing); return;
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
          ...(options.handling ? { handling: options.handling } : {}),
          deployment: inspectDeployment(workspaceId),
          slack: options.slack?.summary(workspaceId, !!identity.canSendSlack && roles.includes("admin"))
            ?? { configured: false, ready: false, canSend: false, receipts: [] },
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
      if (path === "/api/agent-tests" && request.method === "GET" && options.agentTests) {
        send(response, 200, options.agentTests.snapshot(workspaceId)); return;
      }
      if (path === "/api/audit-package" && request.method === "GET" && options.pipelines) {
        // One run's chain of custody as a file. Any member may read it; it only contains what the run page already shows.
        const query = new URL(request.url!, "http://localhost").searchParams;
        const run = options.pipelines.snapshot(workspaceId).runs.find(item => item.id === query.get("run"));
        if (!run) throw new RequestError(404, "Run not found in this workspace.");
        const pkg = buildAuditPackage(run, { workspaceId, actor, ...(options.handling ? { handling: options.handling } : {}) });
        const markdown = query.get("format") === "markdown";
        response.writeHead(200, { "Content-Type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-package-${run.id}.${markdown ? "md" : "json"}"` });
        response.end(markdown ? renderAuditPackage(pkg) : JSON.stringify(pkg, null, 2)); return;
      }
      if ((path === "/api/chat/models" || path === "/api/agent-studio/models") && request.method === "GET") {
        // Personal chat connections do not grant credentials to workflow agents.
        if (path === "/api/chat/models" && options.chatAccess) {
          const config = await options.chatAccess.configuration(workspaceId, actor);
          const choices = await config.modelOptions!();
          send(response, 200, { models: choices.filter(model => model.available).map(model => model.id), options: choices,
            access: await options.chatAccess.summary(workspaceId, actor) }); return;
        }
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
      if ((path === "/api/mcp" || path === "/api/pipeline-mcp" || path === "/api/chat-mcp") && request.method !== "POST") {
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
      if (path === "/api/slack") {
        if (!identity.canSendSlack || !roles.includes("admin")) throw new PermissionError("Slack sending requires a company administrator session.");
        if (!options.slack) throw new RequestError(503, "Slack is not configured on this server.");
        const input = slackCommandSchema.parse(raw);
        if (input.action === "send") {
          send(response, 200, await options.slack.send(workspaceId, actor, input.previewId, input.expectedHash)); return;
        }
        const report = inspectDeployment(workspaceId);
        const audit = ["Magentic workflow audit snapshot", "Workspace: " + workspaceId, "Checked: " + report.checkedAt,
          "Workflow version: " + (report.workflow?.version ?? "Unavailable"),
          "Workflow hash: " + (report.workflow?.hash ?? "Unavailable"),
          "Readiness: " + report.status, "Stages: " + report.stages.length,
          "Blockers: " + (report.blockers.length + report.stages.reduce((n, stage) => n + stage.blockers.length, 0)),
          "This notification does not approve or execute work."].join("\n");
        send(response, 200, options.slack.preview(workspaceId, actor, input.kind, input.note, audit)); return;
      }
      if (path === "/api/zenfluence") {
        if (!options.zenfluence) throw new RequestError(404, "Zenfluence is not configured.");
        send(response, 200, await zenfluenceCommand(options.zenfluence, options.pipelines, { workspaceId, actor, roles }, raw)); return;
      }
      if (path === "/api/automation-units" && options.automations) {
        if (!identity.canRunAutomations) throw new PermissionError("Automation commands require the company application session.");
        send(response, 200, await options.automations.execute({ workspaceId, actor, roles }, raw)); return;
      }
      if (path === "/api/chat/history" && options.chatAccess) {
        try { send(response, 200, options.chatAccess.history.execute(workspaceId, actor, raw)); }
        catch (error) { if (error instanceof ChatHistoryError) throw new RequestError(error.status, error.message); throw error; }
        return;
      }
      if (path === "/api/chat/connections" && options.chatAccess) {
        await options.chatAccess.connect(workspaceId, actor, raw);
        send(response, 200, await options.chatAccess.summary(workspaceId, actor)); return;
      }
      if (path === "/api/chat/access" && options.chatAccess) {
        const input = z.object({ action: z.enum(["issue", "revoke"]) }).strict().parse(raw);
        if (input.action === "revoke") { options.chatAccess.revokeToken(workspaceId, actor); send(response, 200, { revoked: true }); }
        else send(response, 200, options.chatAccess.issueToken(workspaceId, actor));
        return;
      }
      if (path === "/api/chat-mcp" && options.chatAccess) {
        await handleChatMcp(options.chatAccess, workspaceId, actor, async () => (await options.context.members!.rolesFor(workspaceId, actor)).length > 0, request, response, raw);
        return;
      }
      if (path === "/api/account/billing") {
        if (!roles.includes("admin")) throw new PermissionError("Only a workspace administrator may manage billing.");
        if (!options.billing || !options.accounts) throw new RequestError(503, "Billing is not configured.");
        const origin = request.headers.origin;
        if (!origin || !options.accounts.clerk.authorizedParties.includes(origin)) throw new RequestError(403, "Use the configured application origin for billing.");
        send(response, 200, await options.billing.open(workspaceId, raw, origin)); return;
      }
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
      if (path === "/api/agent-tests" && options.agentTests) {
        send(response, 200, await options.agentTests.execute(workspaceId, actor, roles, raw));
        return;
      }
      if (options.workspaces && (path === "/api/workspaces" || path === "/api/workspaces/open" || path === "/api/workspaces/mcp-access")) {
        if (options.accounts) {
          if (path !== "/api/workspaces/open") throw new PermissionError("Managed workspace access is configured by the server administrator.");
          const selected = z.object({ workspaceId: z.string() }).strict().parse(raw);
          if (!(await options.context.members!.rolesFor(selected.workspaceId, actor)).length) throw new PermissionError("You are not a member of this workspace.");
          send(response, 200, { workspaceId: selected.workspaceId }); return;
        }
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
        if (path === "/api/pipeline-mcp") await handlePipelineMcp(options.pipelines, workspaceId, actor, roles, approvals, request, response, raw, options.bots, options.jira, options.studio ? assistantDirectory(options.studio) : undefined, options.learning, options.documents, options.automations, options.zenfluence);
        else {
          // The studio shows "test before assigning"; the server holds the same line.
          if (options.agentTests && isConfigure(raw)) {
            const tests = options.agentTests.snapshot(workspaceId);
            const assigned = newlyAssigned(options.pipelines.snapshot(workspaceId).config, raw.config);
            const rejected = assigned.filter(agent => blockingTestReviews(agent, tests).length);
            if (rejected.length) throw new RequestError(409, `Quality review blocks assignment of ${rejected.map(agent => agent.name).join(", ")}. Rerun the rejected cases and obtain a passing review, or revise the agent and test the new version.`);
            const untested = assigned.filter(agent => !passedCurrentTest(agent, tests));
            if (untested.length) throw new RequestError(409, `Run a passing test on the current version of ${untested.map(agent => agent.name).join(", ")} before assigning it to a stage.`);
          }
          send(response, 200, options.pipelines.execute(workspaceId, actor, roles, raw, approvals));
        }
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
        if (input.routing === "auto" && !options.chatAccess) throw new RequestError(503, "Automatic routing is not configured.");
        const prepared = await options.chatAccess?.prepare(workspaceId, actor, input);
        const chat = prepared?.config ?? options.chat;
        const outputLimit = prepared ? prepared.maxOutputTokens : input.maxOutputTokens;
        const selectedModel = prepared?.model ?? input.model ?? chat.model;
        if (chat.modelOptions) {
          const choice = (await chat.modelOptions()).find((model) => model.id === selectedModel);
          if (!choice) throw new RequestError(400, "Choose a model from the model selector.");
          if (!choice.available) throw new RequestError(503, choice.detail);
          if (outputLimit !== undefined && !choice.outputLimit) throw new RequestError(400, "This model uses the provider default output cap.");
        } else {
          let models: string[];
          try { models = chat.listModels ? await chat.listModels() : [chat.model]; }
          catch { throw new RequestError(503, "Could not reach the model service. Check its connection and refresh models."); }
          if (outputLimit !== undefined && !chat.outputLimit) throw new RequestError(400, "This model uses the provider default output cap.");
          if (!models.includes(selectedModel)) throw new RequestError(400, "Choose a connected model from the model selector. Refresh the list if it changed.");
        }
        const key = JSON.stringify([workspaceId, actor]);
        if (activeChats.has(key) || activeChats.size >= 4) throw new RequestError(429, "A chat is already running. Wait for it to finish or stop it before trying again.");
        const releaseAccess = options.chatAccess?.acquire(workspaceId, actor);
        activeChats.add(key);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        response.once("close", () => controller.abort());
        const started = performance.now();
        const messages = contextMessages(input.messages, input.history ?? "all");
        const emit = (event: ChatEvent) => {
          const result = event.type === "answer" && input.metrics ? { ...event, elapsedMs: Math.round(performance.now() - started) } : event;
          if (!response.destroyed) response.write(JSON.stringify(result) + "\n");
        };
        // Long CPU inference can leave the stream idle. Opt-in clients receive
        // progress so an intermediary need not mistake a quiet model for a lost connection.
        const heartbeat = input.metrics ? setInterval(() => {
          if (response.headersSent && !controller.signal.aborted) emit({ type: "thinking", message: "Still working…" });
        }, 15_000) : undefined;
        try {
          await pending;
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
          emit({ type: "thinking", message: "Connecting to the model…" });
          if (prepared?.route) emit({ type: "route", ...prepared.route });
          const model = await untilAborted(chat.loadModel(selectedModel, outputLimit === undefined ? undefined : { maxOutputTokens: outputLimit }), controller.signal);
          if (baseChat) await runBaseChat(messages, model, controller.signal, emit);
          else await runWorkspaceAgent(options.context, workspaceId, actor, messages, model, controller.signal, emit, options.ontology?.(workspaceId), persona, { pipelines: options.pipelines, documents: options.documents });
        } catch (error) {
          // Provider errors can include endpoint details or credentials. The
          // browser receives a useful failure without echoing those internals.
          emit({ type: "error", message: error instanceof ChatAccessError ? error.message : controller.signal.aborted
            ? "The request stopped or exceeded two minutes. Try a shorter question."
            : "The model could not complete this request. Check its connection and model settings, then try again." });
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          activeChats.delete(key);
          releaseAccess?.();
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
      if (error instanceof SlackError || error instanceof ZenfluenceError || error instanceof AutomationError || error instanceof ChatAccessError || error instanceof BillingError || error instanceof RequestError || error instanceof PipelineError || error instanceof JiraApiError || error instanceof StudioError || error instanceof DocumentError) send(response, error.status, { error: error.message });
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

/** A configure command carries a full pipeline config; anything else is left to the engine to validate. */
function isConfigure(raw: unknown): raw is { action: "configure"; config: PipelineConfig } {
  if (!raw || typeof raw !== "object" || (raw as { action?: unknown }).action !== "configure") return false;
  return pipelineSchema.safeParse((raw as { config?: unknown }).config).success;
}
