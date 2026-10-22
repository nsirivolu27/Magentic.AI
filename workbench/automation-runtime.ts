import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setting } from "../env.js";
import type { Role } from "../registry/roles.js";
import type { PipelineEngine } from "./pipeline.js";
import type { WorkspaceStore } from "./storage.js";
import { findSecretKinds } from "./studio/dataset.js";
import { automationCommandSchema, automationConfigSchema, automationInspectionSchema, automationOutcomeSchema,
  type AutomationUnit, type AutomationRecord, type AutomationOutcome } from "./automation-schema.js";

export function loadAutomationUnits(): AutomationUnit[] {
  const file = setting("MAGENTIC_AUTOMATION_UNITS_FILE")?.trim();
  if (!file) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("MAGENTIC_AUTOMATION_UNITS_FILE must name a readable JSON file."); }
  const parsed = automationConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`MAGENTIC_AUTOMATION_UNITS_FILE: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data.units;
}

export class AutomationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface AutomationPayload {
  requestId: string; workspaceId: string; runId: string; stageId: string; outputHash: string; output: string;
}
export type AutomationInvoker = (unit: AutomationUnit, payload: AutomationPayload) => Promise<AutomationOutcome>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function createAutomationRuntime(pipelines: PipelineEngine, store: Pick<WorkspaceStore, "read" | "commit">,
  rawUnits: readonly AutomationUnit[], invoke: AutomationInvoker) {
  const units = automationConfigSchema.parse({ units: rawUnits }).units;
  const active = new Map<string, Promise<unknown>>();
  let closed = false;
  const records = (workspace: string) => store.read(workspace)?.automationActions ?? [];
  function save(workspace: string, record: AutomationRecord) {
    const state = store.read(workspace);
    if (!state) throw new AutomationError(404, "Workspace not found.");
    const current = state.automationActions ?? [];
    store.commit(workspace, { ...state, automationActions: [...current.filter(item => item.id !== record.id), record] });
  }
  function intent(workspace: string, input: { unitId: string; runId: string; stageId: string }) {
    const unit = units.find(item => item.workspaceId === workspace && item.id === input.unitId);
    if (!unit) throw new AutomationError(404, "Automation unit not found in this workspace.");
    if (!unit.stages.includes(input.stageId)) throw new AutomationError(403, "This unit is not allowed on that stage.");
    const run = pipelines.snapshot(workspace).runs.find(item => item.id === input.runId && item.workspaceId === workspace);
    if (!run) throw new AutomationError(404, "Run not found in this workspace.");
    if (run.status !== "running" && run.status !== "complete") throw new AutomationError(409, "Resume the workflow before invoking a unit.");
    const index = run.config.stages.findIndex(stage => stage.id === input.stageId);
    const stage = run.stages[index];
    if (!stage || !run.config.stages[index]?.approval || stage.status !== "complete") throw new AutomationError(409, "Complete an independently reviewed stage first.");
    const reviewers = new Set(stage.approvals.filter(actor => actor !== run.owner && actor !== stage.outputBy));
    if (reviewers.size < Math.max(1, run.requiredApprovals) || digest(stage.output) !== stage.outputHash) throw new AutomationError(409, "The stage output no longer meets its approval policy.");
    if (findSecretKinds(stage.output).length) throw new AutomationError(409, "The stage output contains a possible credential. Remove it and review the output again.");
    const dedupeKey = digest(JSON.stringify([workspace, unit.id, run.id, input.stageId]));
    const payload: AutomationPayload = { requestId: dedupeKey, workspaceId: workspace, runId: run.id,
      stageId: input.stageId, outputHash: stage.outputHash, output: stage.output };
    const intentHash = digest(JSON.stringify({ unit, payload }));
    return { unit, payload, intentHash, dedupeKey };
  }
  return {
    inspect(workspace: string, raw: unknown = {}) {
      const { runId } = automationInspectionSchema.parse(raw);
      if (runId && !pipelines.snapshot(workspace).runs.some(run => run.id === runId)) throw new AutomationError(404, "Run not found in this workspace.");
      return { units: units.filter(unit => unit.workspaceId === workspace).map(({ profile, ...unit }) => unit),
        actions: records(workspace).filter(item => !runId || item.runId === runId) };
    },
    async execute(identity: { workspaceId: string; actor: string; roles: readonly Role[] }, raw: unknown) {
      if (closed) throw new AutomationError(503, "Automation units are shutting down.");
      if (!identity.roles.includes("admin")) throw new AutomationError(403, "A workspace admin must review automation actions.");
      const input = automationCommandSchema.parse(raw);
      const { unit, payload, intentHash, dedupeKey } = intent(identity.workspaceId, input);
      if (input.action === "preview") return { unit, payload, expectedIntentHash: intentHash };
      if (input.expectedIntentHash !== intentHash) throw new AutomationError(409, "The unit or payload changed. Preview and review it again.");
      if (!unit.enabled) throw new AutomationError(503, "This unit is disabled in the server configuration.");
      const existing = records(identity.workspaceId).find(item => item.dedupeKey === dedupeKey);
      if (existing) {
        if (existing.intentHash !== intentHash) throw new AutomationError(409, "This stage already has a different automation intent.");
        return { action: existing, dispatched: false };
      }
      if (active.has(identity.workspaceId) || active.size >= 4) throw new AutomationError(429, "An automation is running. Wait for it to finish.");
      if (records(identity.workspaceId).length >= 500) throw new AutomationError(409, "This workspace reached its automation history limit.");
      const started = Date.now();
      const record: AutomationRecord = { id: randomUUID(), unitId: unit.id, runId: input.runId, stageId: input.stageId,
        workspaceId: identity.workspaceId, intentHash, dedupeKey, outputHash: payload.outputHash,
        authorizedBy: identity.actor, startedAt: new Date(started).toISOString(), status: "running" };
      // Save the claim first. A crash after dispatch must never look safe to retry.
      save(identity.workspaceId, record);
      const pending = (async () => {
        let outcome: AutomationOutcome;
        try { outcome = automationOutcomeSchema.parse(await invoke(unit, payload)); }
        catch { outcome = { status: "uncertain" }; }
        const settled = { ...record, ...outcome, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started };
        save(identity.workspaceId, settled);
        return { action: settled, dispatched: true };
      })();
      active.set(identity.workspaceId, pending);
      try { return await pending; } finally { active.delete(identity.workspaceId); }
    },
    // Run only before serving requests; a live claim belongs to its current worker.
    recover(workspace: string) {
      for (const record of records(workspace)) if (record.status === "running") save(workspace, {
        ...record, status: "uncertain", finishedAt: new Date().toISOString(),
      });
    },
    async close() { closed = true; await Promise.allSettled([...active.values()]); },
  };
}
export type AutomationRuntime = ReturnType<typeof createAutomationRuntime>;
