import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page, StudioUi } from "./studio-view.js";
import { WORKFLOW_TEMPLATE_LIST } from "./workflow-templates.js";
import type { PipelineRun } from "./pipeline.js";
import { ago, callout, detail, empty, escape, graph, hint, menu, more, panel, plural, status, table, when } from "./ui.js";
import { viewerOf } from "./studio-model.js";
import { agenticUnits, jobFor, runNodes, runStatusLabel, stageNodes, stageUnit, type Stage } from "./units.js";
import { outputReview, runNow } from "./output-review.js";

/**
 * Workflows: the stages work moves through, each staffed by an agentic unit.
 *
 * The chain at the top is the workflow definition. A node is an approved
 * assistant doing that stage, or a person doing it by hand. The open
 * stage's panel says what the stage does and lets an admin choose who
 * staffs it. Runs are listed below as their own chains, so progress and
 * staffing are never confused. Running a stage stays in the work desk.
 */

export function workflowPage(snapshot: WorkbenchSnapshot, stageParam: string | undefined, ui?: StudioUi): Page {
  const pipelines = snapshot.pipelines;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  if (!pipelines) return { title: "Workflows", body: empty("Workflows are not configured for this deployment.") };
  const { config, runs } = pipelines;
  const stage = config.stages.find((item) => item.id === stageParam) ?? config.stages[0]!;
  const units = agenticUnits(snapshot);
  const staffed = config.stages.filter((item) => item.assistantId).length;
  const broken = stageNodes(snapshot).filter((node) => node.state === "broken");
  const open = runs.filter((run) => run.status === "running" || run.status === "paused" || run.status === "blocked");

  const headerStatus = broken.length ? status("bad", `${plural(broken.length, "stage")} cannot run`)
    : open.length ? status("progress", `${plural(open.length, "run")} open`)
    : staffed ? status("ok", `${staffed} of ${config.stages.length} stages staffed`)
    : status("neutral", "No assistants assigned");
  const primary = viewer.author ? `<a class="primary" href="#/desk">Start a run</a>` : "";
  const templates = viewer.admin ? WORKFLOW_TEMPLATE_LIST.filter((template) => template.config.name !== config.name).map((template) => `<button data-confirm="workflow_template:${template.id}">Switch to ${escape(template.title)} template</button>`).join("") : "";
  const overflow = menu([`<a href="#/pipelines">Edit stages (advanced)</a>`, `<a href="#/desk">Open work desk</a>`].join(""));
  const pendingTemplate = WORKFLOW_TEMPLATE_LIST.find((template) => ui?.confirm === `workflow_template:${template.id}`);
  const confirmTemplate = pendingTemplate ? callout("warn", `Switch to the ${escape(pendingTemplate.title)} template?`, ` ${escape(pendingTemplate.summary)} It replaces the current ${plural(config.stages.length, "stage")} and their staffing; open runs keep what they started with. <span class="actions inline-actions"><button class="secondary small" data-workflow-template="${pendingTemplate.id}">Switch</button><button class="quiet small" data-cancel-confirm>Cancel</button></span>`) : "";

  const chain = graph(stageNodes(snapshot), stage.id, { label: "Workflow stages" });
  const body = `${confirmTemplate}${chain}${hint("Each box shows a stage's assignment and review gate. Inspect the stage before running it.")}
    ${viewer.admin && templates ? more("Choose a workflow template", `<div class="actions">${templates}</div>`) : ""}
    ${stagePanel(snapshot, stage, viewer.admin, ui)}
    ${panel("Runs", runsBody(snapshot, runs, ui), { count: runs.length ? `${plural(open.length, "open run")} · ${runs.length} total` : "" })}`;
  return { title: config.name, context: `${config.description} · ${plural(config.stages.length, "stage")} · ${plural(units.filter((unit) => unit.usable).length, "assistant")} available`,
    actions: `<a class="secondary" href="#/canvas">Open canvas</a>${headerStatus}${primary}${overflow}`, body };
}

function stagePanel(snapshot: WorkbenchSnapshot, stage: Stage, admin: boolean, ui?: StudioUi): string {
  const unit = stageUnit(snapshot, stage);
  const units = agenticUnits(snapshot);
  const usable = units.filter((item) => item.usable);
  const index = snapshot.pipelines!.config.stages.indexOf(stage) + 1;
  const bot = stage.bot && stage.bot.kind !== "manual" ? `${escape(stage.bot.kind)} bot · ${stage.bot.maxSteps} model calls · ${plural(stage.bot.allowedTools?.length ?? 0, "tool")}` : "No bot; the stage records what a person did";
  const fallback = stage.bot && stage.bot.kind !== "manual" ? "Repository agent" : "By hand";
  const who = !stage.assistantId ? `${escape(stage.agent)} <span class="text-3">· ${fallback}</span>`
    : !unit ? status("bad", "Assistant missing")
    : `<a href="#/assistants/${unit.profile.id}">${escape(unit.profile.name)}</a> ${unit.usable ? status("ok", "Can work") : status("bad", "Cannot work")}${unit.release ? `<br><small class="text-3">release v${unit.release.version} · ${escape(unit.project?.name ?? "")}</small>` : ""}`;
  const state = unit && !unit.usable ? callout("bad", "This stage cannot run.", ` ${escape(unit.reason)} Assign another assistant or do the stage by hand.`) : "";
  const key = `stage:${stage.id}`;
  const draft = ui?.drafts[key] ?? {};
  const assistantId = draft.assistantId ?? stage.assistantId ?? "";
  const approval = draft.approval === undefined ? stage.approval : draft.approval === "true";
  const rows: [string, string][] = [
    ["Agentic unit", who],
    ["What it does", `<span class="text-2">${escape(stage.instructions)}</span>`],
    ["Model", unit?.usable ? `${escape(snapshot.studio?.configs.find((config) => config.id === snapshot.studio?.jobs.find((job) => job.id === unit.release?.jobId)?.configId)?.baseModel ?? "")} <span class="text-3">· from the approved release</span>` : escape(stage.model)],
    ["Context", escape(stage.context || "Work item and completed stage outputs")],
    ["Review gate", stage.approval ? `${status("warn", "Review required")} <span class="text-3">before work moves on</span>` : status("neutral", "No gate")],
    ["Jira status", escape(stage.jiraStatus)],
    ["Bot", bot],
  ];
  const form = admin ? `<form id="workflow-stage" data-stage="${escape(stage.id)}" data-draft="${escape(key)}" class="mt14">
      <label class="field"><span>Who does this stage</span><select name="assistantId">
        <option value="" ${assistantId ? "" : "selected"}>${escape(stage.agent)} · ${fallback}</option>
        ${usable.map((item) => `<option value="${item.profile.id}" ${assistantId === item.profile.id ? "selected" : ""}>${escape(item.profile.name)} · v${item.release?.version ?? "?"} ${escape(item.project?.name ?? "")}</option>`).join("")}
        ${unit && !unit.usable && assistantId === unit.profile.id ? `<option value="${unit.profile.id}" selected disabled>${escape(unit.profile.name)} · cannot work</option>` : ""}
      </select><small>Only active assistants on an approved release are offered. A run that is already open keeps the staffing it started with.</small></label>
      <div class="field-row">
        <label class="field"><span>Stage instructions</span><textarea name="instructions" rows="3" required maxlength="4000">${escape(draft.instructions ?? stage.instructions)}</textarea></label>
        <label class="field"><span>Requested context</span><textarea name="context" rows="3" maxlength="2000">${escape(draft.context ?? stage.context)}</textarea></label>
      </div>
      <label class="field"><span><input type="checkbox" name="approval" ${approval ? "checked" : ""}> Require human review before advancing</span></label>
      <div class="actions"><button type="submit" class="secondary">Save</button></div></form>`
    : `<p class="text-3 mt10 fine">An admin assigns assistants to stages.</p>`;
  return `<section class="panel section"><div class="panel-head"><h2>${index}. ${escape(stage.name)}</h2><span class="count">${stage.assistantId ? "Staffed by an assistant" : fallback === "By hand" ? "Done by hand" : fallback}</span></div><div class="panel-body">${state}${detail(rows, true)}${form}</div></section>`;
}

function runsBody(snapshot: WorkbenchSnapshot, runs: PipelineRun[], ui?: StudioUi): string {
  if (!runs.length) return empty("No runs yet. Runs are started and worked from the work desk.", { label: "Open work desk", href: "#/desk" });
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const jobs = snapshot.schedule?.jobs;
  const units = agenticUnits(snapshot);
  const rows = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((run) => {
    const tone = run.status === "complete" ? "ok" : run.status === "running" ? "accent" : run.status === "cancelled" ? "neutral" : "bad";
    const stage = run.config.stages[run.current]!;
    const progress = run.stages[run.current]!;
    const job = jobFor(jobs, run, stage.id);
    const owner = viewer.admin || (viewer.author && run.owner === snapshot.actor);
    const unit = stage.assistantId ? units.find((item) => item.profile.id === stage.assistantId) : undefined;
    const attempt = snapshot.bots?.attempts.filter((item) => item.runId === run.id && item.stageId === stage.id).at(-1);
    const now = runNow(run, { ...(jobs ? { jobs } : {}), ...(attempt ? { attempt } : {}), actor: snapshot.actor, roles: snapshot.roles, ...(stage.assistantId ? { assistantUsable: !!unit?.usable } : {}) });
    // One line answers the four questions: which stage, who is responsible, what state the output is in, what happens next.
    const nowLine = run.status === "running" || run.status === "paused" || run.status === "blocked"
      ? `<div class="run-now"><span><span class="label">Stage</span>${run.current + 1} of ${run.stages.length} · ${escape(stage.name)}</span><span><span class="label">Responsible</span>${escape(now.who)}</span><span><span class="label">Output</span>${status(now.state.tone, now.state.label)}</span><a class="btn small" href="${escape(now.href)}">${escape(now.action)}</a></div>`
      : "";
    // The review grid opens here only when something waits on a person: a draft to review, or a failed draft to retry.
    // Approvals happen on the work item, which the now line already points at.
    const failed = job && (job.status === "failed" || job.status === "cancelled");
    const review = run.status === "running" && progress.status === "active" && (progress.draft || failed)
      ? `<div class="review-wrap">${progress.draft ? "" : `<p class="review-title">The assistant could not draft ${escape(stage.name)}</p>`}${outputReview({ run, phase: run.current, actor: snapshot.actor, roles: snapshot.roles, ...(jobs ? { jobs } : {}), ...(attempt ? { attempt } : {}), ...(ui ? { ui } : {}), where: "workflows" })}${!progress.draft && owner && job ? `<div class="actions mt8"><button class="secondary small" data-job-retry="${job.id}">Try again</button><a class="quiet small" href="#/desk/${run.id}">Write my own</a></div>` : ""}</div>`
      : "";
    return `<article class="flow-row ${review ? "flow-row-tall" : ""}" role="listitem"><div class="flow-head"><a class="flow-name" href="#/desk/${run.id}">${escape(run.title)}</a><small class="flow-meta">${escape(run.owner)} · started ${when(run.createdAt)}</small>${status(tone, runStatusLabel(run))}<small class="flow-note">${run.status === "complete" ? "All stages done" : `Stage ${run.current + 1} of ${run.stages.length}`} · ${ago(run.updatedAt)}</small></div><div>${nowLine}${graph(runNodes(run, jobs), undefined, { compact: true, label: `${run.title} progress` })}${review}</div></article>`;
  });
  return `<div class="flow-list" role="list" aria-label="Runs">${rows.join("")}</div>${runs.length > 8 ? more("Earlier runs", table([{ label: "Run" }, { label: "Status" }, { label: "Owner" }, { label: "Updated" }], runs.slice(8).map((run) => ({ cells: [escape(run.title), status(run.status === "complete" ? "ok" : "neutral", runStatusLabel(run)), escape(run.owner), ago(run.updatedAt)] })), { compact: true })) : ""}`;
}
