import { agentReadiness } from "./agent-studio.js";
import { AGENT_STARTERS, configurableStages, type AgentConfigurable } from "./agent-configurables.js";
import { agentHash, blockingTestReviews, passedCurrentTest, type AgentTestRun, type AgentTestsSnapshot } from "./agent-tests-model.js";
import { BOT_REPOSITORY_TOOLS, effectiveToolPolicy } from "./bot-schema.js";
import type { ChatModelOption } from "./chat.js";
import type { PipelineConfig } from "./pipeline.js";
import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page, StudioUi } from "./studio-view.js";
import { ago, duration, empty, escape, more, status, when } from "./ui.js";

/**
 * Agent Studio: one agent at a time, in the order a person configures it.
 *
 * Overview is the library. An agent then has three pages: Knowledge and
 * tools (what it may do), Test (what it did on a saved prompt), Workflow
 * (where it works and who reviews it). The header keeps the agent, its
 * saved version and the next action in view on every page, and the
 * technical detail sits behind disclosures so an analyst can finish the
 * basic path without reading JSON.
 */

const toolLabels: Record<typeof BOT_REPOSITORY_TOOLS[number], string> = { list_project_files: "Find project files", read_project_file: "Read file contents", project_diff: "Inspect changes" };
export type StudioSection = "setup" | "test" | "workflow";
const SECTIONS: { id: StudioSection; label: string; path: string }[] = [{ id: "setup", label: "Knowledge & tools", path: "" }, { id: "test", label: "Test", path: "/test" }, { id: "workflow", label: "Workflow", path: "/workflow" }];

/** The runs for one agent, newest first, with whether each still matches the saved version. */
export function agentTestHistory(agent: AgentConfigurable, tests: AgentTestsSnapshot | undefined) {
  const current = agentHash(agent);
  const runs = (tests?.runs ?? []).filter(run => run.agentId === agent.id).slice().reverse();
  return { current, cases: (tests?.cases ?? []).filter(item => item.agentId === agent.id), runs: runs.map(run => ({ run, stale: run.agentHash !== current })) };
}

/** The one thing to do next for this agent, derived from what is saved and what was tested. */
export function nextAction(snapshot: WorkbenchSnapshot, agent: AgentConfigurable, models: ChatModelOption[], tests: AgentTestsSnapshot | undefined): { label: string; href: string } {
  const id = agent.id;
  if (!models.some(model => model.id === agent.model && model.available)) return { label: "Choose a connected model", href: `#/agent-studio/${id}` };
  if (!effectiveToolPolicy(agent.bot).allowedTools.length && agent.bot.requireSourceRead) return { label: "Choose tools", href: `#/agent-studio/${id}` };
  const history = agentTestHistory(agent, tests);
  const latest = history.runs[0];
  if (!latest) return { label: "Run test", href: `#/agent-studio/${id}/test` };
  if (latest.run.status === "running") return { label: "Wait for the test", href: `#/agent-studio/${id}/test` };
  if (latest.stale) return { label: "Run test again", href: `#/agent-studio/${id}/test` };
  if (blockingTestReviews(agent, tests).length) return { label: "Resolve review and retest", href: `#/agent-studio/${id}/test` };
  if (latest.run.status !== "succeeded") return { label: "Fix and run test again", href: `#/agent-studio/${id}/test` };
  if (!latest.run.review) return { label: "Review result", href: `#/agent-studio/${id}/test` };
  const assigned = snapshot.pipelines ? configurableStages(snapshot.pipelines.config, agent) : [];
  if (!assigned.length) return { label: "Assign to workflow", href: `#/agent-studio/${id}/workflow` };
  return { label: "Run in a workflow", href: `#/agent-studio/${id}/workflow` };
}

function outcomePill(entry: { run: AgentTestRun; stale: boolean } | undefined): string {
  if (!entry) return status("neutral", "Not tested");
  const { run, stale } = entry;
  const execution = run.status === "running" ? status("progress", "Running") : run.status === "succeeded" ? status("ok", "Execution finished") : status("bad", run.status === "cancelled" ? "Stopped" : "Execution failed");
  const review = run.review ? status(run.review.verdict === "pass" ? "ok" : run.review.verdict === "fail" ? "bad" : "warn", `Review: ${run.review.verdict}`) : run.status === "succeeded" ? status("neutral", "Review pending") : "";
  return `${execution}${review}${stale ? status("warn", "Out of date") : ""}`;
}

function configStatus(snapshot: WorkbenchSnapshot, agent: AgentConfigurable, models: ChatModelOption[]): string {
  const checks = agentReadiness(snapshot, agent, models).checks.filter(check => check.label !== "Saved agent assigned");
  const missing = checks.filter(check => !check.ready).map(check => check.label.toLowerCase());
  return missing.length ? status("warn", `Needs ${missing.join(", ")}`) : status("ok", "Ready to run");
}

export function agentStudioPage(snapshot: WorkbenchSnapshot, id: string | undefined, preset: string | null, models: ChatModelOption[], ui: StudioUi, section: StudioSection = "setup", tests?: AgentTestsSnapshot): Page {
  const page = { title: "Agent Studio", context: "Describe the job, choose knowledge and tools, test, then assign." };
  const pipeline = snapshot.pipelines;
  if (!pipeline) return { ...page, body: empty("Workflow storage is unavailable.") };
  const agents = pipeline.config.configurables ?? [];
  const admin = snapshot.roles.includes("admin");
  const selected = agents.find(agent => agent.id === id);
  if (id && id !== "new" && !selected) return { ...page, body: empty("This agent is not in this workspace.", { label: "Agent Studio", attrs: 'href="#/agent-studio"' }) };
  if (!id) return overview(snapshot, pipeline, agents, models, ui, tests, admin);
  const starter = AGENT_STARTERS.find(item => item.id === preset) ?? AGENT_STARTERS[0];
  const title = selected?.name ?? "New agent";
  const crumbs: [string, string][] = [["Agent Studio", "#/agent-studio"]];
  const head = selected ? header(snapshot, selected, models, tests, section) : "";
  const body = !selected || section === "setup" ? setup(snapshot, pipeline, selected, starter, models, ui, tests, admin)
    : section === "test" ? testPage(snapshot, pipeline, selected, models, ui, tests)
    : workflowPage(snapshot, pipeline, selected, models, admin, tests);
  return { ...page, title, crumbs, actions: '<a class="secondary" href="#/canvas">Workflow canvas</a><button class="secondary" id="refresh-models">Refresh models</button>', body: `<div class="agent-studio">${head}${selected ? preparation(snapshot, selected, models, tests) : ""}${body}</div>` };
}

function preparation(snapshot: WorkbenchSnapshot, agent: AgentConfigurable, models: ChatModelOption[], tests?: AgentTestsSnapshot): string {
  const model = models.find(item => item.id === agent.model && item.available);
  const policy = effectiveToolPolicy(agent.bot);
  const sourceRequired = agent.bot.requireSourceRead || agentTestHistory(agent, tests).cases.some(item => !!item.source);
  const limitsReady = !sourceRequired || (policy.allowedTools.includes("read_project_file") && policy.maxToolCalls >= 1 && agent.bot.maxSteps >= 2);
  const setup = `#/agent-studio/${escape(agent.id)}`;
  const latest = agentTestHistory(agent, tests).runs[0];
  const checks = [
    { label: "Model", value: model ? agent.model : "Not connected", ready: !!model, href: setup },
    { label: "Repository", value: snapshot.bots?.project ? "Attached" : "Connect repository", ready: !!snapshot.bots?.project, href: "#/desk/new" },
    { label: "Source access", value: limitsReady ? agent.bot.requireSourceRead ? "Read required" : "Optional" : "Fix tools or limits", ready: limitsReady, href: setup },
    { label: "Execution", value: snapshot.bots && !snapshot.bots.busy && !tests?.busy ? "Available" : "Busy or unavailable", ready: !!snapshot.bots && !snapshot.bots.busy && !tests?.busy, href: "#/desk" },
  ];
  const issue = latest && !latest.stale && latest.run.status !== "running" && latest.run.status !== "succeeded"
    ? `<p class="agent-prep-warning">Last test stopped. Check its evidence, shorten the task or choose another connected model. <a href="${setup}/test">View result</a></p>` : "";
  return `<section class="agent-preparation" aria-label="Preparation"><div class="agent-section-heading"><h2>Preparation</h2><span class="text-2">Saved configuration · availability is not a performance test</span></div><dl class="agent-prep-grid">${checks.map(check => `<div><dt>${check.label}</dt><dd>${check.ready ? `<span class="agent-check" aria-label="Ready">✓</span> ${escape(check.value)}` : `<a href="${check.href}">${escape(check.value)}</a>`}</dd></div>`).join("")}</dl><div class="agent-prep-footer"><span>${agent.bot.maxSteps} model calls · ${policy.maxToolCalls} tool calls · ${agent.bot.timeoutSeconds}s limit</span><span>${model?.local ? "Local model · begin with one short source" : "Only send source material allowed for this provider"}</span></div>${issue}</section>`;
}

// ------------------------------------------------------------------ overview

function overview(snapshot: WorkbenchSnapshot, pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, agents: AgentConfigurable[], models: ChatModelOption[], ui: StudioUi, tests: AgentTestsSnapshot | undefined, admin: boolean): Page {
  const page = { title: "Agent Studio", context: "Describe the job, choose knowledge and tools, test, then assign." };
  const stages = `<section class="agent-studio-stages" aria-labelledby="agent-workflow"><header class="agent-section-heading"><h2 id="agent-workflow">Your workflow</h2><a class="secondary" href="#/canvas">Open canvas</a></header><div>${pipeline.config.stages.map(stage => `<a href="#/workflows/${escape(stage.id)}"><strong>${escape(stage.name)}</strong><span>${escape(stage.agent)}</span><small>${stage.assistantId ? "Approved assistant" : stage.bot?.kind && stage.bot.kind !== "manual" ? "Supervised agent" : "Manual"}${stage.approval ? " · Review gate" : ""}</small></a>`).join("")}</div></section>`;
  const library = agents.length ? `<div class="agent-studio-library">${agents.map(agent => {
    const history = agentTestHistory(agent, tests);
    const assigned = configurableStages(pipeline.config, agent);
    const next = nextAction(snapshot, agent, models, tests);
    return `<article class="agent-studio-card"><div class="agent-card-head"><h2><a href="#/agent-studio/${escape(agent.id)}">${escape(agent.name)}</a></h2><code class="agent-version" title="Saved version">v${history.current}</code></div><p>${escape(agent.purpose)}</p>
      <dl class="agent-kv"><div><dt>Configuration</dt><dd>${configStatus(snapshot, agent, models)}</dd></div><div><dt>Latest test</dt><dd>${outcomePill(history.runs[0])}</dd></div><div><dt>Workflow</dt><dd>${assigned.length ? assigned.map(stage => `<a href="#/workflows/${escape(stage.id)}">${escape(stage.name)}</a>`).join(", ") : '<span class="text-3">Not assigned</span>'}</dd></div></dl>
      <small>${escape(agent.model)} · ${effectiveToolPolicy(agent.bot).allowedTools.length} tools${agent.bot.requireSourceRead ? " · source read required" : ""}</small><a class="btn small" href="${escape(next.href)}">${escape(next.label)}</a></article>`;
  }).join("")}</div>` : empty("No agents yet. Start with a job below.");
  const templates = admin ? `<section aria-labelledby="agent-templates"><h2 id="agent-templates">Start with a job</h2><div class="agent-studio-templates">${AGENT_STARTERS.map(item => `<a href="#/agent-studio/new?preset=${item.id}"><strong>${escape(item.name)}</strong><span>${escape(item.purpose)}<small>Example: ${escape(item.example.title)}${item.needs ? ` · ${escape(item.needs)}` : ""}</small></span><span aria-hidden="true">↗</span></a>`).join("")}</div></section>` : "";
  const importForm = admin ? more("Import an agent (advanced)", `<form id="agent-studio-import" data-version="${pipeline.version}"><label>Definition JSON<textarea name="definition" required maxlength="20000" rows="6" spellcheck="false"></textarea></label><p class="text-3">Creates a separate copy. Review its instructions and tools before assigning it.</p><button class="secondary">Import copy</button></form>`) : "";
  return { ...page, actions: admin ? '<a class="secondary" href="#/marketplace">Browse agents</a> <a class="primary" href="#/agent-studio/new">Create agent</a>' : "", body: `<div class="agent-studio"><section aria-labelledby="saved-agents"><header class="agent-section-heading"><h2 id="saved-agents">Saved agents <span class="agent-count">(${agents.length})</span></h2><span class="text-2">${pipeline.storage === "file" ? "Saved in this workspace" : "Demo · resets on restart"}${admin ? "" : " · An admin manages agent definitions"}</span></header>${library}</section>${templates ? more("Start from a template", templates) : ""}${stages}${importForm}</div>` };
}

// -------------------------------------------------------------------- header

function header(snapshot: WorkbenchSnapshot, agent: AgentConfigurable, models: ChatModelOption[], tests: AgentTestsSnapshot | undefined, section: StudioSection): string {
  const history = agentTestHistory(agent, tests);
  const next = nextAction(snapshot, agent, models, tests);
  const nav = SECTIONS.map(item => `<a href="#/agent-studio/${escape(agent.id)}${item.path}" ${item.id === section ? 'aria-current="page"' : ""}>${escape(item.label)}</a>`).join("");
  return `<header class="agent-studio-head"><div><span class="label">Saved version</span><code class="agent-version">v${history.current}</code></div><div><span class="label">Latest test</span>${outcomePill(history.runs[0])}</div><div><span class="label">Next step</span><a class="btn small" href="${escape(next.href)}">${escape(next.label)}</a></div><nav class="agent-studio-nav" aria-label="Agent pages">${nav}</nav></header>`;
}

// --------------------------------------------------------------------- setup

function setup(snapshot: WorkbenchSnapshot, pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, selected: AgentConfigurable | undefined, starter: typeof AGENT_STARTERS[number], models: ChatModelOption[], ui: StudioUi, tests: AgentTestsSnapshot | undefined, admin: boolean): string {
  const draftKey = `agent-studio:${selected ? selected.id : "new:" + starter.id}`;
  const draft = ui.drafts[draftKey];
  const value = (key: string, fallback: string) => escape(draft?.[key] ?? fallback);
  const model = draft?.model ?? selected?.model ?? snapshot.chat.model ?? models.find(item => item.available)?.id ?? "";
  const choices = [...models];
  if (model && !choices.some(item => item.id === model)) choices.push({ id: model, label: model, provider: "Saved model", available: false, local: false, detail: "Connection not verified." });
  const tools: readonly string[] = draft?.tools !== undefined ? draft.tools.split(",") : selected?.bot.allowedTools ?? starter.tools;
  const requireRead = draft?.requireSourceRead !== undefined ? draft.requireSourceRead === "true" : selected?.bot.requireSourceRead ?? starter.requireSourceRead;
  const canEdit = admin ? "" : "disabled";
  const version = draft?.expectedVersion ?? String(pipeline.version);
  const options = choices.map(item => `<option value="${escape(item.id)}" ${item.id === model ? "selected" : ""}>${escape(item.label)}${item.available ? "" : " · not connected"}</option>`).join("");
  const project = snapshot.bots?.project;
  const example = selected ? "" : `<input type="hidden" name="exampleTitle" value="${escape(starter.example.title)}"><input type="hidden" name="examplePrompt" value="${escape(starter.example.prompt)}"><input type="hidden" name="exampleExpected" value="${escape(starter.example.expected)}"><input type="hidden" name="exampleSource" value="${escape(starter.example.source)}">`;
  const editor = `<form id="agent-studio-editor" data-agent="${selected?.id ?? ""}" data-draft="${draftKey}" data-version="${escape(version)}" class="agent-studio-editor"><fieldset ${canEdit}>
    <legend>Instructions</legend><p class="text-2">How the agent should work. ${selected ? "" : `Prefilled from the ${escape(starter.name)} job; edit freely.`}</p>
    <label>Name<input name="name" required maxlength="80" value="${value("name", selected?.name ?? starter.name)}"></label>
    <label>Outcome<input name="purpose" required maxlength="300" value="${value("purpose", selected?.purpose ?? starter.purpose)}"></label>
    <label>Instructions<textarea name="instructions" required maxlength="4000" rows="7">${value("instructions", selected?.instructions ?? starter.instructions)}</textarea></label>${example}
    <legend>Knowledge</legend><p class="text-2">Evidence the agent can reference. It reads files from the attached repository through the tools below; reference material attached to a work item is passed in as well.</p>
    <dl class="agent-kv"><div><dt>Repository</dt><dd>${project ? `<code>${escape(project.root)}</code>` : 'None attached. <a href="#/desk/new">Add source</a> from Work items.'}</dd></div><div><dt>Validation command</dt><dd>${project?.checks.length ? project.checks.map(check => `<code>${escape([check.executable, ...check.args].join(" "))}</code>`).join(", ") : '<span class="text-3">None</span>'}</dd></div><div><dt>Documents</dt><dd><a href="#/documents">Reference documents</a> attach to a work item, not to the agent.</dd></div></dl>
    <fieldset class="agent-studio-tools"><legend>Tools</legend><p class="text-2">Actions the agent may request. Only implemented, read only tools are listed.</p>${BOT_REPOSITORY_TOOLS.map(tool => `<label class="checkbox"><input type="checkbox" name="tools" value="${tool}" ${tools.includes(tool) ? "checked" : ""}>${toolLabels[tool]} <span class="text-3">· ${tool}</span></label>`).join("")}<small>Repository reads only. Nothing checked means no file access. Additional external servers are not connected by this form.</small></fieldset>
    <div class="form-grid"><label>Model<select name="model" required>${options || '<option value="">Connect a model first</option>'}</select></label><label>Role<select name="kind">${["planner", "coder", "reviewer", "validator"].map(kind => `<option ${kind === (draft?.kind ?? selected?.bot.kind ?? starter.kind) ? "selected" : ""}>${kind}</option>`).join("")}</select></label></div>
    <small>Models use this server's configured providers; personal chat connections are not used here. <a href="#/chat">Check model availability</a>. Automatic model routing is not available on this execution path: the saved model is the one that runs.</small>
    ${more("Execution limits", `<div class="form-grid"><label>Model calls<input name="maxSteps" type="number" min="1" max="12" required value="${value("maxSteps", String(selected?.bot.maxSteps ?? 4))}"></label><label>Seconds<input name="timeoutSeconds" type="number" min="15" max="900" required value="${value("timeoutSeconds", String(selected?.bot.timeoutSeconds ?? 120))}"></label><label>Tool calls<input name="maxToolCalls" type="number" min="0" max="11" required value="${value("maxToolCalls", String(selected?.bot.maxToolCalls ?? 3))}"></label></div><small>How much work one run may do. The run stops at the first limit it reaches.</small>`)}
    <legend>Review</legend><label class="checkbox"><input type="checkbox" name="requireSourceRead" ${requireRead ? "checked" : ""}>Require a source read before any answer</label><small>Blocks an answer until a file read returned content. A read proves access, not accuracy; a person still reviews the answer.</small>
    <p class="text-2">Workflow handoffs from this agent wait for ${pipeline.runs[0]?.requiredApprovals ?? snapshot.workflow.requiredApprovals} independent approvals on gated stages. See the Workflow page.</p>
    <div class="agent-studio-actions"><button class="primary">Save agent</button><a href="#/agent-studio">Back to agents</a>${selected ? `<a href="#/agent-studio/${escape(selected.id)}/test">Run test →</a>` : ""}</div></fieldset></form>`;
  const aside = selected ? sideActions(snapshot, pipeline, selected, models, ui, tests, admin) : `<aside class="agent-studio-review" aria-label="Next steps"><h2>After saving</h2><p>The example task becomes this agent's first saved test. Run it on the Test page, review the result, then assign the agent to a stage.</p>${starter.needs ? `<p class="callout warn">${escape(starter.needs)}</p>` : ""}<details><summary>Execution and approvals</summary><p>This is a supervised configuration, not an approved model release. Model training and release signatures remain in <a href="#/studio">Model Studio</a>.</p></details></aside>`;
  return `<div class="agent-studio-layout">${editor}${aside}</div>`;
}

function sideActions(snapshot: WorkbenchSnapshot, pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, selected: AgentConfigurable, models: ChatModelOption[], ui: StudioUi, tests: AgentTestsSnapshot | undefined, admin: boolean): string {
  const readiness = agentReadiness(snapshot, selected, models);
  const tryKey = `agent-trial:${selected.id}`;
  const trial = ui.drafts[tryKey];
  const history = pipeline.runs.filter(run => { const saved = run.config.configurables?.find(agent => agent.id === selected.id); return saved && configurableStages(run.config, saved).length; }).slice(0, 5);
  const assign = assignForm(pipeline, selected, admin, tests);
  const trialForm = `<section class="agent-studio-trial"><h3>Run in a workflow</h3><ul class="agent-readiness">${readiness.checks.map(check => `<li><span aria-label="${check.ready ? "Ready" : "Needed"}">${check.ready ? "✓" : "○"}</span>${check.ready ? escape(check.label) : `<a href="${check.href}">${escape(check.label)}</a>`}</li>`).join("")}</ul>
    <form id="agent-studio-start" data-agent="${selected.id}" data-version="${pipeline.version}" data-draft="${tryKey}"><label>Task<input name="title" required minlength="3" maxlength="160" value="${escape(trial?.title ?? selected.purpose)}"></label><label>Expected result<textarea name="brief" rows="3" required maxlength="4000" placeholder="What should the agent produce? How will you check it?">${escape(trial?.brief ?? "")}</textarea></label><button class="primary" ${readiness.ready && snapshot.canAuthor ? "" : "disabled"}>Start workflow</button></form>
    <small>Starts at ${escape(pipeline.config.stages[0]!.name)}. Run each agent from the work item; review gates stay in place.</small>
    ${!snapshot.demo && pipeline.config.stages.some(stage => stage.approval) ? '<small>Gated stages need another reviewer. A single local owner cannot approve their own work.</small>' : ""}
    ${history.length ? `<h3>Recent runs</h3><ul class="agent-recent-runs">${history.map(run => `<li><a href="#/desk/${run.id}">${escape(run.title)}</a><small>${escape(run.status)} · v${run.version}</small></li>`).join("")}</ul>` : ""}</section>`;
  const latest = agentTestHistory(selected, tests).runs[0];
  return `<section class="agent-studio-review" aria-label="Agent review"><div class="agent-section-heading"><h2>Test and assign</h2><a href="#/agent-studio/${escape(selected.id)}/test">Open tests</a></div><p>${latest ? `Latest test ${escape(ago(latest.run.startedAt))}: ${outcomePill(latest)}` : "Not tested yet."}</p><details><summary>Assign and start a workflow</summary>${assign}${trialForm}</details><details><summary>Execution and approvals</summary><p>Attach a repository, test the saved agent, then assign it to a stage.</p><p>This is a supervised configuration, not an approved model release. Release signatures remain in <a href="#/studio">Model Studio</a>.</p><p>Additional external servers are not connected by this form.</p></details>${more("Advanced", `<button class="secondary" data-agent-export="${selected.id}">Copy saved definition</button><p class="text-3">Saved version v${agentHash(selected)} · workspace configuration ${pipeline.version}</p>`)}</section>`;
}

function assignForm(pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, selected: AgentConfigurable, admin: boolean, tests?: AgentTestsSnapshot): string {
  const stageChoices = pipeline.config.stages.filter(stage => !stage.assistantId);
  const tested = passedCurrentTest(selected, tests);
  const blocked = blockingTestReviews(selected, tests);
  const reason = blocked.length ? "Quality review blocks assignment. Rerun the rejected cases and obtain a passing review, or revise the agent and test the new version." : "Run a passing test on this version before assigning it.";
  const gate = tested ? '<p class="text-3">Test execution finished. Assignment is not release approval.</p>' : `<p class="callout warn">${reason} <a href="#/agent-studio/${selected.id}/test">Open tests</a></p>`;
  const evidence = blocked.length ? `<ul>${blocked.map(run => `<li>${escape(run.prompt)} — ${escape(run.review!.verdict)}${run.review!.note ? `: ${escape(run.review!.note)}` : ""}</li>`).join("")}</ul>` : "";
  return `<form id="agent-studio-assign" data-agent="${selected.id}" data-version="${pipeline.version}">${gate}${evidence ? more("Review blockers", evidence) : ""}<label>Workflow stage<select name="stage" required ${stageChoices.length ? "" : "disabled"}>${stageChoices.map(stage => `<option value="${escape(stage.id)}">${escape(stage.name)}</option>`).join("")}</select></label><button class="secondary" ${admin && stageChoices.length && tested ? "" : "disabled"}>Assign saved agent</button><small>Uses the saved definition for future runs. Existing runs and review gates keep their settings.</small></form>`;
}

// ---------------------------------------------------------------------- test

function testPage(snapshot: WorkbenchSnapshot, pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, selected: AgentConfigurable, models: ChatModelOption[], ui: StudioUi, tests: AgentTestsSnapshot | undefined): string {
  const history = agentTestHistory(selected, tests);
  const author = snapshot.canAuthor;
  const reviewer = snapshot.roles.includes("approver") || snapshot.roles.includes("admin");
  const policy = effectiveToolPolicy(selected.bot);
  const draftKey = `agent-test:${selected.id}`;
  const draft = ui.drafts[draftKey];
  const editing = draft?.caseId ? history.cases.find(item => item.id === draft.caseId) : undefined;
  const value = (key: string, fallback: string) => escape(draft?.[key] ?? fallback);
  const busy = tests?.busy ?? false;
  const canPrepare = models.some(model => model.id === selected.model && model.available) && !!snapshot.bots?.project && !!snapshot.bots && !snapshot.bots.busy;
  const canRead = policy.allowedTools.includes("read_project_file") && policy.maxToolCalls >= 1 && selected.bot.maxSteps >= 2;
  const cases = history.cases.length ? `<ul class="agent-test-cases">${history.cases.map(item => {
    const runs = history.runs.filter(entry => entry.run.caseId === item.id);
    const ready = canPrepare && (!(selected.bot.requireSourceRead || item.source) || canRead);
    return `<li><div><strong>${escape(item.title)}</strong><small>${item.source ? `Source ${escape(item.source)} · ` : ""}${runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"} · last ${escape(ago(runs[0]!.run.startedAt))}` : "never run"}</small>${!ready ? '<small>Resolve model, repository or source-read limits in Preparation before running.</small>' : ""}</div><div class="actions"><form class="inline" id="agent-test-run-${escape(item.id)}" data-form="agent-test-run" data-case="${escape(item.id)}" data-version="${pipeline.version}"><button class="primary small" ${author && !busy && ready ? "" : "disabled"}>Run test</button></form><button type="button" class="quiet small" data-test-edit="${escape(item.id)}">Edit</button>${author ? `<details class="agent-test-menu"><summary>More</summary><button type="button" class="quiet small" data-test-delete="${escape(item.id)}">Delete</button></details>` : ""}</div></li>`;
  }).join("")}</ul>` : '<p class="text-2">No saved tests. Write one below.</p>';
  const form = `<form id="agent-test-case" data-agent="${selected.id}" data-draft="${draftKey}" ${editing ? `data-case="${escape(editing.id)}"` : ""} class="agent-test-form"><fieldset ${author ? "" : "disabled"}><legend>${editing ? "Edit test" : "New test"}</legend>
    <label>Title<input name="title" required maxlength="120" value="${value("title", editing?.title ?? "")}"></label>
    <label>Test prompt<textarea name="prompt" required maxlength="4000" rows="4" placeholder="The task, as a person would hand it over.">${value("prompt", editing?.prompt ?? "")}</textarea></label>
    <label>Expected behaviour<textarea name="expected" maxlength="2000" rows="3" placeholder="What a good answer covers. Shown to the reviewer; never checked automatically.">${value("expected", editing?.expected ?? "")}</textarea></label>
    <label>Source file to read <span class="text-3">(path in the attached repository, optional)</span><input name="source" maxlength="250" value="${value("source", editing?.source ?? "")}" placeholder="SOP.md"></label>
    <p class="text-2">Permitted tools: ${policy.allowedTools.length ? policy.allowedTools.map(tool => toolLabels[tool as keyof typeof toolLabels] ?? tool).join(", ") : "none"}${selected.bot.requireSourceRead ? " · source read required" : ""} · up to ${selected.bot.maxSteps} model calls, ${policy.maxToolCalls} tool calls, ${selected.bot.timeoutSeconds} s.</p>
    <div class="actions"><button class="secondary">${editing ? "Save changes" : "Save test"}</button>${editing ? '<button type="button" class="quiet" data-test-edit="">Cancel</button>' : ""}</div></fieldset></form>`;
  const shown = draft?.runId ? history.runs.find(entry => entry.run.id === draft.runId) : history.runs[0];
  const result = shown ? testResult(shown, reviewer, snapshot.actor) : `<div class="empty"><p>No result yet. Save a test and run it.</p></div>`;
  const list = history.runs.length > 1 ? more(`All runs (${history.runs.length})`, `<ul class="agent-test-runs">${history.runs.map(entry => `<li><button type="button" class="quiet small" data-test-show="${escape(entry.run.id)}">${when(entry.run.startedAt)}</button> ${outcomePill(entry)} <small>v${entry.run.agentHash}</small></li>`).join("")}</ul>`) : "";
  const running = history.runs.find(entry => entry.run.status === "running")?.run;
  const stop = busy && running && (snapshot.roles.includes("admin") || (author && running.startedBy === snapshot.actor)) ? `<form data-form="agent-test-stop" data-run="${escape(running.id)}"><button class="secondary" type="submit">Stop test</button></form>` : "";
  return `<div class="agent-test-layout"><section class="agent-test-side" aria-label="Saved tests"><h2>Saved tests</h2>${cases}<details class="agent-test-compose" ${editing || !history.cases.length || draft?.title || draft?.prompt ? "open" : ""}><summary>${editing ? "Edit test" : "Add test case"}</summary>${form}</details></section><section class="agent-test-result-wrap" aria-label="Result and evidence"><div class="agent-section-heading"><h2>Result and evidence</h2>${stop}</div>${busy ? '<p class="loading" role="status">Running · evidence updates as tools finish.</p>' : ""}${result}${list}</section></div>`;
}

function testResult(entry: { run: AgentTestRun; stale: boolean }, reviewer: boolean, actor: string): string {
  const { run, stale } = entry;
  const elapsed = run.finishedAt ? duration(run.startedAt, run.finishedAt) : "running";
  const usage = run.tokenUsage ? `${run.tokenUsage.promptTokens} input · ${run.tokenUsage.completionTokens} output (reported by the provider)` : run.status === "running" ? "Waiting for provider usage" : "Not reported by this model";
  const calls = run.toolCalls.length ? `<ul class="plain">${run.toolCalls.map(call => `<li><code>${escape(call.name)}</code>${call.path ? ` ${escape(call.path)}` : ""} · ${call.outcome === "read" ? "read, content returned" : call.outcome === "empty" ? "read, file empty" : call.outcome === "missing" ? "read, file missing" : "called"}</li>`).join("")}</ul>` : '<span class="text-3">No tool calls</span>';
  const requestedRead = run.toolCalls.some(call => call.path === run.source && call.outcome === "read");
  const evidence = run.source ? (requestedRead ? status("ok", `Read ${run.source}`) : run.status === "running" ? status("progress", "Waiting for source evidence") : status("bad", `${run.source} was not read`)) : run.sourceRead ? status("ok", "A source was read") : status("neutral", "No source read");
  const failure = run.error ? `<p class="callout bad" role="status"><strong>${run.status === "cancelled" ? "Stopped." : "Execution failed."}</strong>${escape(run.error)}</p>` : "";
  const staleNote = stale ? `<p class="callout warn" role="status"><strong>Out of date.</strong>This run tested version v${run.agentHash}; the agent has changed since. Run the test again before relying on it.</p>` : "";
  const answer = run.summary ? `<h3>Answer</h3><pre class="pre">${escape(run.summary)}</pre>` : "";
  const review = run.review ? `<h3>Quality review</h3><p>${status(run.review.verdict === "pass" ? "ok" : run.review.verdict === "fail" ? "bad" : "warn", run.review.verdict)} by ${escape(run.review.by)} · ${escape(ago(run.review.at))}${run.review.note ? `<br>${escape(run.review.note)}` : ""}</p>`
    : run.status === "running" ? "" : run.status !== "succeeded" ? `<h3>Quality review</h3><p class="text-2">No answer to review: the execution did not finish. Fix the cause and run the test again.</p>` : `<h3>Quality review</h3>${reviewer ? `<form id="agent-test-review" data-run="${escape(run.id)}" class="agent-test-review"><p class="text-2">Did the answer do what the test expected? This is separate from the execution finishing.</p><div class="actions"><label class="checkbox"><input type="radio" name="verdict" value="pass" required>Pass</label><label class="checkbox"><input type="radio" name="verdict" value="fail">Fail</label><label class="checkbox"><input type="radio" name="verdict" value="unsure">Unsure</label></div><label>Note<textarea name="note" maxlength="2000" rows="2" placeholder="What was right or wrong, against the expected behaviour."></textarea></label><button class="secondary">Record review</button></form>` : '<p class="text-2">An approver or admin records the quality review.</p>'}`;
  return `<article class="agent-test-result" aria-label="Test result">${staleNote}<div class="agent-test-status">${outcomePill(entry)}</div>${failure}
    <dl class="agent-kv"><div><dt>Prompt</dt><dd>${escape(run.prompt)}</dd></div>${run.expected ? `<div><dt>Expected</dt><dd>${escape(run.expected)}</dd></div>` : ""}<div><dt>Evidence</dt><dd>${evidence}</dd></div><div><dt>Tool calls</dt><dd>${calls}</dd></div><div><dt>Model</dt><dd><code>${escape(run.model)}</code></dd></div><div><dt>Model calls</dt><dd>${run.calls}</dd></div><div><dt>Tokens</dt><dd>${escape(usage)}</dd></div><div><dt>Elapsed</dt><dd>${escape(elapsed)}</dd></div><div><dt>Started</dt><dd>${when(run.startedAt)} by ${escape(run.startedBy)}${run.startedBy === actor ? " (you)" : ""}</dd></div><div><dt>Version</dt><dd><code>v${run.agentHash}</code></dd></div></dl>
    ${answer}${review}${more("Execution log", `<ul class="plain">${run.events.map(event => `<li>${escape(event)}</li>`).join("") || "<li>No events</li>"}</ul>`)}</article>`;
}

// ------------------------------------------------------------------ workflow

function workflowPage(snapshot: WorkbenchSnapshot, pipeline: NonNullable<WorkbenchSnapshot["pipelines"]>, selected: AgentConfigurable, models: ChatModelOption[], admin: boolean, tests: AgentTestsSnapshot | undefined): string {
  const assigned = configurableStages(pipeline.config, selected);
  const stages = pipeline.config.stages;
  const approvals = snapshot.workflow.requiredApprovals;
  const row = (stage: PipelineConfig["stages"][number]) => {
    const index = stages.findIndex(item => item.id === stage.id);
    const next = stages[index + 1];
    const policy = stage.bot ? effectiveToolPolicy(stage.bot) : { allowedTools: [] as string[] };
    return `<article class="agent-stage-card"><h3>${escape(stage.name)} <small class="text-3">stage ${index + 1} of ${stages.length}</small></h3><dl class="agent-kv">
      <div><dt>Input</dt><dd>${escape(stage.context)}${index ? `; the recorded outputs of ${stages.slice(0, index).map(item => escape(item.name)).join(", ")}` : ""}; reference material attached to the work item.</dd></div>
      <div><dt>Output</dt><dd>${stage.bot?.profile ? `A handoff with the ${escape(stage.bot.profile)} sections` : stage.bot?.kind === "coder" ? "A summary and proposed file changes a person applies" : "A summary with findings and evidence"}; recorded as the stage output when the owner accepts it.</dd></div>
      <div><dt>Tools</dt><dd>${policy.allowedTools.length ? policy.allowedTools.map(tool => toolLabels[tool as keyof typeof toolLabels] ?? tool).join(", ") : "None"}${stage.bot?.requireSourceRead ? " · source read required" : ""}</dd></div>
      <div><dt>Review</dt><dd>${stage.approval ? `${approvals} independent approvals from approvers who are not the run owner or the output author. This is a workflow handoff approval, not a model release approval.` : "No review gate; the owner's acceptance completes the stage."}</dd></div>
      <div><dt>Next</dt><dd>${next ? `${escape(next.name)} (${escape(next.agent)})` : "The run is complete."}</dd></div></dl><a class="quiet small" href="#/workflows/${escape(stage.id)}">Stage settings</a></article>`;
  };
  const list = assigned.length ? assigned.map(row).join("") : '<p class="text-2">Not assigned to any stage yet. Choose one below.</p>';
  const open = pipeline.runs.filter(run => run.status === "running" || run.status === "paused" || run.status === "blocked").length;
  return `<div class="agent-studio-layout"><section class="agent-studio-editor" aria-label="Assigned stages"><h2>Where this agent works</h2>${list}<p class="text-2">${open ? `${open} open run${open === 1 ? " keeps" : "s keep"} the configuration they started with. ` : ""}Changes affect future runs only.</p></section><aside class="agent-studio-review" aria-label="Assign"><h2>Assign to workflow</h2>${assignForm(pipeline, selected, admin, tests)}${nextAction(snapshot, selected, models, undefined).label === "Choose a connected model" ? '<p class="callout warn">The saved model is not connected; a run would stop at its first model call.</p>' : ""}<a href="#/desk">Open work items →</a><p class="text-3">There is no publish step: a saved agent is available to this workspace's workflow once assigned. Release approval applies to trained models in Model Studio, not to agent configurations.</p></aside></div>`;
}
