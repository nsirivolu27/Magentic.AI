import type { WorkbenchSnapshot } from "./snapshot.js";
import type { PipelineConfig, PipelineRun } from "./pipeline.js";
import type { ScheduledJob } from "./scheduler.js";
import type { StudioSnapshot } from "./studio/engine.js";
import type { ChatbotProfile, ModelProject, ModelRelease } from "./studio/schema.js";
import type { GraphNode } from "./ui.js";
import { projectOf, releaseOf, releaseStatusLabel } from "./studio-model.js";
import { TOOL_NAMES } from "./flow-model.js";
import { addUsage, type TokenUsage } from "./model-usage.js";

/**
 * Agentic units: an assistant seen as a worker.
 *
 * An assistant is a chatbot on its own page and a stage agent inside the
 * workflow. This module joins the two: which assistants can work today,
 * which stages each one staffs, and how a workflow and its runs look as a
 * chain. Everything is derived from the snapshot. Browser code: no Node
 * imports.
 */

export type Stage = PipelineConfig["stages"][number];

export interface AgenticUnit {
  profile: ChatbotProfile;
  release?: ModelRelease;
  project?: ModelProject;
  /** Active profile on an approved release: the only kind that can work. */
  usable: boolean;
  /** Why it cannot work, in the studio's words. Empty when usable. */
  reason: string;
  /** Stages in the current workflow definition that name this assistant. */
  stages: Stage[];
  /** Open runs whose current stage this assistant staffs. */
  working: number;
  tools: string[];
  /** Tokens spent on drafts and bot attempts under this assistant, when providers reported them. */
  usage: TokenUsage | null;
}

export function usability(studio: StudioSnapshot, profile: ChatbotProfile): { usable: boolean; reason: string } {
  const release = releaseOf(studio, profile.releaseId);
  if (!release) return { usable: false, reason: "Its release is missing." };
  if (profile.status !== "active") return { usable: false, reason: "The assistant is disabled." };
  if (release.status !== "approved") return { usable: false, reason: `Its release is ${releaseStatusLabel(release).toLowerCase()}.` };
  return { usable: true, reason: "" };
}

export function agenticUnits(snapshot: WorkbenchSnapshot): AgenticUnit[] {
  const studio = snapshot.studio;
  if (!studio) return [];
  const stages = snapshot.pipelines?.config.stages ?? [];
  const runs = snapshot.pipelines?.runs ?? [];
  return studio.profiles.map((profile) => {
    const release = releaseOf(studio, profile.releaseId);
    const project = projectOf(studio, release?.projectId);
    const own = stages.filter((stage) => stage.assistantId === profile.id);
    const working = runs.filter((run) => (run.status === "running" || run.status === "paused" || run.status === "blocked") && run.config.stages[run.current]?.assistantId === profile.id).length;
    return { profile, ...(release ? { release } : {}), ...(project ? { project } : {}), ...usability(studio, profile), stages: own, working, tools: TOOL_NAMES, usage: unitUsage(snapshot, profile.id) };
  });
}

/** What one assistant has cost so far: every scheduler draft and bot attempt that ran under it. */
export function unitUsage(snapshot: WorkbenchSnapshot, assistantId: string): TokenUsage | null {
  let total: TokenUsage | null = null;
  for (const job of snapshot.schedule?.jobs ?? []) if (job.assistantId === assistantId) total = addUsage(total, job.usage);
  for (const attempt of snapshot.bots?.attempts ?? []) if (attempt.assistant?.id === assistantId) total = addUsage(total, attempt.tokenUsage ?? undefined);
  return total;
}

/** The unit a stage is staffed with, if any, and whether it can work. */
export function stageUnit(snapshot: WorkbenchSnapshot, stage: Stage): AgenticUnit | undefined {
  return stage.assistantId ? agenticUnits(snapshot).find((unit) => unit.profile.id === stage.assistantId) : undefined;
}

/** The workflow definition as a chain: one node per stage, its state from the unit that staffs it. */
export function stageNodes(snapshot: WorkbenchSnapshot): GraphNode[] {
  const stages = snapshot.pipelines?.config.stages ?? [];
  const units = agenticUnits(snapshot);
  return stages.map((stage) => {
    const unit = stage.assistantId ? units.find((item) => item.profile.id === stage.assistantId) : undefined;
    const gate = stage.approval ? "Review gate" : "No gate";
    const href = `#/workflows/${stage.id}`;
    if (!stage.assistantId) return { id: stage.id, label: stage.name, value: stage.agent, note: `By hand · ${gate}`, state: "pending", href };
    if (!unit) return { id: stage.id, label: stage.name, value: "Assistant missing", note: gate, state: "broken", href };
    if (!unit.usable) return { id: stage.id, label: stage.name, value: unit.profile.name, note: unit.reason.replace(/\.$/, ""), state: "broken", href };
    return { id: stage.id, label: stage.name, value: unit.profile.name, note: `${unit.working ? "Working · " : ""}${gate}`, state: unit.working ? "active" : "linked", href };
  });
}

/** The scheduler's job for a run's stage, if any. */
export function jobFor(jobs: ScheduledJob[] | undefined, run: PipelineRun, stageId: string): ScheduledJob | undefined {
  return jobs?.find((job) => job.runId === run.id && job.stageId === stageId);
}

/** One run as a chain: where it is, what each stage is waiting for, and what the assistant is doing about it. */
export function runNodes(run: PipelineRun, jobs?: ScheduledJob[]): GraphNode[] {
  return run.config.stages.map((stage, index) => {
    const progress = run.stages[index]!;
    const href = `#/workflows/${stage.id}`;
    const who = stage.assistantId ? "assistant" : stage.agent;
    if (progress.status === "complete") return { id: stage.id, label: stage.name, value: "Done", note: progress.outputBy || who, state: "linked", href };
    if (index !== run.current) return { id: stage.id, label: stage.name, value: "Waiting", note: who, state: "pending", href };
    if (run.status === "cancelled") return { id: stage.id, label: stage.name, value: "Cancelled", note: who, state: "broken", href };
    if (run.status === "blocked") return { id: stage.id, label: stage.name, value: "Blocked", note: who, state: "broken", href };
    if (run.status === "paused") return { id: stage.id, label: stage.name, value: "Paused", note: who, state: "blocked", href };
    if (progress.status === "awaiting_review") return { id: stage.id, label: stage.name, value: "In review", note: `${progress.approvals.length} of ${run.requiredApprovals} approved`, state: "active", href };
    const job = jobFor(jobs, run, stage.id);
    if (progress.draft) return { id: stage.id, label: stage.name, value: "Draft ready", note: `by ${progress.draft.by}`, state: "active", href };
    if (job?.status === "queued") return { id: stage.id, label: stage.name, value: "Queued", note: "assistant", state: "active", href };
    if (job?.status === "running") return { id: stage.id, label: stage.name, value: "Drafting", note: job.assistant || "assistant", state: "active", href };
    if (job?.status === "failed") return { id: stage.id, label: stage.name, value: "Draft failed", note: job.error.replace(/\.$/, ""), state: "broken", href };
    return { id: stage.id, label: stage.name, value: "Working", note: who, state: "active", href };
  });
}

export function runStatusLabel(run: PipelineRun): string {
  return ({ running: "Running", paused: "Paused", blocked: "Blocked", complete: "Complete", cancelled: "Cancelled" })[run.status];
}
