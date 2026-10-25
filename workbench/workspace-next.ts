import type { WorkbenchSnapshot } from "./snapshot.js";
import { canReviewTask } from "./employee-view.js";
import { escape, status } from "./ui.js";

export interface WorkspaceNextAction {
  kind: "review" | "resume" | "waiting" | "setup" | "blocked" | "test";
  title: string; detail: string; action: string; href: string;
}

export function workspaceNextAction(snapshot: WorkbenchSnapshot): WorkspaceNextAction {
  const admin = snapshot.roles.includes("admin");
  const runs = (snapshot.pipelines?.runs ?? [])
    .filter(run => run.workspaceId === snapshot.workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const review = runs.find(run => canReviewTask(snapshot, run));
  if (review) return { kind: "review", title: review.title,
    detail: "Review the evidence before approving this handoff.", action: "Review handoff", href: `#/tasks/${encodeURIComponent(review.id)}` };

  // Runs keep their own configuration. New-workflow blockers must not hide an existing handoff.
  const active = snapshot.canAuthor ? runs.find(run => run.owner === snapshot.actor
    && ["running", "paused", "blocked"].includes(run.status)) : undefined;
  if (active) {
    const waiting = active.stages[active.current]?.status === "awaiting_review";
    return { kind: waiting ? "waiting" : "resume", title: active.title,
      detail: waiting ? "Waiting for independent review. You cannot approve your own handoff."
        : active.status === "blocked" ? "Inspect the blocker and saved evidence before retrying."
        : active.status === "paused" ? "Continue from the saved stage when you are ready."
        : `Continue at ${active.config.stages[active.current]?.name ?? "the current stage"}.`,
      action: waiting ? "View handoff" : "Open work item", href: `#/tasks/${encodeURIComponent(active.id)}` };
  }
  if (!snapshot.canAuthor) return { kind: "waiting", title: "No handoffs need your review",
    detail: "Your role can inspect team work. An author starts the next run.", action: "View team work", href: "#/desk" };

  const pipeline = snapshot.pipelines;
  const report = snapshot.deployment;
  if (!pipeline) return { kind: "blocked", title: "Workflow unavailable", detail: "Check workspace services before starting work.",
    action: "Open workspace checks", href: "#/workspace?tab=readiness" };
  if (!report || report.workspaceId !== snapshot.workspaceId || report.workflow?.version !== pipeline.version) {
    return { kind: "setup", title: "Check this workflow", detail: "Refresh configuration checks for the current workflow version.",
      action: "Open workspace checks", href: "#/workspace?tab=readiness" };
  }
  const blocked = report.stages.find(stage => stage.blockers.length);
  if (report.blockers.length || blocked || report.status === "blocked") return {
    kind: "blocked", title: blocked ? `Resolve ${blocked.name}` : "Resolve workflow blockers",
    detail: report.blockers[0] ?? blocked?.blockers[0] ?? "Inspect the current configuration checks.",
    action: blocked ? (admin ? "Review stage settings" : "View stage blocker") : "Open workspace checks",
    href: blocked ? `#/workflows/${encodeURIComponent(blocked.id)}` : "#/workspace?tab=readiness",
  };
  const automated = pipeline.config.stages.some(stage => stage.assistantId || (stage.bot && stage.bot.kind !== "manual"));
  if (!automated && admin) return { kind: "setup", title: "Assign an agent to your workflow",
    detail: "This workflow currently uses human steps. Choose where an agent should help.",
    action: "Open workflow canvas", href: "#/canvas" };
  return { kind: "test", title: "Try a supervised workflow",
    detail: automated ? "Configuration checked. Test the actual model and tools, then stop at the review gate."
      : "Configuration checked. Walk through the human steps and verify the handoff gate.",
    action: "Prepare work item", href: "#/tasks/new" };
}

export function workspaceNextPanel(snapshot: WorkbenchSnapshot): string {
  const next = workspaceNextAction(snapshot);
  const label = next.kind === "blocked" ? "Needs attention" : next.kind === "review" ? "Review" : next.kind === "waiting" ? "Waiting" : "Next step";
  return `<section class="workspace-next" aria-labelledby="workspace-next-title"><div>
    ${status(next.kind === "blocked" ? "warn" : "neutral", label)}
    <h2 id="workspace-next-title">${escape(next.title)}</h2><p>${escape(next.detail)}</p>
    </div><a class="primary" href="${escape(next.href)}">${escape(next.action)}</a></section>`;
}
