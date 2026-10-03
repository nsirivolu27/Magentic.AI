import type { Role } from "../registry/roles.js";
import type { StudioSnapshot } from "./studio/engine.js";
import type { ChatbotProfile, Dataset, EvaluationRun, ModelProject, ModelRelease, StudioEvent, TrainingConfig, TrainingJob } from "./studio/schema.js";
import type { StepState } from "./ui.js";

/**
 * What the pages need to know about Model Studio records, derived once.
 *
 * The engine stores facts: a job succeeded, a release has two signatures.
 * The pages need answers: which phase is this project in, what blocks it,
 * who can act. Every answer here is computed from the records alone, so a
 * page can never show a state the data does not support. Browser code: no
 * Node imports.
 */

export type Phase = "define" | "data" | "train" | "evaluate" | "approve" | "use";
/** Phases are route segments; their labels are the node each one produces. */
export const PHASES: readonly [Phase, string][] = [
  ["define", "Recipe"], ["data", "Dataset"], ["train", "Candidate"], ["evaluate", "Evaluation"], ["approve", "Release"], ["use", "Assistant"],
];
export const PHASE_LABEL = Object.fromEntries(PHASES) as Record<Phase, string>;

export interface Viewer { actor: string; roles: readonly Role[]; admin: boolean; author: boolean; approver: boolean }
export function viewerOf(actor: string, roles: readonly Role[]): Viewer {
  const admin = roles.includes("admin");
  return { actor, roles, admin, author: admin || roles.includes("author"), approver: admin || roles.includes("approver") };
}

// ----------------------------------------------------------------- lookups

export function projectOf(studio: StudioSnapshot, id: string | undefined): ModelProject | undefined {
  return studio.projects.find((project) => project.id === id);
}
export function datasetsOf(studio: StudioSnapshot, project: ModelProject): Dataset[] {
  return studio.datasets.filter((dataset) => dataset.projectId === project.id);
}
export function jobsOf(studio: StudioSnapshot, project: ModelProject): TrainingJob[] {
  return studio.jobs.filter((job) => job.projectId === project.id);
}
export function evaluationsOf(studio: StudioSnapshot, project: ModelProject): EvaluationRun[] {
  return studio.evaluations.filter((evaluation) => evaluation.projectId === project.id);
}
export function releasesOf(studio: StudioSnapshot, project: ModelProject): ModelRelease[] {
  return studio.releases.filter((release) => release.projectId === project.id);
}
export function configOf(studio: StudioSnapshot, job: TrainingJob | undefined): TrainingConfig | undefined {
  return job ? studio.configs.find((config) => config.id === job.configId) : undefined;
}
export function jobOf(studio: StudioSnapshot, id: string | undefined): TrainingJob | undefined {
  return studio.jobs.find((job) => job.id === id);
}
export function evaluationOf(studio: StudioSnapshot, id: string | undefined): EvaluationRun | undefined {
  return studio.evaluations.find((evaluation) => evaluation.id === id);
}
export function releaseOf(studio: StudioSnapshot, id: string | undefined): ModelRelease | undefined {
  return studio.releases.find((release) => release.id === id);
}
export function profilesOf(studio: StudioSnapshot, release: ModelRelease): ChatbotProfile[] {
  return studio.profiles.filter((profile) => profile.releaseId === release.id);
}
/** The project a release, evaluation, job, dataset or profile belongs to. */
export function projectForEntity(studio: StudioSnapshot, entity: StudioEvent["entity"], id: string): ModelProject | undefined {
  const projectId = entity === "project" ? id
    : entity === "dataset" ? studio.datasets.find((item) => item.id === id)?.projectId
    : entity === "config" ? studio.configs.find((item) => item.id === id)?.projectId
    : entity === "job" ? jobOf(studio, id)?.projectId
    : entity === "evaluation" ? evaluationOf(studio, id)?.projectId
    : entity === "release" ? releaseOf(studio, id)?.projectId
    : releaseOf(studio, studio.profiles.find((item) => item.id === id)?.releaseId)?.projectId;
  return projectOf(studio, projectId);
}
export function eventsFor(studio: StudioSnapshot, project: ModelProject): StudioEvent[] {
  return studio.events.filter((event) => projectForEntity(studio, event.entity, event.entityId)?.id === project.id);
}

// ------------------------------------------------------------------ phases

export interface PhaseReport {
  current: Phase;
  states: Record<Phase, StepState>;
  /** The one sentence that explains the current phase, if it is not simply ready. */
  blocking?: string;
  /** Why each incomplete phase is where it is, current or not. */
  reasons: Partial<Record<Phase, string>>;
  /** The latest thing that happened to the project. */
  lastEvent?: StudioEvent;
}

const latest = <T>(items: T[]): T | undefined => items[items.length - 1];

export function phaseReport(studio: StudioSnapshot, project: ModelProject): PhaseReport {
  const datasets = datasetsOf(studio, project);
  const jobs = jobsOf(studio, project);
  const evaluations = evaluationsOf(studio, project);
  const releases = releasesOf(studio, project);
  const validDataset = datasets.some((dataset) => dataset.status === "valid");
  const lastDataset = latest(datasets);
  const succeeded = jobs.some((job) => job.status === "succeeded");
  const running = jobs.some((job) => job.status === "running");
  const lastJob = latest(jobs);
  const passed = evaluations.some((evaluation) => evaluation.passed);
  const lastEvaluation = latest(evaluations);
  const unevaluated = jobs.some((job) => job.status === "succeeded" && !evaluations.some((evaluation) => evaluation.jobId === job.id));
  const approved = releases.some((release) => release.status === "approved");
  const pending = releases.find((release) => release.status === "pending_approval");
  const lastRelease = latest(releases);
  const requestable = evaluations.some((evaluation) => evaluation.passed && !releases.some((release) => release.evaluationId === evaluation.id && release.status !== "rejected"));
  const live = studio.profiles.some((profile) => profile.status === "active" && releases.some((release) => release.id === profile.releaseId && release.status === "approved"));

  const states: Record<Phase, StepState> = { define: "complete", data: "current", train: "current", evaluate: "current", approve: "current", use: "current" };
  let blocking: string | undefined;
  const reasons: Partial<Record<Phase, string>> = {};

  if (validDataset) states.data = "complete";
  else if (lastDataset?.status === "rejected") {
    states.data = "failed";
    const v = lastDataset.validation!;
    reasons.data = `${lastDataset.name} was rejected: ${v.rejected} of ${v.records} records failed${v.secretFindings ? `, ${v.secretFindings} with credentials` : ""}.`;
  } else if (lastDataset) reasons.data = `${lastDataset.name} is registered but not validated.`;
  else reasons.data = "No dataset registered.";

  if (succeeded) states.train = "complete";
  else if (!validDataset) { states.train = "blocked"; reasons.train = "Needs a validated dataset."; }
  else if (running) reasons.train = "Training is running.";
  else if (lastJob) { states.train = "failed"; reasons.train = `The last training run ${lastJob.status}.`; }
  else reasons.train = "Not trained yet.";

  if (passed) states.evaluate = "complete";
  else if (!succeeded) { states.evaluate = "blocked"; reasons.evaluate = "Needs a trained candidate."; }
  else if (unevaluated) reasons.evaluate = "The candidate has not been evaluated.";
  else if (lastEvaluation && !lastEvaluation.passed) { states.evaluate = "failed"; reasons.evaluate = `Evaluation failed: ${failingMetrics(lastEvaluation)}.`; }

  if (approved) states.approve = "complete";
  else if (pending) reasons.approve = `Release v${pending.version} needs ${plural(pending.requiredApprovals - pending.approvals.length, "more approval")}.`;
  else if (requestable) reasons.approve = "The evaluation passed. No release requested yet.";
  else if (lastRelease?.status === "rejected") { states.approve = "failed"; reasons.approve = `Release v${lastRelease.version} was rejected.`; }
  else if (lastRelease?.status === "retired") { states.approve = "blocked"; reasons.approve = `Release v${lastRelease.version} was retired. A new evaluation has to pass.`; }
  else { states.approve = "blocked"; reasons.approve = "Needs a passing evaluation."; }

  if (live) states.use = "complete";
  else if (!approved) { states.use = "blocked"; reasons.use = "No approved release available."; }
  else reasons.use = "Approved release not assigned to an assistant.";

  // The current phase is the first one not complete. Phases after it have
  // not been reached, whatever their own inputs say.
  const firstIncomplete = PHASES.find(([phase]) => states[phase] !== "complete")?.[0];
  const current: Phase = firstIncomplete ?? "use";
  let reached = true;
  for (const [phase] of PHASES) {
    if (phase === firstIncomplete) { if (states[phase] !== "failed" && states[phase] !== "blocked") states[phase] = "current"; reached = false; }
    else if (!reached && states[phase] !== "complete") states[phase] = "not-started";
  }
  if (firstIncomplete) blocking = reasons[current];
  const events = eventsFor(studio, project);
  return { current, states, reasons, ...(blocking ? { blocking } : {}), ...(events.length ? { lastEvent: events[events.length - 1] } : {}) };
}

/** True when the current phase cannot move without something being fixed. */
export function isBlocked(report: PhaseReport): boolean {
  return report.states[report.current] === "failed" || report.states[report.current] === "blocked";
}

export function failingMetrics(evaluation: EvaluationRun): string {
  return evaluation.comparison.filter((row) => !row.passed).map((row) => `${row.metric} ${Math.round(row.value * 100)}% (${row.value < row.threshold ? `needs ${Math.round(row.threshold * 100)}%` : `below baseline ${Math.round(row.baseline * 100)}%`})`).join(", ");
}

export function regressions(evaluation: EvaluationRun) {
  return evaluation.comparison.filter((row) => row.value < row.baseline);
}

/** The candidate artifact for a project: the newest succeeded job's. */
export function candidateOf(studio: StudioSnapshot, project: ModelProject): TrainingJob | undefined {
  return [...jobsOf(studio, project)].reverse().find((job) => job.status === "succeeded");
}

export function latestApprovedRelease(studio: StudioSnapshot, project: ModelProject): ModelRelease | undefined {
  return [...releasesOf(studio, project)].reverse().find((release) => release.status === "approved");
}

// --------------------------------------------------------------- approvals

export interface Eligibility { canApprove: boolean; canReject: boolean; canRetire: boolean; reason: string }

export function eligibility(release: ModelRelease, viewer: Viewer): Eligibility {
  const signed = release.approvals.some((approval) => approval.actor === viewer.actor);
  const canRetire = release.status === "approved" && (viewer.admin || (viewer.author && release.requestedBy === viewer.actor));
  if (release.status !== "pending_approval") return { canApprove: false, canReject: false, canRetire, reason: releaseStatusLabel(release) };
  if (!viewer.approver) return { canApprove: false, canReject: false, canRetire, reason: "Approvers and admins review releases." };
  if (release.requestedBy === viewer.actor && !release.allowSelfApproval) return { canApprove: false, canReject: false, canRetire, reason: "You requested this release, so someone else has to review it." };
  if (signed) return { canApprove: false, canReject: false, canRetire, reason: "You already signed this release." };
  return { canApprove: true, canReject: true, canRetire, reason: "" };
}

export function releaseStatusLabel(release: ModelRelease): string {
  return ({ pending_approval: "Pending approval", approved: "Approved", rejected: "Rejected", retired: "Retired" })[release.status];
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Ages, for queues. */
export function ageOf(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

// ------------------------------------------------------------------ events

export interface EventText { summary: string; object: string; from?: string; to?: string; href: string }

const TRANSITIONS: Record<string, [string | undefined, string | undefined]> = {
  "project:created": [undefined, "active"], "project:archived": ["active", "archived"],
  "dataset:registered": [undefined, "registered"], "dataset:validated": ["registered", "valid"], "dataset:rejected": ["registered", "rejected"],
  "config:configured": [undefined, "saved"],
  "job:started": [undefined, "running"], "job:checked": ["running", "running"], "job:succeeded": ["running", "succeeded"], "job:failed": ["running", "failed"], "job:cancelled": ["running", "cancelled"],
  "evaluation:passed": [undefined, "passed"], "evaluation:failed": [undefined, "failed"],
  "release:requested": [undefined, "pending approval"], "release:signed": ["pending approval", "pending approval"], "release:approved": ["pending approval", "approved"],
  "release:rejected": ["pending approval", "rejected"], "release:retired": ["approved", "retired"],
  "profile:assigned": [undefined, "active"], "profile:disabled": ["active", "disabled"],
};
const VERBS: Record<string, string> = {
  "project:created": "created project", "project:archived": "archived project",
  "dataset:registered": "registered dataset", "dataset:validated": "validated dataset", "dataset:rejected": "validated dataset, rejected",
  "config:configured": "saved training configuration",
  "job:started": "started training", "job:checked": "checked training", "job:succeeded": "recorded a trained candidate", "job:failed": "recorded a failed training run", "job:cancelled": "cancelled training",
  "evaluation:passed": "ran evaluation, passed", "evaluation:failed": "ran evaluation, failed",
  "release:requested": "requested release", "release:signed": "signed release", "release:approved": "gave the final approval for release",
  "release:rejected": "rejected release", "release:retired": "retired release",
  "profile:assigned": "created assistant", "profile:disabled": "disabled assistant",
};

export function eventText(studio: StudioSnapshot, event: StudioEvent): EventText {
  const key = `${event.entity}:${event.action}`;
  const project = projectForEntity(studio, event.entity, event.entityId);
  const [from, to] = TRANSITIONS[key] ?? [undefined, undefined];
  const object = project ? project.name : event.entity;
  const href = event.entity === "profile" ? `#/assistants/${event.entityId}`
    : event.entity === "release" ? `#/approvals/${event.entityId}`
    : event.entity === "evaluation" ? `#/evaluations/${event.entityId}`
    : project ? `#/studio/${project.id}/${event.entity === "dataset" ? "data" : event.entity === "job" || event.entity === "config" ? "train" : "define"}` : "#/studio";
  return { summary: VERBS[key] ?? `${event.action} ${event.entity}`, object, ...(from ? { from } : {}), ...(to ? { to } : {}), href };
}
