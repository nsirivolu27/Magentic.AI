import { evaluationAnalysis } from "./evaluation-analysis.js";
import { STUDIO_STAGES, studioGuide, type GuidedExample } from "./guided-stages.js";
import type { WorkbenchSnapshot } from "./snapshot.js";
import type { StudioSnapshot } from "./studio/engine.js";
import type { Dataset, EvaluationRun, ModelProject, ModelRelease, TrainingJob } from "./studio/schema.js";
import { ago, callout, cellLink, detail, disabledAction, duration, empty, escape, graph, hint, menu, more, percent, plural, short, status, table, term, TERMS, when, type StepState } from "./ui.js";
import {
  configOf, datasetsOf, eligibility, evaluationsOf, eventText, failingMetrics, jobsOf, latestApprovedRelease, PHASES, PHASE_LABEL,
  projectOf, regressions, releaseStatusLabel, releasesOf, viewerOf, type Phase, type PhaseReport, type Viewer,
} from "./studio-model.js";
import { NODE_OF_PHASE, projectFlow, TOOL_NAMES } from "./flow-model.js";
import type { Cadence } from "./learning-schedule.js";

/**
 * Model Studio: a table of projects, and one project at a time.
 *
 * The project page has a stable shape whatever node is open: header with
 * one primary action, the connection graph for orientation and navigation,
 * and the open node's panel underneath. Each panel renders its evidence as
 * a table or a key value list, its one action, and folds the rest away.
 */

export interface Page { title: string; context?: string; crumbs?: [string, string][]; actions?: string; body: string }
export interface StudioFilters { owner: string; phase: string; state: string }
export interface StudioUi {
  filters: StudioFilters;
  /** A pending confirmation for an irreversible action, keyed by action and id. */
  confirm?: string;
  /** Unsaved form values, keyed by form, so navigating between phases loses nothing. */
  drafts: Record<string, Record<string, string>>;
  /** The last refused command, shown on the page it concerned until the next command or navigation. */
  error?: string;
}
export const emptyStudioUi = (): StudioUi => ({ filters: { owner: "", phase: "", state: "" }, drafts: {} });

const value = (ui: StudioUi, form: string, field: string, fallback = ""): string => escape(ui.drafts[form]?.[field] ?? fallback);
const unavailable = (error: string | undefined): string => error
  ? `<div class="inline-error" role="alert"><strong>Model Studio data could not be loaded.</strong> ${escape(error)} No assistant can answer until the file is repaired or restored.</div>`
  : empty("Model Studio is not configured for this deployment.");

// -------------------------------------------------------------------- list

export function studioListPage(snapshot: WorkbenchSnapshot, ui: StudioUi): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  if (!studio) return { title: "Model Studio", body: unavailable(snapshot.studioError) };
  const flows = studio.projects.filter((project) => project.status === "active").map((project) => ({ project, flow: projectFlow(studio, project) }));
  const owners = [...new Set(flows.map(({ project }) => project.owner))].sort();
  const stateOf = (report: PhaseReport): "blocked" | "waiting" | "in-use" | "in-progress" =>
    report.states[report.current] === "failed" || report.states[report.current] === "blocked" ? "blocked"
    : report.current === "approve" && /needs .* approval/.test(report.blocking ?? "") ? "waiting"
    : Object.values(report.states).every((state) => state === "complete") ? "in-use" : "in-progress";
  const rows = flows
    .filter(({ project, flow }) => (!ui.filters.owner || project.owner === ui.filters.owner) && (!ui.filters.phase || flow.report.current === ui.filters.phase) && (!ui.filters.state || stateOf(flow.report) === ui.filters.state))
    .sort((a, b) => (b.flow.report.lastEvent?.at ?? b.project.updatedAt).localeCompare(a.flow.report.lastEvent?.at ?? a.project.updatedAt))
    .map(({ project, flow }) => flowRow(studio, project, flow, stateOf(flow.report)));
  const filters = `<div class="filters-bar" role="group" aria-label="Filter projects">
    <select data-studio-filter="owner" aria-label="Owner"><option value="">All owners</option>${owners.map((owner) => `<option value="${escape(owner)}" ${ui.filters.owner === owner ? "selected" : ""}>${escape(owner)}</option>`).join("")}</select>
    <select data-studio-filter="phase" aria-label="Working on"><option value="">Working on anything</option>${PHASES.map(([id, label]) => `<option value="${id}" ${ui.filters.phase === id ? "selected" : ""}>${label}</option>`).join("")}</select>
    <select data-studio-filter="state" aria-label="Status"><option value="">All statuses</option>${[["in-progress", "In progress"], ["blocked", "Blocked"], ["waiting", "Waiting for review"], ["in-use", "In use"]].map(([id, label]) => `<option value="${id}" ${ui.filters.state === id ? "selected" : ""}>${label}</option>`).join("")}</select>
    <span class="count">${plural(rows.length, "project")}</span></div>`;
  const create = viewer.author ? `<details class="menu" ${studio.projects.length ? "" : "open"} id="studio-create"><summary class="primary">New project</summary><div class="menu-form">${projectForm(studio, ui)}</div></details>` : "";
  const list = rows.length ? `<div class="flow-list" role="list" aria-label="Model projects">${rows.join("")}</div>`
    : empty(studio.projects.length ? "No projects match these filters." : "No model projects yet.", studio.projects.length ? undefined : viewer.author ? { label: "New project", attrs: 'data-open="studio-create"' } : undefined);
  return { title: "Model Studio", context: "Choose a template. Build and review your assistant.",
    actions: create,
    body: `${hint("Each row is one project. The boxes show what is connected so far; click any box to open it.")}${filters}${list}` };
}

/** One project as a row: who and what on the left, the chain on the right. The recipe is in the row text and tools follow the assistant, so the row shows the five links that change. Shared with the workspace home. */
export function flowRow(studio: StudioSnapshot, project: ModelProject, flow: ReturnType<typeof projectFlow>, state: "blocked" | "waiting" | "in-use" | "in-progress"): string {
  const report = flow.report;
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)?.title ?? project.recipeId;
  const pill = state === "blocked" ? status("bad", "Blocked") : state === "waiting" ? status("warn", "Waiting for review") : state === "in-use" ? status("ok", "In use") : status("neutral", "In progress");
  const last = report.lastEvent ? `${escape(report.lastEvent.actor)} ${escape(eventText(studio, report.lastEvent).summary)} · ${ago(report.lastEvent.at)}` : `Created ${ago(project.createdAt)}`;
  const note = state === "blocked" && report.blocking ? `<small class="flow-note bad">${escape(report.blocking)}</small>` : `<small class="flow-note">${last}</small>`;
  return `<article class="flow-row" role="listitem"><div class="flow-head"><a class="flow-name" href="#/studio/${project.id}/${report.current}">${escape(project.name)}</a><small class="flow-meta">${escape(recipe)} · ${escape(project.owner)}</small>${pill}${note}</div>${graph(flow.nodes.filter((node) => node.id !== "recipe" && node.id !== "tools"), undefined, { compact: true, label: `${project.name} connections` })}</article>`;
}

function projectForm(studio: StudioSnapshot, ui: StudioUi): string {
  return `<form id="studio-project" data-draft="project"><label class="field"><span>Project name</span><input name="name" required maxlength="120" value="${value(ui, "project", "name")}" placeholder="Helpdesk assistant"></label>
    <fieldset class="template-choices"><legend>Choose a starting template</legend>${studio.recipes.map((recipe) => `<label><input type="radio" name="recipeId" value="${recipe.id}" ${(ui.drafts.project?.recipeId ?? studio.recipes[0]?.id) === recipe.id ? "checked" : ""} required><span><strong>${escape(recipe.title)}</strong><small>${escape(recipe.purpose)}</small></span></label>`).join("")}</fieldset>
    <label class="field"><span>Purpose</span><textarea name="purpose" rows="2" maxlength="1000" placeholder="Who is this for and what should it do?">${value(ui, "project", "purpose")}</textarea></label>
    <button type="submit" class="primary">Create project</button></form>`;
}

// ----------------------------------------------------------------- project

export function studioProjectPage(snapshot: WorkbenchSnapshot, projectId: string, phaseParam: string | undefined, ui: StudioUi): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  if (!studio) return { title: "Model Studio", body: unavailable(snapshot.studioError) };
  const project = projectOf(studio, projectId);
  if (!project) return { title: "Project not found", crumbs: [["Model Studio", "#/studio"]], body: empty("This project does not exist in the current workspace.", { label: "Back to Model Studio", href: "#/studio" }) };
  const flow = projectFlow(studio, project);
  const report = flow.report;
  const phase: Phase = PHASES.some(([id]) => id === phaseParam) ? phaseParam as Phase : report.current;
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)!;
  const approved = latestApprovedRelease(studio, project);
  const releases = releasesOf(studio, project);
  const pending = releases.find((release) => release.status === "pending_approval");

  const chain = graph(flow.nodes, NODE_OF_PHASE[phase], { label: `${project.name} connections` });
  const step = STUDIO_STAGES.find((item) => item.id === phase)!;
  const nextStep = STUDIO_STAGES.find((item) => item.id === report.current)!;
  const orientation = `<section class="stage-intro" aria-label="About this stage"><div><p class="stage-eyebrow">Stage ${STUDIO_STAGES.indexOf(step) + 1} of ${STUDIO_STAGES.length}</p><h2>${step.title}</h2><p>${step.task}</p></div><div>${more("About this step", `<p>${step.result}</p>`)}${phase !== report.current ? `<a href="#/studio/${project.id}/${report.current}">Continue: ${nextStep.title}</a>` : ""}</div></section>`;
  const content = ({ define: defineContent, data: dataContent, train: trainContent, evaluate: evaluateContent, approve: approveContent, use: useContent })[phase](studio, project, report, viewer, ui, snapshot);

  // The header says what the assistant is waiting for, in the words a person would use.
  const READY: Record<Phase, string> = { define: "Ready for data", data: "Needs data", train: "Ready to train", evaluate: "Ready to evaluate", approve: "Ready for review", use: "Ready to assign" };
  const headerStatus = project.status === "archived" ? status("neutral", "Archived")
    : report.states[report.current] === "failed" ? status("bad", `${PHASE_LABEL[report.current]} failed`)
    : approved && report.states.use === "complete" ? status("ok", `Live · v${approved.version}`)
    : pending ? status("warn", `Waiting for review · v${pending.version}`)
    : approved ? status("ok", `Approved · v${approved.version}`)
    : jobsOf(studio, project).some((job) => job.status === "running") ? status("progress", "Training")
    : status(report.states[report.current] === "blocked" ? "warn" : "accent", READY[report.current]);
  const overflow = menu([
    viewer.author && project.status === "active" && (viewer.admin || project.owner === viewer.actor) ? `<button class="danger" data-confirm="archive_project:${project.id}">Archive project</button>` : "",
    `<a href="#/activity?project=${project.id}">View activity</a>`,
  ].join(""));
  const confirmArchive = ui.confirm === `archive_project:${project.id}` ? callout("warn", "Archive this project?", ` Its records stay in the audit trail; it leaves the list. <span class="actions inline-actions"><button class="danger small" data-studio-action="archive_project" data-id="${project.id}">Archive</button><button class="quiet small" data-cancel-confirm>Cancel</button></span>`) : "";

  return {
    title: project.name, crumbs: [["Model Studio", "#/studio"]],
    context: `${recipe.title} template · ${project.owner}`,
    actions: `${headerStatus}${content.primary}${overflow}`,
    body: `${confirmArchive}${studioGuide(project.id, phase, report)}${orientation}${content.main}${more("Technical connections", chain)}`,
  };
}

interface PhaseContent { primary: string; main: string }
type PhaseRenderer = (studio: StudioSnapshot, project: ModelProject, report: PhaseReport, viewer: Viewer, ui: StudioUi, snapshot: WorkbenchSnapshot) => PhaseContent;

const PHASE_HINT: Record<Phase, string> = {
  define: "The recipe sets the data format, training defaults and the scores a candidate must reach.",
  data: "The examples the assistant learns from, one JSON line each. Validation checks the format and looks for credentials.",
  train: "A candidate is the model produced from the validated data. The development provider trains nothing and produces a labelled placeholder.",
  evaluate: "The candidate is scored against the recipe's thresholds and the last approved release. Only a passing evaluation can become a release.",
  approve: "Reviewers sign the release fingerprint. Nothing behind it can change without breaking the signatures.",
  use: "An assistant answers with the approved release plus read only workspace tools. Retiring the release switches it off.",
};

function phaseHeading(phase: Phase, report: PhaseReport, summary: string): string {
  const state = report.states[phase];
  const tone = state === "complete" ? "ok" : state === "failed" ? "bad" : state === "blocked" ? "warn" : state === "current" ? "accent" : "neutral";
  const label: Record<StepState, string> = { complete: "Connected", current: "In progress", blocked: "Blocked", failed: "Failed", "not-started": "Not yet" };
  return `<div class="panel-head"><h2>${PHASE_LABEL[phase]} ${status(tone, label[state])}</h2><span class="count">${escape(summary)}</span></div><div class="panel-body-hint">${hint(PHASE_HINT[phase])}</div>`;
}

/** Why a node cannot be worked on yet. A node that is simply next says nothing; its action speaks. */
function blockingNote(report: PhaseReport, phase: Phase): string {
  const state = report.states[phase];
  const reason = phase === report.current ? report.blocking : report.reasons[phase];
  if (state === "complete" || state === "current" || !reason) return "";
  const tone = state === "failed" ? "bad" : "warn";
  const title = state === "failed" ? "Failed." : state === "blocked" ? "Blocked." : "Not yet.";
  return callout(tone, title, ` ${escape(reason)}`);
}

function datasetStatus(dataset: Dataset): string {
  return dataset.status === "valid" ? status("ok", "Valid") : dataset.status === "rejected" ? status("bad", "Rejected") : status("neutral", "Not validated");
}

// ------------------------------------------------------------------ define

const defineContent: PhaseRenderer = (studio, project, report, viewer) => {
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)!;
  const main = `<section class="panel section">${phaseHeading("define", report, "Purpose")}<div class="panel-body"><p>${escape(project.purpose || recipe.purpose)}</p>
    ${more("Template details", detail([
      ["Use case", `${escape(recipe.title)}<br><span class="text-2">${escape(project.purpose || recipe.purpose)}</span>`],
      ["Intended users", escape(recipe.id === "coding-assistant" ? "Engineers working in this repository" : recipe.id === "it-support" ? "Employees raising IT requests" : recipe.id === "incident-summarization" ? "On call and incident responders" : recipe.id === "internal-knowledge" ? "Employees searching internal documentation" : recipe.id === "salesforce-delivery" ? "Consultants and account managers at a Salesforce agency" : "Engineers and project managers drafting Jira issues")],
      ["Expected behavior", `<span class="text-2">${escape(recipe.profileInstructions)}</span>`],
      ["Base model", escape(recipe.baseModel)],
      ["Data format", recipe.datasetShape === "messages" ? "Chat conversations, one JSON line each, ending with the assistant" : "Prompt and completion pairs, one JSON line each"],
      ["Evaluation suite", `<code>${escape(recipe.suiteId)}</code> · ${Object.entries(recipe.thresholds).map(([metric, threshold]) => `${escape(metric)} ≥ ${percent(threshold)}`).join(", ")}`],
      ["Records for full coverage", String(recipe.minRecords)],
      ["Owner", escape(project.owner)],
    ], true))}
    ${more("Training defaults", detail([["Epochs", String(recipe.hyperparameters.epochs)], ["Learning rate", String(recipe.hyperparameters.learningRate)], ["Batch size", String(recipe.hyperparameters.batchSize)]]))}
  </div></section>`;
  const primary = report.current === "define" || !viewer.author ? `<a class="primary" href="#/studio/${project.id}/data">Open dataset</a>` : "";
  return { primary, main };
};

// -------------------------------------------------------------------- data

const dataContent: PhaseRenderer = (studio, project, report, viewer, ui, snapshot) => {
  const datasets = datasetsOf(studio, project);
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)!;
  const unchecked = [...datasets].reverse().find((dataset) => dataset.status === "registered");
  const form = viewer.author ? datasetForm(studio, project, recipe, ui) : "";
  const rows = [...datasets].reverse().map((dataset) => {
    const v = dataset.validation;
    const version = datasets.indexOf(dataset) + 1;
    return { cells: [
      `${escape(dataset.name)}<small>v${version} · ${dataset.bytes.toLocaleString()} bytes · ${short(dataset.contentHash)}</small>`,
      v ? `<span class="num">${v.records.toLocaleString()}</span>` : '<span class="dim">—</span>',
      datasetStatus(dataset),
      v ? `${v.duplicates}` : '<span class="dim">—</span>',
      v ? (v.secretFindings ? `<span class="status status-bad"><span class="status-mark" aria-hidden="true">✗</span>${v.secretFindings}</span>` : "0") : '<span class="dim">—</span>',
      v ? `${escape(v.by)}<small>${ago(v.at)}</small>` : `<span class="dim">Registered by ${escape(dataset.registeredBy)}</span><small>${ago(dataset.registeredAt)}</small>`,
      viewer.author ? `<button class="quiet small" data-studio-action="validate_dataset" data-id="${dataset.id}">${v ? "Validate again" : "Validate"}</button>` : "",
    ] };
  });
  const issues = [...datasets].reverse().filter((dataset) => dataset.validation?.issues.length).map((dataset) => `<h3 class="subhead">${escape(dataset.name)} · ${plural(dataset.validation!.issues.length, "issue")} block training</h3>${table([{ label: "Line", align: "num" }, { label: "Problem" }, { label: "What to do" }],
    dataset.validation!.issues.map((issue) => ({ cells: [`<span class="num">${issue.line || "file"}</span>`, `<code>${escape(issue.code)}</code>`, escape(issue.message)] })), { compact: true, scroll: true, label: `Issues in ${dataset.name}` })}<p class="text-3 mt6 fine">Line numbers only. Record content is never stored or shown.</p>`).join("");
  const primary = unchecked && viewer.author ? `<button class="primary" data-studio-action="validate_dataset" data-id="${unchecked.id}">Validate dataset</button>`
    : report.states.data === "complete" ? `<a class="primary" href="#/studio/${project.id}/train">Open candidate</a>` : "";
  const main = `<section class="panel section">${phaseHeading("data", report, plural(datasets.length, "dataset"))}<div class="panel-body">${blockingNote(report, "data")}
    ${table([{ label: "Dataset" }, { label: "Examples", align: "num" }, { label: "Validation" }, { label: "Duplicates", align: "num" }, { label: "Credentials", align: "num" }, { label: "Checked by" }, { label: "Actions", hidden: true }], rows, { empty: empty("No dataset registered for this project."), compact: true, label: "Datasets" })}
    ${issues}
    ${viewer.author ? guidedExamples(project, recipe, ui) : ""}
    ${form ? more("Import a dataset (advanced)", form, report.states.data === "failed") : ""}
  </div></section>${snapshot.learning ? more("Automatic learning schedule", learningCard(snapshot, studio, project, viewer, ui)) : ""}`;
  return { primary, main };
};

/**
 * The learning schedule: how this project keeps learning from new content.
 * A cycle validates, trains, evaluates and asks for a release; people approve.
 */
const CADENCE_LABEL: Record<Cadence, string> = { manual: "On request", daily: "Every day", weekly: "Every week" };
function learningCard(snapshot: WorkbenchSnapshot, studio: StudioSnapshot, project: ModelProject, viewer: Viewer, ui: StudioUi): string {
  if (!snapshot.learning) return "";
  const schedule = snapshot.learning.schedules.find((item) => item.projectId === project.id);
  const runs = snapshot.learning.runs.filter((item) => item.projectId === project.id).slice(-3).reverse();
  const last = runs[0];
  const pill = !schedule ? status("neutral", "Not set") : schedule.paused ? status("neutral", "Paused") : schedule.cadence === "manual" ? status("info", "On request") : status("ok", CADENCE_LABEL[schedule.cadence]);
  const rows: [string, string][] = schedule ? [
    ["Rhythm", `${CADENCE_LABEL[schedule.cadence]}${schedule.nextRunAt && !schedule.paused ? ` · next ${when(schedule.nextRunAt)}` : ""}`],
    ["Learns from", schedule.pattern ? `New files in the import folder matching <code>${escape(schedule.pattern)}</code>, plus registered content` : "Registered content that has not been trained yet"],
    ["Set by", escape(schedule.owner)],
    ["Last run", last ? `${last.status === "complete" ? status("ok", "Complete") : last.status === "stopped" ? status("warn", "Stopped") : status("bad", "Failed")} ${escape(last.summary)}<br><small class="text-3">${escape(last.trigger === "manual" ? "run by hand" : "on schedule")} · ${ago(last.startedAt)}</small>` : '<span class="text-3">Not yet</span>'],
  ] : [];
  const steps = last ? `<ol class="learning-steps">${last.steps.map((step) => `<li class="${step.outcome}"><span class="step-dot" aria-hidden="true">${step.outcome === "done" ? "✓" : step.outcome === "stopped" ? "✗" : "○"}</span><strong>${escape(step.step)}</strong><span>${escape(step.detail)}</span></li>`).join("")}</ol>` : "";
  const key = `learning:${project.id}`;
  const form = viewer.author && project.status === "active" ? `<form id="studio-learning" data-project="${project.id}" data-draft="${key}" class="mt10">
      <div class="field-row"><label class="field"><span>Rhythm</span><select name="cadence">${(["manual", "daily", "weekly"] as Cadence[]).map((cadence) => `<option value="${cadence}" ${(ui.drafts[key]?.cadence ?? schedule?.cadence ?? "weekly") === cadence ? "selected" : ""}>${CADENCE_LABEL[cadence]}</option>`).join("")}</select></label>
      ${studio.storage === "file" ? `<label class="field"><span>Import folder files</span><input name="pattern" maxlength="200" value="${value(ui, key, "pattern", schedule?.pattern ?? "")}" placeholder="case-notes-*.jsonl"><small>New files matching this name are registered on each run. Leave empty to learn only from registered content.</small></label>` : ""}</div>
      ${schedule ? `<label class="check"><input type="checkbox" name="paused" ${schedule.paused ? "checked" : ""}> Paused</label>` : ""}
      <div class="actions mt8"><button type="submit" class="secondary">${schedule ? "Save schedule" : "Start learning on a schedule"}</button>${schedule && !schedule.paused ? `<button type="button" class="quiet" data-learning-run="${project.id}">Learn now</button>` : ""}</div></form>` : "";
  return `<section class="panel section mt14" aria-label="Learning schedule"><div class="panel-head"><h2>Learning schedule ${pill}</h2><span class="count">${runs.length ? plural(snapshot.learning.runs.filter((item) => item.projectId === project.id).length, "run") : ""}</span></div><div class="panel-body-hint">${hint("A cycle picks up new content, checks it, trains and evaluates a candidate and asks for a release. Reviewers still approve; the assistant changes only after that.")}</div><div class="panel-body">
    ${schedule ? detail(rows, true) : `<p class="text-2">This project learns only when someone runs each step. Set a rhythm and new content becomes a release request on its own.</p>`}
    ${steps ? more(`Last run, step by step`, steps, last?.status !== "complete") : ""}
    ${form}
  </div></section>`;
}

function guidedExamples(project: ModelProject, recipe: StudioSnapshot["recipes"][number], ui: StudioUi): string {
  const key = `examples:${project.id}`;
  const examples: GuidedExample[] = JSON.parse(ui.drafts[key]?.examples ?? "[]");
  return `<form id="studio-examples" data-project="${project.id}" data-draft="${key}" class="example-builder">
    <h3>Examples</h3>
    <label class="field"><span>Example set name</span><input name="name" required maxlength="120" value="${value(ui, key, "name", "My examples")}"></label>
    <div class="field-row"><label class="field"><span>Question</span><textarea aria-label="What would someone ask?" name="question" rows="3" maxlength="16000" placeholder="Describe a question or task…">${value(ui, key, "question")}</textarea></label>
    <label class="field"><span>Ideal answer</span><textarea aria-label="What should a good answer say?" name="answer" rows="3" maxlength="16000" placeholder="Write the answer you want the assistant to learn…">${value(ui, key, "answer")}</textarea></label></div>
    <div class="actions"><button type="submit" class="secondary" data-example-add>Add example</button><span class="text-3">${plural(examples.length, "example")} added</span></div>
    ${examples.length ? `<ol class="example-list">${examples.map((example, index) => `<li><span>${escape(example.question)}</span><button type="button" class="quiet small" data-example-remove="${index}" data-example-project="${project.id}" aria-label="Remove example ${index + 1}">Remove</button></li>`).join("")}</ol><button type="submit" class="primary" data-example-save>Save examples</button>` : ""}
    ${more("Example guidelines", `<p class="fine">Use real situations and answers you have checked. This template expects ${recipe.minRecords} examples for full coverage. Format checks do not prove answer quality.</p>`)}</form>`;
}

function datasetForm(studio: StudioSnapshot, project: ModelProject, recipe: StudioSnapshot["recipes"][number], ui: StudioUi): string {
  const key = `dataset:${project.id}`;
  const example = recipe.datasetShape === "messages" ? '{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}' : '{"prompt":"…","completion":"…"}';
  return `<form id="studio-dataset" data-project="${project.id}" data-draft="${key}">
    <div class="field-row"><label class="field"><span>Dataset name</span><input name="name" required maxlength="120" value="${value(ui, key, "name")}" placeholder="Support transcripts, September"></label>${studio.storage === "file" ? `<label class="field"><span>Or a file in the import folder</span><input name="path" maxlength="500" value="${value(ui, key, "path")}" placeholder="transcripts.jsonl"></label>` : ""}</div>
    <label class="field"><span>Records (JSONL, one per line, up to 48 KB)</span><textarea name="text" rows="5" maxlength="48000" placeholder='${escape(example)}'>${value(ui, key, "text")}</textarea></label>
    <div class="actions"><button type="submit" class="secondary">Register dataset</button><span class="disabled-reason">Validation runs as a separate step and reports line numbers only.</span></div></form>`;
}

// ------------------------------------------------------------------- train

const trainContent: PhaseRenderer = (studio, project, report, viewer, ui) => {
  const jobs = jobsOf(studio, project);
  const valid = datasetsOf(studio, project).filter((dataset) => dataset.status === "valid");
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)!;
  const running = [...jobs].reverse().find((job) => job.status === "running");
  const shown = running ?? [...jobs].reverse().find((job) => job.status === "succeeded") ?? jobs.at(-1);
  const config = configOf(studio, shown);
  const provider = studio.providers[0];
  // The card is about the candidate model. How it was made is one fold below.
  const summary = shown ? detail([
    [term("Candidate", TERMS.candidate), shown.artifact ? `${escape(shown.artifact.label === "development" ? "Development artifact" : "Trained artifact")} ${short(shown.artifact.hash)} ${jobStatus(shown)}<br><small class="text-3">${escape(shown.artifact.note)} A finished run says nothing about quality; that is what the evaluation measures.</small>` : `${jobStatus(shown)} <span class="text-2">${escape(shown.detail)}</span>`],
    ["Built from", config ? `${escape(studio.datasets.find((dataset) => dataset.id === config.datasetId)?.name ?? "")} · ${escape(config.baseModel)}` : "—"],
    ["Trained", `${escape(shown.createdBy)} · ${when(shown.createdAt)}`],
    ["Duration", shown.finishedAt ? duration(shown.createdAt, shown.finishedAt) : `<span class="text-2">running · ${ago(shown.createdAt)}</span>`],
  ], true) + more("How it was made", detail([
    ["Provider", escape(studio.providers.find((item) => item.id === shown.provider)?.label ?? shown.provider)],
    ["Run", `<code>${escape(shown.providerJobId)}</code>`],
    ["Parameters", config ? `${config.hyperparameters.epochs} epochs · learning rate ${config.hyperparameters.learningRate} · batch ${config.hyperparameters.batchSize}<br><small class="text-3">configuration ${short(config.hash)}</small>` : "—"],
    ["Estimated work", `${shown.estimate.units.toLocaleString()} units<br><small class="text-3">${escape(shown.estimate.note)}</small>`],
  ])) : "";
  const history = jobs.length > 1 ? more("Earlier runs", table([{ label: "Run" }, { label: "Result" }, { label: "Started" }, { label: "Duration" }, { label: "Artifact" }],
    [...jobs].reverse().map((job) => ({ cells: [`<code>${escape(job.providerJobId)}</code>`, jobStatus(job), `${escape(job.createdBy)}<small>${when(job.createdAt)}</small>`, job.finishedAt ? duration(job.createdAt, job.finishedAt) : "—", job.artifact ? short(job.artifact.hash) : "—"] })), { compact: true })) : "";
  const form = viewer.author && valid.length ? configForm(studio, project, recipe, valid, ui) : "";
  const primary = running && viewer.author ? `<button class="primary" data-studio-action="record_job" data-id="${running.id}">Check training</button>`
    : report.states.train === "complete" ? `<a class="primary" href="#/studio/${project.id}/evaluate">Open evaluation</a>`
    : !valid.length ? disabledAction("Start training", "Needs a validated dataset")
    : viewer.author ? `<button class="primary" type="submit" form="studio-config">Start training</button>` : "";
  const main = `<section class="panel section">${phaseHeading("train", report, `${plural(jobs.length, "run")} · ${escape(provider?.label ?? "no provider")}`)}<div class="panel-body">${blockingNote(report, "train")}
    ${running ? callout("info", "Training.", ` Started ${ago(running.createdAt)} by ${escape(running.createdBy)}. <button class="quiet small" data-studio-action="cancel_job" data-id="${running.id}">Cancel</button>`) : ""}
    ${summary || (form ? "" : empty("No candidate yet."))}
    ${form ? (jobs.length && !running ? more("Train a new candidate", form) : running ? "" : form) : ""}
    ${history}
  </div></section>`;
  return { primary, main };
};

function jobStatus(job: TrainingJob): string {
  return job.status === "succeeded" ? status("ok", "Succeeded") : job.status === "running" ? status("progress", "Running") : job.status === "failed" ? status("bad", "Failed") : status("neutral", "Cancelled");
}

function configForm(studio: StudioSnapshot, project: ModelProject, recipe: StudioSnapshot["recipes"][number], valid: Dataset[], ui: StudioUi): string {
  const key = `config:${project.id}`;
  const newest = [...valid].reverse();
  return `<form id="studio-config" data-project="${project.id}" data-draft="${key}">
    <div class="field-row">
      <label class="field"><span>Dataset</span>${newest.length > 1 ? `<select name="datasetId">${newest.map((dataset) => `<option value="${dataset.id}" ${(ui.drafts[key]?.datasetId ?? newest[0]?.id) === dataset.id ? "selected" : ""}>${escape(dataset.name)} · ${dataset.validation?.records ?? 0} records</option>`).join("")}</select>` : `<input type="hidden" name="datasetId" value="${newest[0]?.id ?? ""}"><input value="${escape(newest[0]?.name ?? "")} · ${newest[0]?.validation?.records ?? 0} records" disabled aria-label="Dataset">`}</label>
      <label class="field"><span>Provider</span><select name="provider">${studio.providers.map((provider) => `<option value="${provider.id}">${escape(provider.label)}</option>`).join("")}</select><small>${studio.providers[0]?.id === "local-dev" ? "Trains nothing. Produces a labelled development artifact so the flow can be exercised." : ""}</small></label>
    </div>
    ${more("Advanced parameters", `<div class="field-row"><label class="field"><span>Base model</span><input name="baseModel" value="${value(ui, key, "baseModel", recipe.baseModel)}" maxlength="200" required></label><label class="field"><span>Epochs</span><input name="epochs" type="number" min="1" max="20" value="${value(ui, key, "epochs", String(recipe.hyperparameters.epochs))}" required></label><label class="field"><span>Learning rate</span><input name="learningRate" type="number" step="any" min="0.0000001" max="1" value="${value(ui, key, "learningRate", String(recipe.hyperparameters.learningRate))}" required></label><label class="field"><span>Batch size</span><input name="batchSize" type="number" min="1" max="256" value="${value(ui, key, "batchSize", String(recipe.hyperparameters.batchSize))}" required></label></div>`)}
    <div class="actions mt10"><button type="submit" class="secondary">Start training</button></div></form>`;
}

// ---------------------------------------------------------------- evaluate

const evaluateContent: PhaseRenderer = (studio, project, report, viewer) => {
  const evaluations = evaluationsOf(studio, project);
  const pendingJob = [...jobsOf(studio, project)].reverse().find((job) => job.status === "succeeded" && !evaluations.some((evaluation) => evaluation.jobId === job.id));
  const latest = evaluations.at(-1);
  const releases = releasesOf(studio, project);
  const requestable = latest?.passed && !releases.some((release) => release.evaluationId === latest.id && release.status !== "rejected");
  const primary = pendingJob && viewer.author ? `<button class="primary" data-studio-action="run_evaluation" data-id="${pendingJob.id}">Run evaluation</button>`
    : requestable && viewer.author ? `<button class="primary" data-studio-action="request_release" data-id="${latest!.id}">Request review</button>`
    : latest?.passed ? `<a class="primary" href="#/studio/${project.id}/approve">Open release</a>`
    : !jobsOf(studio, project).some((job) => job.status === "succeeded") ? disabledAction("Run evaluation", "Needs a trained candidate")
    : latest && !latest.passed && viewer.author ? `<a class="primary" href="#/studio/${project.id}/data">Fix the data</a>` : "";
  // The outcome callout below already says why a failed evaluation blocks.
  const main = `<section class="panel section">${phaseHeading("evaluate", report, `${plural(evaluations.length, "evaluation")}`)}<div class="panel-body">${latest ? "" : blockingNote(report, "evaluate")}
    ${latest ? evaluationAnalysis(studio, latest) + more("Detailed scores and evidence", evaluationSummary(studio, latest) + comparisonTable(latest)) : empty("No evaluation has run yet.")}
    ${latest ? `<p class="text-3 mt8 fine">${escape(studio.evaluator.note)} Latency and cost are not measured by this evaluator.</p>` : ""}
    ${evaluations.length > 1 ? more("Earlier evaluations", table([{ label: "Suite" }, { label: "Result" }, { label: "Baseline" }, { label: "Run" }],
      [...evaluations].reverse().slice(1).map((evaluation) => ({ href: `#/evaluations/${evaluation.id}`, cells: [cellLink(`#/evaluations/${evaluation.id}`, evaluation.suiteId), evaluation.passed ? status("ok", "Passed") : status("bad", "Failed"), evaluation.baseline.source === "release" ? "Approved release" : "Recipe", `${escape(evaluation.ranBy)}<small>${when(evaluation.ranAt)}</small>`] })), { compact: true })) : ""}
  </div></section>`;
  return { primary, main };
};

export function evaluationSummary(studio: StudioSnapshot, evaluation: EvaluationRun): string {
  const failed = evaluation.comparison.filter((row) => !row.passed);
  const regressed = regressions(evaluation);
  const baseline = evaluation.baseline.source === "release" ? `approved release v${studio.releases.find((release) => release.id === evaluation.baseline.releaseId)?.version ?? "?"}` : "recipe baseline (untrained)";
  const job = studio.jobs.find((item) => item.id === evaluation.jobId);
  return `${evaluation.passed ? callout("ok", "Passed.", ` All ${evaluation.comparison.length} metrics meet the ${escape(evaluation.suiteId)} thresholds against the ${baseline}.`) : callout("bad", "Failed.", ` ${escape(failingMetrics(evaluation))}. A release cannot be requested from this evaluation.`)}
    ${regressed.length ? callout("warn", "Regression.", ` ${regressed.map((row) => `${escape(row.metric)} fell from ${percent(row.baseline)} to ${percent(row.value)}`).join(", ")}.`) : ""}
    ${detail([["Candidate", job?.artifact ? `${escape(job.artifact.label)} artifact ${short(job.artifact.hash)} · job <code>${escape(job.providerJobId)}</code>` : "—"], [term("Baseline", TERMS.baseline), escape(baseline)], ["Run", `${escape(evaluation.ranBy)} · ${when(evaluation.ranAt)} · ${escape(evaluation.evaluator)} evaluator`]])}`;
}

export function comparisonTable(evaluation: EvaluationRun): string {
  const rows = [...evaluation.comparison].sort((a, b) => Number(a.passed) - Number(b.passed));
  return table([{ label: "Metric" }, { label: "Candidate", align: "num" }, { label: "Baseline", align: "num" }, { label: "Must reach", align: "num" }, { label: "Change", align: "num" }, { label: "Result" }],
    rows.map((row) => ({ className: row.passed ? "pass" : "fail", cells: [escape(row.metric), percent(row.value), percent(row.baseline), percent(row.threshold), `${row.value - row.baseline >= 0 ? "+" : ""}${Math.round((row.value - row.baseline) * 100)} pt`, row.passed ? "✓ Pass" : `✗ Fail`] })), { compact: true, label: "Candidate versus baseline" });
}

// ----------------------------------------------------------------- approve

const approveContent: PhaseRenderer = (studio, project, report, viewer, ui) => {
  const releases = releasesOf(studio, project);
  const pending = [...releases].reverse().find((release) => release.status === "pending_approval");
  const approved = latestApprovedRelease(studio, project);
  const shown = pending ?? approved ?? releases.at(-1);
  const evaluations = evaluationsOf(studio, project);
  const requestable = [...evaluations].reverse().find((evaluation) => evaluation.passed && !releases.some((release) => release.evaluationId === evaluation.id && release.status !== "rejected"));
  let primary = "";
  if (pending) {
    const mine = eligibility(pending, viewer);
    primary = mine.canApprove ? `<a class="primary" href="#/approvals/${pending.id}">Review release v${pending.version}</a>` : disabledAction("Approve", mine.reason);
  } else if (approved && report.states.use !== "complete") primary = `<a class="primary" href="#/studio/${project.id}/use">Open assistant</a>`;
  else if (requestable && viewer.author) primary = `<button class="primary" data-studio-action="request_release" data-id="${requestable.id}">Request review</button>`;
  else if (!requestable && !approved) primary = disabledAction("Request review", "Needs a passing evaluation");
  // A pending release explains itself in its summary; the phase note would repeat it.
  const main = `<section class="panel section">${phaseHeading("approve", report, plural(releases.length, "release"))}<div class="panel-body">${pending ? "" : blockingNote(report, "approve")}
    ${shown ? releaseSummary(studio, shown, viewer, ui) : empty("No release has been requested.")}
    ${releases.length > 1 ? more("All releases", table([{ label: "Release" }, { label: "Status" }, { label: "Approvals" }, { label: "Requested" }],
      [...releases].reverse().map((release) => ({ href: `#/approvals/${release.id}`, cells: [cellLink(`#/approvals/${release.id}`, `v${release.version}`, release.contentHash.slice(0, 12)), releaseStatus(release), `${release.approvals.length} of ${release.requiredApprovals}`, `${escape(release.requestedBy)}<small>${when(release.requestedAt)}</small>`] })), { compact: true })) : ""}
  </div></section>`;
  return { primary, main };
};

export function releaseStatus(release: ModelRelease): string {
  return release.status === "approved" ? status("ok", "Approved") : release.status === "pending_approval" ? status("warn", "Pending approval") : release.status === "rejected" ? status("bad", "Rejected") : status("neutral", "Retired");
}

/** The facts a reviewer signs, in the order they should read them. */
export function releaseSummary(studio: StudioSnapshot, release: ModelRelease, viewer: Viewer, ui: StudioUi, options: { decision?: boolean } = {}): string {
  const project = projectOf(studio, release.projectId);
  const job = studio.jobs.find((item) => item.id === release.jobId);
  const config = configOf(studio, job);
  const evaluation = studio.evaluations.find((item) => item.id === release.evaluationId);
  const mine = eligibility(release, viewer);
  const remaining = release.requiredApprovals - release.approvals.length;
  const blocking = release.status === "pending_approval" ? `Needs ${plural(remaining, "more approval")}${release.allowSelfApproval ? "" : ` from someone other than ${release.requestedBy}`}.` : "";
  const rows: [string, string][] = [
    ["Release", `v${release.version} ${releaseStatus(release)}`],
    ["Requested", `${escape(release.requestedBy)} · ${when(release.requestedAt)}`],
    [term("Release fingerprint", TERMS.hash), `<code class="hash wrap">${escape(release.contentHash)}</code><br><small class="text-3">Binds the artifact, its configuration and the evaluation below. Signatures are made over this fingerprint.</small>`],
    [term("Artifact", TERMS.artifact), job?.artifact ? `${escape(job.artifact.label === "development" ? "Development artifact" : "Trained artifact")} <code class="hash">${escape(job.artifact.hash)}</code><br><small class="text-3">${escape(job.artifact.note)}</small>` : "Missing"],
    ["Configuration", config ? `${escape(config.baseModel)} · ${config.hyperparameters.epochs} epochs · <code class="hash">${escape(config.hash.slice(0, 16))}</code>` : "Missing"],
    ["Evaluation", evaluation ? `${evaluation.passed ? status("ok", "Passed") : status("bad", "Failed")} <a href="#/evaluations/${evaluation.id}">${escape(evaluation.suiteId)}</a> · ${evaluation.comparison.filter((row) => row.passed).length} of ${evaluation.comparison.length} metrics` : "Missing"],
    ["Approvals", `${release.approvals.length} of ${release.requiredApprovals}${release.approvals.length ? `<br>${release.approvals.map((approval) => `<span class="approval-line">✓ ${escape(approval.actor)} · ${when(approval.at)}${approval.note ? ` · ${escape(approval.note)}` : ""}</span>`).join("<br>")}` : ""}`],
    ...(release.decision ? [[releaseStatusLabel(release), `${escape(release.decision.by)} · ${when(release.decision.at)} · ${escape(release.decision.note)}`] as [string, string]] : []),
    ["After approval", `Release v${release.version} of ${escape(project?.name ?? "the project")} can be assigned to assistants in this workspace.`],
  ];
  const decision = options.decision && (mine.canApprove || mine.canRetire) ? decisionForm(release, mine, ui) : "";
  return `${blocking ? callout(mine.canApprove ? "info" : "warn", "Waiting.", ` ${escape(blocking)}${mine.reason && !mine.canApprove ? ` ${escape(mine.reason)}` : ""}`) : ""}${detail(rows, true)}${decision}`;
}

function decisionForm(release: ModelRelease, mine: ReturnType<typeof eligibility>, ui: StudioUi): string {
  const key = `decision:${release.id}`;
  const retire = ui.confirm === `retire_release:${release.id}`;
  return `<form class="studio-decision mt14" data-release="${release.id}" data-hash="${release.contentHash}" data-draft="${key}">
    <label class="field"><span>Review note${mine.canApprove ? " (required to reject)" : " (required)"}</span><input name="note" maxlength="2000" value="${value(ui, key, "note")}"></label>
    <div class="actions">${mine.canApprove ? `<button type="submit" class="primary" data-studio-decision="approve_release">Approve release v${release.version}</button><button type="submit" class="secondary" data-studio-decision="reject_release">Reject</button>` : ""}
    ${mine.canRetire ? (retire ? `<span class="callout warn m0"><strong>Retire v${release.version}?</strong> Its assistants stop answering. <button type="submit" class="danger small" data-studio-decision="retire_release">Retire</button> <button type="button" class="quiet small" data-cancel-confirm>Cancel</button></span>` : `<button type="button" class="danger" data-confirm="retire_release:${release.id}">Retire release</button>`) : ""}</div></form>`;
}

// --------------------------------------------------------------------- use

const useContent: PhaseRenderer = (studio, project, report, viewer, ui) => {
  const approved = latestApprovedRelease(studio, project);
  const releases = releasesOf(studio, project);
  const profiles = studio.profiles.filter((profile) => releases.some((release) => release.id === profile.releaseId));
  const rows = profiles.map((profile) => {
    const release = releases.find((item) => item.id === profile.releaseId)!;
    const usable = profile.status === "active" && release.status === "approved";
    return { href: `#/assistants/${profile.id}`, cells: [cellLink(`#/assistants/${profile.id}`, profile.name), usable ? status("ok", "Active") : status("neutral", profile.status === "disabled" ? "Disabled" : releaseStatusLabel(release)), `v${release.version}`, `${escape(profile.createdBy)}<small>${ago(profile.updatedAt)}</small>`,
      viewer.author && profile.status === "active" && (viewer.admin || profile.createdBy === viewer.actor) ? (ui.confirm === `disable_profile:${profile.id}` ? `<span class="actions"><button class="danger small" data-studio-action="disable_profile" data-id="${profile.id}">Confirm disable</button><button class="quiet small" data-cancel-confirm>Cancel</button></span>` : `<button class="quiet small" data-confirm="disable_profile:${profile.id}">Disable</button>`) : ""] };
  });
  const form = approved && viewer.author ? profileForm(studio, project, approved, ui) : "";
  const primary = !approved ? disabledAction("Create assistant", "No approved release available")
    : viewer.author ? `<button class="primary" type="submit" form="studio-profile">Create assistant</button>` : "";
  const main = `<section class="panel section">${phaseHeading("use", report, plural(rows.length, "assistant"))}<div class="panel-body">${blockingNote(report, "use")}
    ${approved ? detail([
      ["Approved release", `v${approved.version} ${releaseStatus(approved)} · <a href="#/approvals/${approved.id}">signatures</a>`],
      ["Workspace scope", escape(studio.projects.length ? project.workspaceId : "")],
      ["Knowledge", "Workspace MCP, read only: approved agent definitions and workspace policy"],
      ["Allowed tools", `${TOOL_NAMES.map((tool) => `<code>${tool}</code>`).join(" ")}<br><small class="text-3">Assistants cannot approve, edit, retire, send email or run agents.</small>`],
    ], true) : ""}
    ${table([{ label: "Assistant" }, { label: "Status" }, { label: "Release" }, { label: "Created" }, { label: "Actions", hidden: true }], rows, { empty: approved ? empty("No assistant uses this release yet.") : "", compact: true, label: "Assigned assistants" })}
    ${form ? (rows.length ? more("Create another assistant", form) : `<h3 class="subhead">Create an assistant from this release</h3>${form}`) : ""}
  </div></section>`;
  return { primary, main };
};

function profileForm(studio: StudioSnapshot, project: ModelProject, approved: ModelRelease, ui: StudioUi): string {
  const key = `profile:${project.id}`;
  const recipe = studio.recipes.find((item) => item.id === project.recipeId)!;
  const options = [...releasesOf(studio, project)].reverse().filter((release) => release.status === "approved");
  return `<form id="studio-profile" data-draft="${key}">
    <div class="field-row"><label class="field"><span>Assistant name</span><input name="name" required maxlength="120" value="${value(ui, key, "name")}" placeholder="${escape(project.name)} assistant"></label>
    <label class="field"><span>Approved release</span>${options.length > 1 ? `<select name="releaseId">${options.map((release) => `<option value="${release.id}">v${release.version}</option>`).join("")}</select>` : `<input type="hidden" name="releaseId" value="${approved.id}"><input value="v${approved.version}" disabled aria-label="Approved release">`}</label></div>
    ${more("System behavior", `<label class="field"><span>Instructions</span><textarea name="instructions" rows="4" maxlength="4000">${value(ui, key, "instructions", recipe.profileInstructions)}</textarea><small>Instructions shape tone and focus. They cannot grant tools or permissions.</small></label>`)}
    <div class="actions mt10"><button type="submit" class="secondary">Create assistant</button></div></form>`;
}

