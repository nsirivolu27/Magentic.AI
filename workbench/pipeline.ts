import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { materialsSchema, type Material } from "./materials.js";
import { agentConfigurableSchema } from "./agent-configurables.js";
import { botPolicySchema } from "./bot-schema.js";
import type { Role } from "../registry/roles.js";

const text = z.string().trim().min(1).max(4000);
const stageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), name: z.string().trim().min(1).max(80),
  agent: z.string().trim().min(1).max(80), instructions: text,
  model: z.string().trim().min(1).max(200), context: z.string().trim().max(2000),
  bot: botPolicySchema.optional(),
  /** An approved Model Studio assistant that staffs this stage. Unset means the named agent works by hand. */
  assistantId: z.string().uuid().optional(),
  approval: z.boolean(), jiraStatus: z.string().trim().min(1).max(80),
}).strict();
export const pipelineSchema = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(500),
  jira: z.object({ enabled: z.boolean(), project: z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/), issueType: z.string().trim().min(1).max(80) }).strict(),
  stages: z.array(stageSchema).min(1).max(12),
  configurables: z.array(agentConfigurableSchema).max(30).optional(),
}).strict().superRefine((value, context) => {
  const agentIds = new Set<string>();
  value.configurables?.forEach((agent, index) => {
    if (agentIds.has(agent.id)) context.addIssue({ code: "custom", path: ["configurables", index, "id"], message: "Agent IDs must be unique." });
    agentIds.add(agent.id);
  });
  const ids = new Set<string>();
  value.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) context.addIssue({ code: "custom", path: ["stages", index, "id"], message: "Stage IDs must be unique." });
    ids.add(stage.id);
  });
});
export type PipelineConfig = z.infer<typeof pipelineSchema>;
/** The starting workflow. Defined with the other templates so the browser can read it without Node modules. */
import { DEVELOPMENT_WORKFLOW } from "./workflow-templates.js";
export const DEFAULT_PIPELINE: PipelineConfig = DEVELOPMENT_WORKFLOW;
export const pipelineCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), expectedVersion: z.number().int().min(1), config: pipelineSchema }).strict(),
  z.object({ action: z.literal("start"), requestId: z.string().uuid(), title: z.string().trim().min(3).max(160), brief: text,
    materials: materialsSchema.optional(), issueKey: z.string().regex(/^[A-Z][A-Z0-9]{1,19}-[1-9][0-9]*$/).optional() }).strict(),
  z.object({ action: z.enum(["complete", "approve", "pause", "resume", "block", "retry", "cancel"]),
    runId: z.string().uuid(), expectedRevision: z.number().int().min(1), note: text.optional() }).strict(),
  /** Replace the reference material a running workflow carries. The owner or an admin; the run keeps its own frozen copy. */
  z.object({ action: z.literal("materials"), runId: z.string().uuid(), expectedRevision: z.number().int().min(1), materials: materialsSchema }).strict(),
]);
export type PipelineCommand = z.infer<typeof pipelineCommandSchema>;
export interface PipelineEvent { id: string; at: string; actor: string; stage: string; action: string; detail: string }
export interface JiraPreview { id: string; eventId: string; action: "create_issue" | "update_issue"; project: string; issueType: string;
  issueKey: string | null; summary: string; status: string; comment: string; delivery: "preview" }
/** What an assistant prepared for a stage. A person turns it into the stage's output, or ignores it. */
export interface StageDraft { text: string; hash: string; by: string; jobId: string; at: string }
export interface StageRun { status: "pending" | "active" | "awaiting_review" | "complete"; output: string; outputHash: string;
  outputBy: string; approvals: string[]; completedAt?: string; draft?: StageDraft }
export interface PipelineRun {
  id: string; requestId: string; workspaceId: string; owner: string; title: string; brief: string; issueKey: string | null;
  config: PipelineConfig; version: number; revision: number; requiredApprovals: number; createdAt: string; updatedAt: string;
  status: "running" | "paused" | "blocked" | "complete" | "cancelled"; current: number; stages: StageRun[];
  events: PipelineEvent[]; jira: JiraPreview[]; materials?: Material[];
}
/** Where this workspace's state lives. "file" means it survives a restart. */
export type StorageMode = "memory" | "file";
export interface PipelineSnapshot { config: PipelineConfig; version: number; runs: PipelineRun[]; storage: StorageMode; jiraDelivery: "preview" }
export class PipelineError extends Error { constructor(readonly status: number, message: string) { super(message); } }
/**
 * Checks the engine cannot make on its own. The assistant guard answers
 * "can this assistant work right now?" with a reason when it cannot, so a
 * stage is never bound to, or started with, a disabled assistant or a
 * retired release. The Model Studio owns that answer; the engine only asks.
 */
export interface PipelineGuards { assistant?(workspace: string, assistantId: string): string | undefined }
/** A draft arriving from the scheduler. Not a command: it is never accepted over HTTP. */
export interface DraftInput { runId: string; stageId: string; expectedRevision: number; text: string; by: string; jobId: string }
export interface PipelineEngine {
  snapshot(workspace: string): PipelineSnapshot;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number): PipelineSnapshot;
  /** Attach an assistant's draft to the active stage of a running workflow. The stage stays active; only a person completes it. */
  draft(workspace: string, input: DraftInput): PipelineSnapshot;
}

/**
 * What a persistent engine needs from storage. Kept to two methods so the
 * engine cannot grow a dependency on how storage works.
 */
export interface PipelinePersistence {
  read(workspace: string): { config: PipelineConfig; version: number; runs: PipelineRun[] } | undefined;
  commit(workspace: string, state: { config: PipelineConfig; version: number; runs: PipelineRun[] }): void;
}

// Runs own their configuration so a later edit cannot silently change a gate
// or redirect a Jira action that someone has already reviewed.
export function memoryPipelines(guards: PipelineGuards = {}): PipelineEngine {
  return createEngine(undefined, guards);
}

/**
 * The same engine, writing through to durable storage.
 *
 * Deliberately not a second implementation: every transition rule below is
 * shared, so a gate cannot be enforced in one engine and missed in the other.
 * The only difference is where state comes from and that a command is
 * persisted before its result is visible.
 */
export function filePipelines(store: PipelinePersistence, guards: PipelineGuards = {}): PipelineEngine {
  return createEngine(store, guards);
}

function createEngine(persistence: PipelinePersistence | undefined, guards: PipelineGuards): PipelineEngine {
  const mode: StorageMode = persistence ? "file" : "memory";
  const workspaces = new Map<string, { config: PipelineConfig; version: number; runs: PipelineRun[] }>();
  function state(workspace: string) {
    let value = workspaces.get(workspace);
    if (!value) {
      // A persistent engine asks storage first. A read that throws is a
      // corrupt or unreadable workspace and must reach the caller rather
      // than quietly becoming a new empty one.
      const stored = persistence?.read(workspace);
      value = stored ? { config: stored.config, version: stored.version, runs: stored.runs }
        : { config: structuredClone(DEFAULT_PIPELINE), version: 1, runs: [] };
      workspaces.set(workspace, value);
    }
    return value;
  }
  function snapshot(workspace: string): PipelineSnapshot {
    return structuredClone({ ...state(workspace), storage: mode, jiraDelivery: "preview" });
  }
  function event(run: PipelineRun, actor: string, action: string, detail: string): PipelineEvent {
    const item = { id: randomUUID(), at: new Date().toISOString(), actor, stage: run.config.stages[run.current]!.id, action, detail };
    run.events.push(item); run.updatedAt = item.at; return item;
  }
  function jira(run: PipelineRun, item: PipelineEvent, status: string) {
    if (!run.config.jira.enabled) return;
    run.jira.push({ id: randomUUID(), eventId: item.id, action: item.action === "started" && !run.issueKey ? "create_issue" : "update_issue",
      project: run.config.jira.project, issueType: run.config.jira.issueType, issueKey: run.issueKey,
      summary: run.title, status, comment: `${item.stage}: ${item.detail}`, delivery: "preview" });
  }
  /** Every bound assistant must be usable, or the stage that names it is refused. */
  function checkAssistants(workspace: string, config: PipelineConfig): void {
    for (const stage of config.stages) {
      if (!stage.assistantId) continue;
      if (!guards.assistant) throw new PipelineError(409, `Stage "${stage.name}" names an assistant, but Model Studio is not configured here.`);
      const reason = guards.assistant(workspace, stage.assistantId);
      if (reason) throw new PipelineError(409, `Stage "${stage.name}": ${reason}`);
    }
  }
  function advance(run: PipelineRun, actor: string) {
    const stage = run.stages[run.current]!;
    stage.status = "complete"; stage.completedAt = new Date().toISOString();
    const item = event(run, actor, "stage_completed", stage.output);
    jira(run, item, run.config.stages[run.current]!.jiraStatus);
    if (run.current === run.stages.length - 1) { run.status = "complete"; event(run, actor, "run_completed", "All stages completed."); }
    else { run.current++; run.stages[run.current]!.status = "active"; event(run, actor, "handoff", "Previous outputs are available to this stage."); }
  }
  return {
    snapshot,
    draft(workspace, input) {
      const live = state(workspace);
      const value = persistence ? structuredClone(live) : live;
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "Run not found in this workspace.");
      if (run.revision !== input.expectedRevision) throw new PipelineError(409, "This run changed. Refresh before acting.");
      const index = run.config.stages.findIndex(stage => stage.id === input.stageId);
      if (run.status !== "running" || index !== run.current || run.stages[index]!.status !== "active") throw new PipelineError(409, "That stage is no longer active.");
      const text = input.text.trim().slice(0, 4000);
      if (!text) throw new PipelineError(400, "A draft needs text.");
      run.stages[index]!.draft = { text, hash: createHash("sha256").update(text).digest("hex"), by: input.by, jobId: input.jobId, at: new Date().toISOString() };
      event(run, input.by, "draft_ready", `Draft prepared by ${input.by}. A person completes the stage with it or writes their own output.`);
      run.revision++;
      if (persistence) { persistence.commit(workspace, { ...persistence.read(workspace), ...value }); workspaces.set(workspace, value); }
      return snapshot(workspace);
    },
    execute(workspace, actor, roles, raw, requiredApprovals) {
      if (!roles.length) throw new PipelineError(403, "Workspace membership is required.");
      const input = pipelineCommandSchema.parse(raw);
      // A working copy. Every mutation below lands here, and the live state
      // is replaced only once the command has succeeded and been persisted,
      // so a failed commit cannot leave a change visible in memory.
      const live = state(workspace);
      const value = persistence ? structuredClone(live) : live;
      const publish = (): PipelineSnapshot => {
        if (persistence) {
          // Jira can settle while this engine holds an older snapshot. Preserve
          // the other fields from disk while committing only pipeline changes.
          persistence.commit(workspace, { ...persistence.read(workspace), ...value });
          workspaces.set(workspace, value);
        }
        return snapshot(workspace);
      };
      const admin = roles.includes("admin");
      if (input.action === "configure") {
        if (!admin) throw new PipelineError(403, "An admin must change pipeline configuration.");
        if (input.expectedVersion !== value.version) throw new PipelineError(409, "Configuration changed. Refresh before saving.");
        checkAssistants(workspace, input.config);
        value.config = structuredClone(input.config); value.version++; return publish();
      }
      if (input.action === "start") {
        if (!admin && !roles.includes("author")) throw new PipelineError(403, "An author or admin must start a run.");
        const existing = value.runs.find(run => run.requestId === input.requestId);
        if (existing) {
          if (existing.owner !== actor || existing.title !== input.title || existing.brief !== input.brief || existing.issueKey !== (input.issueKey ?? null)
            || JSON.stringify(existing.materials ?? []) !== JSON.stringify(input.materials ?? [])) {
            throw new PipelineError(409, "This request ID was already used for different work.");
          }
          return publish();
        }
        if (value.runs.length >= 100) throw new PipelineError(409, "This in-memory workspace holds at most 100 runs.");
        if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) throw new PipelineError(400, "Invalid approval policy.");
        if (input.issueKey && !input.issueKey.startsWith(value.config.jira.project + "-")) throw new PipelineError(400, "The issue key must match the configured Jira project.");
        // A run freezes its configuration, so an assistant that cannot work
        // today must be fixed before the run exists rather than found later.
        checkAssistants(workspace, value.config);
        const at = new Date().toISOString();
        const run: PipelineRun = { id: randomUUID(), requestId: input.requestId, workspaceId: workspace, owner: actor,
          title: input.title, brief: input.brief, ...(input.materials ? { materials: structuredClone(input.materials) } : {}), issueKey: input.issueKey ?? null, config: structuredClone(value.config),
          version: value.version, revision: 1, requiredApprovals, createdAt: at, updatedAt: at, status: "running", current: 0,
          stages: value.config.stages.map((_, index) => ({ status: index ? "pending" : "active", output: "", outputHash: "", outputBy: "", approvals: [] })), events: [], jira: [] };
        const item = event(run, actor, "started", input.brief); jira(run, item, run.config.stages[0]!.jiraStatus);
        value.runs.unshift(run); return publish();
      }
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "Run not found in this workspace.");
      if (run.revision !== input.expectedRevision) throw new PipelineError(409, "This run changed. Refresh before acting.");
      if (run.status === "complete" || run.status === "cancelled") throw new PipelineError(409, "This run is closed.");
      if (run.events.length >= 500) throw new PipelineError(409, "This run reached its event limit. Start a new run.");
      const stage = run.stages[run.current]!;
      if (input.action === "approve") {
        if (!admin && !roles.includes("approver")) throw new PipelineError(403, "A reviewer must approve this handoff.");
        if (actor === stage.outputBy || actor === run.owner) throw new PipelineError(403, "The run owner and output author cannot approve this handoff.");
        if (run.status !== "running" || stage.status !== "awaiting_review") throw new PipelineError(409, "This stage is not awaiting review.");
        if (stage.approvals.includes(actor)) throw new PipelineError(409, "You already approved this output.");
        if (createHash("sha256").update(stage.output).digest("hex") !== stage.outputHash) throw new PipelineError(409, "The reviewed output changed.");
        stage.approvals.push(actor); event(run, actor, "approved", `Approved output ${stage.outputHash}.`);
        if (stage.approvals.length >= run.requiredApprovals) advance(run, actor);
      } else {
        if (!admin && (actor !== run.owner || !roles.includes("author"))) throw new PipelineError(403, "The run owner or an admin must perform this action.");
        if (input.action === "materials") {
          // Closed runs were refused above; any open run may change its reference material.
          run.materials = structuredClone(input.materials);
          event(run, actor, "materials", input.materials.length ? `Reference material: ${input.materials.map((item) => item.title).join(", ")}.` : "Reference material cleared.");
        } else if (input.action === "complete") {
          if (run.status !== "running" || stage.status !== "active") throw new PipelineError(409, "This stage cannot be completed now.");
          if (!input.note) throw new PipelineError(400, "Provide output or evidence for the handoff.");
          stage.output = input.note; stage.outputBy = actor;
          stage.outputHash = createHash("sha256").update(input.note).digest("hex");
          if (run.config.stages[run.current]!.approval) { stage.status = "awaiting_review"; event(run, actor, "review_requested", input.note); }
          else advance(run, actor);
        } else if (input.action === "pause" && run.status === "running") { run.status = "paused"; event(run, actor, "paused", input.note ?? "Run paused."); }
        else if (input.action === "resume" && run.status === "paused") { run.status = "running"; event(run, actor, "resumed", "Run resumed."); }
        else if (input.action === "block" && run.status === "running" && stage.status === "active") {
          if (!input.note) throw new PipelineError(400, "Describe the blocker.");
          run.status = "blocked"; event(run, actor, "blocked", input.note);
        } else if (input.action === "retry" && run.status === "blocked") { run.status = "running"; event(run, actor, "retried", "Manual stage reopened; no external action repeated."); }
        else if (input.action === "cancel") { run.status = "cancelled"; event(run, actor, "cancelled", input.note ?? "Run cancelled."); }
        else throw new PipelineError(409, "This action is not available in the current state.");
      }
      run.revision++; return publish();
    },
  };
}
