import type { WorkbenchSnapshot } from "./snapshot.js";
import { attentionItems } from "./home-view.js";
import { eligibility, isBlocked, PHASE_LABEL, phaseReport, viewerOf } from "./studio-model.js";
import { canReviewTask } from "./employee-view.js";

export type QueueState = "review" | "blocked" | "active" | "waiting" | "ready";
export type QueueFilter = "all" | QueueState;
export interface QueueItem {
  id: string; title: string; kind: string; owner: string; state: QueueState;
  phase: string; detail: string; href: string; action: string;
}
export const QUEUE_LABELS: Record<QueueFilter, string> = {
  all: "All work", review: "Needs your review", blocked: "Blocked",
  active: "In progress", waiting: "Waiting", ready: "Next steps",
};
const priority: Record<QueueState, number> = { review: 0, blocked: 1, active: 2, waiting: 3, ready: 4 };

/**
 * A read-only index of the existing workspace. Links never grant authority:
 * the destination and server still enforce ownership, signatures and roles.
 * Nothing here invents deadlines, service levels, accreditation or telemetry.
 */
export function operationsQueue(snapshot: WorkbenchSnapshot): QueueItem[] {
  const items: QueueItem[] = [];
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const attention = attentionItems(snapshot);
  for (const release of snapshot.studio?.releases.filter(r => r.status === "pending_approval") ?? []) {
    const project = snapshot.studio!.projects.find(p => p.id === release.projectId);
    const permission = eligibility(release, viewer), canReview = permission.canApprove;
    items.push({
      id: `release:${release.id}`, title: `${project?.name ?? "Model project"} · release v${release.version}`,
      kind: "Release review", owner: release.requestedBy, phase: "Release", state: canReview ? "review" : "waiting",
      detail: canReview ? `${release.approvals.length} of ${release.requiredApprovals} signatures · ${release.allowSelfApproval ? "self-approval enabled by this release's policy" : "independent review required"}`
        : `${permission.reason} Waiting for remaining eligible signatures.`,
      href: `#/approvals/${release.id}`, action: canReview ? "Review release" : "Inspect release",
    });
  }
  // A new candidate can be training while an earlier release is already live.
  for (const job of snapshot.studio?.jobs.filter(j => j.status === "running") ?? []) {
    const project = snapshot.studio!.projects.find(p => p.id === job.projectId);
    items.push({
      id: `training:${job.id}`, title: `${project?.name ?? "Model project"} · training ${job.id.slice(0, 8)}`,
      kind: "Training job", owner: job.createdBy, phase: "Candidate", state: "active",
      detail: `${job.provider} · ${job.detail || "Training is running."}`,
      href: `#/studio/${job.projectId}/train`, action: "Inspect training",
    });
  }
  for (const project of snapshot.studio?.projects.filter(p => p.status === "active") ?? []) {
    const studio = snapshot.studio!;
    const report = phaseReport(studio, project);
    if (Object.values(report.states).every(state => state === "complete")) continue;
    const pending = studio.releases.find(r => r.projectId === project.id && r.status === "pending_approval");
    if (pending && report.current === "approve") continue; // The release row is the actionable record.
    const running = report.current === "train" && studio.jobs.some(j => j.projectId === project.id && j.status === "running");
    if (running) continue; // The job rows identify the actual active attempts.
    const state: QueueState = isBlocked(report) ? "blocked" : "ready";
    items.push({
      id: `project:${project.id}`, title: project.name, kind: "Model project", owner: project.owner,
      state, phase: PHASE_LABEL[report.current],
      detail: report.blocking ?? "Open the current phase to continue.",
      href: `#/studio/${project.id}/${report.current}`, action: state === "ready" ? "Continue" : "Inspect",
    });
  }
  // Learning failures can remain relevant after a project's release is in use.
  for (const item of attention) {
    if (item.kind !== "learning") continue;
    items.push({ id: `learning:${item.id}`, title: item.title, kind: "Learning schedule", owner: item.owner,
      state: "blocked", phase: "Dataset", detail: item.detail, href: item.href, action: "Inspect" });
  }
  for (const run of snapshot.pipelines?.runs ?? []) {
    if (run.status === "complete" || run.status === "cancelled") continue;
    const stage = run.config.stages[run.current];
    const progress = run.stages[run.current];
    const awaitingReview = progress?.status === "awaiting_review";
    const canReview = progress !== undefined && canReviewTask(snapshot, run);
    const state: QueueState = run.status === "blocked" ? "blocked" : run.status === "paused" ? "waiting"
      : canReview ? "review" : awaitingReview ? "waiting" : "active";
    items.push({
      id: `run:${run.id}`, title: run.title, kind: "Workflow run", owner: run.owner, state,
      phase: stage?.name ?? "Workflow",
      detail: canReview ? `${progress.approvals.length} of ${run.requiredApprovals} signatures · independent review required`
        : awaitingReview ? "Waiting for independent review."
        : run.status === "paused" ? "Paused by an operator."
        : run.status === "blocked" ? "Open the run to inspect the blocking event and evidence."
        : `Stage ${run.current + 1} of ${run.stages.length} · supervised execution`,
      href: `#/desk/${run.id}`, action: canReview ? "Review run" : "Open run",
    });
  }
  return items.sort((a, b) => priority[a.state] - priority[b.state] || a.title.localeCompare(b.title));
}

export function filterQueue(items: QueueItem[], filter: QueueFilter, query: string): QueueItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (filter === "all" || item.state === filter)
    && [item.title, item.kind, item.owner, item.phase, item.detail].join(" ").toLocaleLowerCase().includes(needle));
}
