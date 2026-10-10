import type { WorkbenchSnapshot } from "./snapshot.js";
import { cellLink, empty, escape, graph, panel, status, table } from "./ui.js";
import { ageOf, eligibility, isBlocked, latestApprovedRelease, phaseReport, plural, projectOf, viewerOf } from "./studio-model.js";
import { projectFlow } from "./flow-model.js";
import { flowRow } from "./studio-view.js";
import { agenticUnits, stageNodes } from "./units.js";
import { formatTokens } from "./model-usage.js";
import { canReviewTask } from "./employee-view.js";

/**
 * Workspace home: the operational starting point.
 *
 * The React work queue is mounted first by browser.ts. The existing object
 * maps remain available below it, rather than competing with urgent work.
 */

interface Attention { kind: "release" | "project" | "learning" | "workflow"; id: string; owner: string; tone: "bad" | "warn" | "info"; title: string; detail: string; href: string; action: string }

export function attentionItems(snapshot: WorkbenchSnapshot): Attention[] {
  const items: Attention[] = [];
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  for (const run of snapshot.pipelines?.runs ?? []) {
    if (!canReviewTask(snapshot, run)) continue;
    const stage = run.stages[run.current]!;
    items.push({ kind: "workflow", id: run.id, owner: run.owner, tone: "warn",
      title: `${run.title} needs your review`, detail: `${stage.approvals.length} of ${run.requiredApprovals} approvals · ${run.config.stages[run.current]?.name ?? "Workflow"}`,
      href: `#/tasks/${run.id}`, action: "Review" });
  }
  if (!studio) return items;
  // Approvals this person can act on come first: they are waiting on a human.
  for (const release of studio.releases.filter((item) => item.status === "pending_approval")) {
    const project = projectOf(studio, release.projectId);
    const mine = eligibility(release, viewer);
    if (mine.canApprove) items.push({ kind: "release", id: release.id, owner: release.requestedBy, tone: "warn", title: `Release v${release.version} · ${project?.name ?? "Project"} needs your approval`,
      detail: `Requested by ${release.requestedBy} · ${release.approvals.length} of ${release.requiredApprovals} approvals · ${ageOf(release.requestedAt)} old`, href: `#/approvals/${release.id}`, action: "Review" });
  }
  for (const project of studio.projects.filter((item) => item.status === "active")) {
    const report = phaseReport(studio, project);
    if (report.states[report.current] === "failed" || (report.current === "approve" && isBlocked(report))) {
      const phase = report.current;
      items.push({ kind: "project", id: project.id, owner: project.owner, tone: "bad", title: `${phase === "data" ? "Dataset rejected" : phase === "train" ? "Training failed" : phase === "evaluate" ? "Evaluation failed" : "Release blocked"} · ${project.name}`,
        detail: report.blocking ?? "", href: `#/studio/${project.id}/${phase}`, action: "Open" });
    }
    // A learning schedule that stopped on something a person must fix.
    const lastLearning = snapshot.learning?.runs.filter((run) => run.projectId === project.id).at(-1);
    const schedule = snapshot.learning?.schedules.find((item) => item.projectId === project.id);
    if (lastLearning && schedule && (lastLearning.status === "failed" || (lastLearning.status === "stopped" && /rejected|failed|provider|archived/i.test(lastLearning.summary))) && (viewer.admin || schedule.owner === viewer.actor)) {
      items.push({ kind: "learning", id: lastLearning.id, owner: schedule.owner, tone: "warn", title: `Learning stopped · ${project.name}`, detail: lastLearning.summary, href: `#/studio/${project.id}/data`, action: "Open" });
    }
    // Approved but nobody can use it yet.
    const approved = latestApprovedRelease(studio, project);
    if (approved && report.current === "use" && report.states.use !== "complete") {
      items.push({ kind: "project", id: project.id, owner: project.owner, tone: "info", title: `Release v${approved.version} · ${project.name} is approved but not assigned`, detail: "No assistant uses it yet.", href: `#/studio/${project.id}/use`, action: "Assign" });
    }
  }
  return items;
}

/** Every active project as a chain, newest activity first. This is the map of the workspace. */
function projectFlows(snapshot: WorkbenchSnapshot): string {
  const studio = snapshot.studio;
  if (!studio) return "";
  const flows = studio.projects.filter((project) => project.status === "active").map((project) => ({ project, flow: projectFlow(studio, project) }))
    .sort((a, b) => (b.flow.report.lastEvent?.at ?? b.project.updatedAt).localeCompare(a.flow.report.lastEvent?.at ?? a.project.updatedAt));
  const stateOf = (flow: ReturnType<typeof projectFlow>): "blocked" | "waiting" | "in-use" | "in-progress" =>
    isBlocked(flow.report) ? "blocked"
    : flow.report.current === "approve" && /needs .* approval/.test(flow.report.blocking ?? "") ? "waiting"
    : Object.values(flow.report.states).every((state) => state === "complete") ? "in-use" : "in-progress";
  const rows = flows.slice(0, 8).map(({ project, flow }) => flowRow(studio, project, flow, stateOf(flow)));
  const body = rows.length ? `<div class="flow-list" role="list" aria-label="Projects">${rows.join("")}</div>`
    : empty("No projects yet.", snapshot.canAuthor ? { label: "Create a model project", href: "#/studio" } : undefined);
  const drafts = snapshot.records.filter((record) => record.status === "draft" && record.author === snapshot.actor).length;
  const more = flows.length > 8 ? `<a class="btn small" href="#/studio">All ${flows.length} projects</a>` : drafts ? `<a class="quiet small" href="#/agents">${drafts} draft agent ${drafts === 1 ? "definition" : "definitions"}</a>` : "";
  return panel("Projects", body, { count: flows.length ? plural(flows.length, "project") : "", actions: more });
}

export function homeView(snapshot: WorkbenchSnapshot): string {
  const studio = snapshot.studio;

  // Agentic units: every assistant as a worker, with what it is connected to.
  const units = agenticUnits(snapshot);
  const unitRows = units.map((unit) => ({ href: `#/assistants/${unit.profile.id}`, cells: [
    cellLink(`#/assistants/${unit.profile.id}`, unit.profile.name, unit.project?.name),
    unit.release ? `<a href="#/approvals/${unit.release.id}">v${unit.release.version}</a>` : "—",
    unit.stages.length ? unit.stages.map((stage) => `<a href="#/workflows/${stage.id}">${escape(stage.name)}</a>`).join(", ") : '<span class="dim">Not in the workflow</span>',
    unit.usable ? (unit.working ? status("progress", "Working") : status("ok", "Ready")) : status(unit.profile.status === "disabled" ? "neutral" : "bad", unit.profile.status === "disabled" ? "Disabled" : "Cannot work"),
    unit.usage ? escape(formatTokens(unit.usage)) : '<span class="dim">—</span>',
  ] }));
  const unitsHtml = table([{ label: "Assistant" }, { label: "Release", nowrap: true }, { label: "Workflow stages" }, { label: "Status", nowrap: true }, { label: "Tokens", nowrap: true }], unitRows,
    { empty: empty("No assistants yet.", studio?.releases.some((release) => release.status === "approved") ? { label: "Create one from an approved release", href: "#/studio" } : undefined), compact: true, label: "Agentic units" });
  const workflowHtml = snapshot.pipelines
    ? `<article class="flow-row" role="listitem"><div class="flow-head"><a class="flow-name" href="#/workflows">${escape(snapshot.pipelines.config.name)}</a><small class="flow-meta">${plural(snapshot.pipelines.config.stages.length, "stage")} · ${snapshot.pipelines.config.stages.filter((stage) => stage.assistantId).length} staffed by assistants</small>${workflowStatus(snapshot)}</div>${graph(stageNodes(snapshot), undefined, { compact: true, label: "Workflow stages" })}</article>`
    : "";

  return `${snapshot.studioError ? `<div class="inline-error" role="alert">Model Studio data could not be loaded: ${escape(snapshot.studioError)}</div>` : ""}
    <div id="operations-queue"><p class="loading" role="status">Preparing your work queue…</p></div>
    <section class="operations-policy" aria-label="Operating boundaries">
      <div><span class="policy-mark" aria-hidden="true">◇</span><div><strong>Human review is an operating control</strong><p>Registry policy requires ${snapshot.workflow.requiredApprovals} distinct ${snapshot.workflow.requiredApprovals === 1 ? "signature" : "signatures"}. Other records retain their own signing rules; inspect the item before approving it.</p></div></div>
      <a href="#/workflow">Inspect active policy <span aria-hidden="true">→</span></a>
    </section>
    <details class="operations-map"><summary><span>Connected workspace</span><small>Inspect model projects, workflow stages, and assistant readiness</small><span aria-hidden="true">⌄</span></summary>
      <div class="operations-map-body">${projectFlows(snapshot)}
      ${workflowHtml ? panel("Workflow", `<div class="flow-list" role="list" aria-label="Workflow">${workflowHtml}</div>`) : ""}
      ${panel("Assistant readiness", unitsHtml, { count: units.length ? `${units.filter((unit) => unit.usable).length} of ${units.length} ready` : "" })}</div>
    </details>`;
}

function workflowStatus(snapshot: WorkbenchSnapshot): string {
  const nodes = stageNodes(snapshot);
  const open = snapshot.pipelines?.runs.filter((run) => run.status === "running" || run.status === "paused" || run.status === "blocked").length ?? 0;
  if (nodes.some((node) => node.state === "broken")) return status("bad", "A stage cannot run");
  if (open) return status("progress", plural(open, "open run"));
  return nodes.some((node) => node.state === "linked") ? status("ok", "Ready") : status("neutral", "By hand");
}

/** Counts for the navigation: things waiting on people. */
export function navCounts(snapshot: WorkbenchSnapshot): { approvals: number; attention: number } {
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const approvals = snapshot.studio?.releases.filter((release) => release.status === "pending_approval" && eligibility(release, viewer).canApprove).length ?? 0;
  return { approvals, attention: attentionItems(snapshot).length };
}

