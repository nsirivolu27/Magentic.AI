import { evaluationAnalysis, evaluationIssue } from "./evaluation-analysis.js";
import type { WorkbenchSnapshot } from "./snapshot.js";
import { comparisonTable, evaluationSummary, releaseStatus, releaseSummary, type Page, type StudioUi } from "./studio-view.js";
import { ago, callout, cellLink, detail, empty, escape, more, panel, status, table, transition, when } from "./ui.js";
import { ageOf, eligibility, eventText, projectOf, regressions, releaseStatusLabel, viewerOf } from "./studio-model.js";

/**
 * The review pages: Evaluations, Approvals and Activity.
 *
 * Each is a queue or a log first and a detail second. The detail pages
 * reuse the same summaries the project page shows, so a reviewer who
 * arrives from the queue reads exactly what the author saw.
 */

const unavailable = (error: string | undefined, what: string): string => error
  ? `<div class="inline-error" role="alert"><strong>Model Studio data could not be loaded.</strong> ${escape(error)}</div>`
  : empty(`${what} needs the Model Studio, which is not configured for this deployment.`);

// ------------------------------------------------------------ evaluations

export function evaluationsListPage(snapshot: WorkbenchSnapshot): Page {
  const studio = snapshot.studio;
  if (!studio) return { title: "Evaluations", body: unavailable(snapshot.studioError, "Evaluations") };
  const rows = [...studio.evaluations].reverse().map((evaluation) => {
    const project = projectOf(studio, evaluation.projectId);
    const release = studio.releases.find((item) => item.evaluationId === evaluation.id && item.status !== "rejected") ?? studio.releases.find((item) => item.evaluationId === evaluation.id);
    const failed = evaluation.comparison.filter((row) => !row.passed).length;
    return { href: `#/evaluations/${evaluation.id}`, cells: [
      cellLink(`#/evaluations/${evaluation.id}`, project?.name ?? "Project", `${evaluation.evaluator === "development" ? "Data checks only" : "Evaluation"} · ${ago(evaluation.ranAt)}`),
      evaluation.passed ? status("ok", `Passed · ${evaluation.comparison.length} of ${evaluation.comparison.length}`) : status("bad", `Failed · ${failed} of ${evaluation.comparison.length}`),
      escape(evaluationIssue(evaluation)),
      release ? `<a href="#/approvals/${release.id}">${releaseStatus(release)}</a>` : evaluation.passed ? status("neutral", "Not requested") : status("neutral", "Cannot request"),
    ] };
  });
  return { title: "Evaluations", context: "Results and next steps.",
    body: table([{ label: "Project" }, { label: "Result", nowrap: true }, { label: "Needs attention" }, { label: "Review", nowrap: true }], rows,
      { empty: empty("No evaluations have run.", studio.projects.length ? { label: "Open Model Studio", href: "#/studio" } : undefined), label: "Evaluations" }) };
}

export function evaluationDetailPage(snapshot: WorkbenchSnapshot, id: string): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const crumbs: [string, string][] = [["Evaluations", "#/evaluations"]];
  const evaluation = studio?.evaluations.find((item) => item.id === id);
  if (!studio || !evaluation) return { title: "Evaluation not found", crumbs, body: empty("This evaluation does not exist in the current workspace.", { label: "Back to Evaluations", href: "#/evaluations" }) };
  const project = projectOf(studio, evaluation.projectId)!;
  const job = studio.jobs.find((item) => item.id === evaluation.jobId);
  const config = studio.configs.find((item) => item.id === job?.configId);
  const dataset = studio.datasets.find((item) => item.id === config?.datasetId);
  const releases = studio.releases.filter((item) => item.evaluationId === evaluation.id);
  const release = releases.find((item) => item.status !== "rejected") ?? releases.at(-1);
  const requestable = evaluation.passed && !release && viewer.author && project.status === "active";
  const primary = release ? `<a class="primary" href="#/approvals/${release.id}">Open release v${release.version}</a>`
    : requestable ? `<button class="primary" data-studio-action="request_release" data-id="${evaluation.id}">Request approval</button>`
    : !evaluation.passed && viewer.author ? `<a class="primary" href="#/studio/${project.id}/data">Fix the data and rerun</a>` : "";
  const evidence = detail([
    ["Evaluation id", `<code class="hash">${escape(evaluation.id)}</code>`],
    ["Artifact hash", job?.artifact ? `<code class="hash wrap">${escape(job.artifact.hash)}</code>` : "—"],
    ["Configuration hash", config ? `<code class="hash wrap">${escape(config.hash)}</code>` : "—"],
    ["Dataset", dataset ? `${escape(dataset.name)} · ${dataset.validation?.records ?? 0} records · <code class="hash">${escape(dataset.contentHash.slice(0, 16))}</code>` : "—"],
    ["Thresholds", Object.entries(evaluation.thresholds).map(([metric, value]) => `${escape(metric)} ≥ ${Math.round(value * 100)}%`).join(", ")],
    ["Baseline metrics", Object.entries(evaluation.baseline.metrics).map(([metric, value]) => `${escape(metric)} ${Math.round(value * 100)}%`).join(", ")],
  ], true);
  const next = release ? `<p>Review status:</p><p><a href="#/approvals/${release.id}">Release v${release.version}</a> ${releaseStatus(release)}</p>`
    : project.status !== "active" ? `<p>Archived project. Results are read-only.</p>`
    : !evaluation.passed ? `<p>Update examples → rebuild → rerun checks.</p>`
    : viewer.author ? `<p>Review the evidence, then request approval.</p>`
    : `<p>Ask the owner to request approval.</p>`;
  const technical = `${evaluationSummary(studio, evaluation)}${comparisonTable(evaluation)}<h3 class="subhead">Evidence</h3>${evidence}`;
  const scope = evaluation.evaluator === "development" ? `<p class="text-2">The development evaluator scores dataset readiness, not model outputs, so there are no per example results.</p>` : "";
  const body = `<div class="analysis-page">${evaluationAnalysis(studio, evaluation)}
    ${panel("Next step", `<div class="panel-body">${next}<a href="#/studio/${project.id}/evaluate">Open project</a></div>`)}
    ${more("Detailed scores and evidence", `${technical}${scope}`)}</div>`;
  return { title: `${project.name} · Results`, crumbs, context: `Checked ${when(evaluation.ranAt)}`, actions: primary, body };

}

// -------------------------------------------------------------- approvals

export function approvalsQueuePage(snapshot: WorkbenchSnapshot): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  if (!studio) return { title: "Approvals", body: unavailable(snapshot.studioError, "The approval queue") };
  const row = (release: (typeof studio.releases)[number]) => {
    const project = projectOf(studio, release.projectId);
    const evaluation = studio.evaluations.find((item) => item.id === release.evaluationId);
    const mine = eligibility(release, viewer);
    return { href: `#/approvals/${release.id}`, cells: [
      cellLink(`#/approvals/${release.id}`, `${project?.name ?? "Project"} · release v${release.version}`, `hash ${release.contentHash.slice(0, 12)}`),
      "Approve model release",
      escape(release.requestedBy),
      escape(snapshot.workspaceId),
      evaluation?.passed ? status("ok", "Evaluation passed") : status("bad", "Evaluation missing"),
      release.status === "pending_approval" ? `${release.approvals.length} of ${release.requiredApprovals} approvals${release.approvals.length ? `<small>${escape(release.approvals.map((approval) => approval.actor).join(", "))}</small>` : ""}` : releaseStatus(release),
      `<span class="dim">${ageOf(release.requestedAt)}</span>`,
      release.status !== "pending_approval" ? '<span class="dim">—</span>' : mine.canApprove ? status("accent", "You can review") : status("neutral", mine.reason.replace(/\.$/, "")),
    ] };
  };
  const pending = studio.releases.filter((release) => release.status === "pending_approval").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const decided = [...studio.releases].reverse().filter((release) => release.status !== "pending_approval");
  const columns = [{ label: "Item" }, { label: "Requested action", nowrap: true }, { label: "Requester", nowrap: true }, { label: "Workspace", nowrap: true }, { label: "Evidence", nowrap: true }, { label: "Progress" }, { label: "Age", nowrap: true }, { label: "Your eligibility" }];
  const body = `${table(columns, pending.map(row), { empty: empty("Nothing is waiting for approval."), label: "Waiting for approval" })}
    ${decided.length ? more(`Decided releases · ${decided.length}`, table(columns, decided.map(row), { compact: true, label: "Decided releases" })) : ""}`;
  return { title: "Approvals", context: `${pending.length} waiting. An approval signs one release hash; if anything behind it changes, the signatures stop counting.`, body };
}

export function approvalDetailPage(snapshot: WorkbenchSnapshot, id: string, ui: StudioUi): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const crumbs: [string, string][] = [["Approvals", "#/approvals"]];
  const release = studio?.releases.find((item) => item.id === id);
  if (!studio || !release) return { title: "Release not found", crumbs, body: empty("This release does not exist in the current workspace.", { label: "Back to Approvals", href: "#/approvals" }) };
  const project = projectOf(studio, release.projectId)!;
  const evaluation = studio.evaluations.find((item) => item.id === release.evaluationId);
  const previous = [...studio.releases].filter((item) => item.projectId === project.id && item.status === "approved" && item.id !== release.id).at(-1);
  const mine = eligibility(release, viewer);
  const why = `Release v${release.version} of ${project.name}${previous ? ` replaces approved release v${previous.version}` : " is the project's first release"}. ${evaluation ? `Evaluation ${evaluation.suiteId} ${evaluation.passed ? "passed" : "failed"} against the ${evaluation.baseline.source === "release" ? "previous approved release" : "recipe baseline"}.` : ""} Requested by ${release.requestedBy}.`;
  const body = `<div class="split"><div>
    ${panel("What is changing", `<div class="panel-body"><p class="text-2 mb10">${escape(why)}</p>${releaseSummary(studio, release, viewer, ui, { decision: true })}</div>`)}
    ${evaluation ? panel("Evaluation evidence", `<div class="panel-body">${comparisonTable(evaluation)}<p class="mt8"><a href="#/evaluations/${evaluation.id}">Full evaluation</a></p></div>`) : ""}
  </div><div>
    ${panel("Your eligibility", `<div class="panel-body">${mine.canApprove ? callout("ok", "You can review.", ` Your signature counts as one of ${release.requiredApprovals} distinct approvals.`) : callout("info", mine.reason ? "Not yours to sign." : "", ` ${escape(mine.reason)}`)}${detail([["Author", escape(release.requestedBy)], ["Reviewers so far", release.approvals.length ? release.approvals.map((approval) => escape(approval.actor)).join(", ") : "None"], ["Policy", `${release.requiredApprovals} distinct approvals${release.allowSelfApproval ? ", self approval allowed" : ", requester excluded"}`]])}</div>`)}
    ${panel("Project", `<div class="panel-body">${detail([["Project", `<a href="#/studio/${project.id}/approve">${escape(project.name)}</a>`], ["Recipe", escape(studio.recipes.find((recipe) => recipe.id === project.recipeId)?.title ?? project.recipeId)], ["Owner", escape(project.owner)]])}</div>`)}
  </div></div>`;
  return { title: `${project.name} · release v${release.version}`, crumbs, context: `Requested ${when(release.requestedAt)} · hash ${release.contentHash.slice(0, 16)}`, actions: releaseStatus(release), body };
}

// --------------------------------------------------------------- activity

export function activityPage(snapshot: WorkbenchSnapshot, projectFilter?: string): Page {
  const studio = snapshot.studio;
  type Row = { at: string; actor: string; summary: string; object: string; from?: string; to?: string; href?: string; detail: string; technical: string; workspace: string };
  const rows: Row[] = [];
  for (const event of snapshot.audit) {
    const to: Record<string, string> = { authored: "draft", edited: "draft", submitted: "review", approved: "approved", "changes-requested": "draft", retired: "retired" };
    const from: Record<string, string> = { submitted: "draft", approved: "review", "changes-requested": "review", retired: "approved", edited: "draft" };
    rows.push({ at: event.at, actor: event.actor, summary: `${event.action.replace("-", " ")} agent`, object: event.agentName, ...(from[event.action] ? { from: from[event.action]! } : {}), ...(to[event.action] ? { to: to[event.action]! } : {}), href: "#/agents", detail: event.note ?? "", technical: `definition hash ${event.definitionHash}`, workspace: event.workspaceId });
  }
  if (studio) {
    for (const event of studio.events) {
      const text = eventText(studio, event);
      const project = projectFilter ? projectOf(studio, projectFilter) : undefined;
      if (projectFilter && (!project || text.object !== project.name)) continue;
      rows.push({ at: event.at, actor: event.actor, summary: text.summary, object: text.object, ...(text.from ? { from: text.from } : {}), ...(text.to ? { to: text.to } : {}), href: text.href, detail: event.detail, technical: `${event.entity} ${event.entityId}`, workspace: snapshot.workspaceId });
    }
  }
  // A project filter shows Model Studio events only; registry events belong to agents.
  if (projectFilter) rows.splice(0, rows.length, ...rows.filter((row) => !row.technical.startsWith("definition")));
  rows.sort((a, b) => b.at.localeCompare(a.at));
  const project = projectFilter && studio ? projectOf(studio, projectFilter) : undefined;
  const body = rows.length ? table([{ label: "When", nowrap: true }, { label: "Actor", nowrap: true }, { label: "Event" }, { label: "State", nowrap: true }, { label: "Workspace", nowrap: true }, { label: "Evidence", nowrap: true }],
    rows.map((row) => ({ cells: [
      `<span class="dim" title="${when(row.at)}">${ago(row.at)}</span>`,
      escape(row.actor),
      `${escape(row.summary)} <strong>${escape(row.object)}</strong>${row.detail ? `<small>${escape(row.detail)}</small>` : ""}<details class="more bare"><summary>Technical details</summary><small><code class="hash wrap">${escape(row.technical)} · ${when(row.at)}</code></small></details>`,
      transition(row.from, row.to),
      escape(row.workspace),
      row.href ? `<a href="${escape(row.href)}">Open</a>` : "",
    ] })), { label: "Activity", compact: true }) : empty("No activity recorded yet.");
  return { title: project ? `Activity · ${project.name}` : "Activity", ...(project ? { crumbs: [["Activity", "#/activity"]] as [string, string][] } : {}), context: "Every change, who made it and what state it produced. Newest first.", body };
}

