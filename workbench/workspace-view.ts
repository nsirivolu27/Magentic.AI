import type { OntologyCatalog } from "./ontology.js";
import type { Role } from "../registry/roles.js";
import type { BotAttempt, BotSnapshot } from "./bot-schema.js";
import type { PipelineRun, PipelineSnapshot } from "./pipeline.js";
import type { SessionDraft } from "./playbooks.js";
import type { Material } from "./materials.js";

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function workList(snapshot: PipelineSnapshot, selected?: string, query = ""): string {
  const runs = snapshot.runs.filter(run => `${run.title} ${run.brief}`.toLowerCase().includes(query.toLowerCase()));
  return runs.length ? runs.map(run => `<button class="work-item" data-desk-run="${run.id}" aria-pressed="${run.id === selected}"><strong>${escape(run.title)}</strong><small>${escape(run.config.stages[run.current]!.name)} · ${escape(run.status)}</small></button>`).join("") : '<p class="muted">No work items yet. Start with one small improvement.</p>';
}

function materialList(materials: Material[], removable = false): string {
  return materials.map(item => `<details class="work-reference"><summary>${escape(item.title)}${item.content ? "" : " · link only"}</summary>${item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ""}${item.content ? `<pre>${escape(item.content)}</pre>` : '<p class="muted">The agent receives this link, but cannot fetch its contents. Add an excerpt when it needs the source text.</p>'}${removable ? `<button type="button" class="secondary" data-material-remove="${item.id}">Remove reference</button>` : ""}</details>`).join("");
}

function operation(attempt: BotAttempt, action: string, label: string, primary = true): string {
  return `<button class="${primary ? "primary" : "secondary"}" data-bot-action="${action}" data-bot-attempt="${attempt.id}" data-bot-hash="${escape(attempt.proposalHash)}">${label}</button>`;
}

export function workProgress(run: PipelineRun, bots: BotSnapshot | undefined, actor: string, roles: readonly Role[], phase = run.current): string {
  const definition = run.config.stages[phase]!;
  const stage = run.stages[phase]!;
  const attempt = bots?.attempts.filter(item => item.runId === run.id && item.stageId === definition.id).at(-1);
  const owner = roles.includes("admin") || (run.owner === actor && roles.includes("author"));
  const active = phase === run.current && run.status === "running" && stage.status === "active";
  const current = attempt?.revision === run.revision;
  let action = "";
  if (bots?.busy) action = `<p role="status">Agent or validation checks are working. Progress appears below.</p>${owner && attempt?.status === "running" ? operation(attempt, "cancel", "Stop agent", false) : ""}`;
  else if (phase === run.current && stage.status === "awaiting_review" && run.status === "running") {
    const eligible = (roles.includes("admin") || roles.includes("approver")) && actor !== run.owner && actor !== stage.outputBy && !stage.approvals.includes(actor);
    action = `<p>Independent review needed · ${stage.approvals.length} / ${run.requiredApprovals} approvals.</p>${eligible ? '<button class="primary" data-pipeline-action="approve">Approve this handoff</button>' : '<p class="muted">An independent reviewer must approve this output before the next phase can begin.</p>'}`;
  } else if (owner && phase === run.current && ["paused", "blocked"].includes(run.status)) {
    action = `<button class="primary" data-pipeline-action="${run.status === "paused" ? "resume" : "retry"}">Resume this work</button>`;
  } else if (active && owner) {
    if (!definition.bot || definition.bot.kind === "manual") action = '<p>This work item uses a manual phase. Record evidence below, or enable agents in workspace setup for a new work item.</p>';
    else if (!bots?.project) action = '<p>Connect the repository you want this agent to work in.</p><button class="primary" data-work-setup>Connect repository</button>';
    else if (attempt && current && ["ready", "applied"].includes(attempt.status)) {
      if (attempt.handoff?.blockers.length) action = '<p class="form-error">Resolve the reported blockers with a revision before handing off.</p>';
      else if (attempt.changes.length && attempt.status === "ready") action = operation(attempt, "apply", "Apply reviewed changes");
      else {
        const needsChecks = definition.bot.kind === "validator" || (definition.bot.kind === "coder" && bots.project.checks.length > 0);
        const checked = Boolean(attempt.checkedTree) && attempt.checks.length === bots.project.checks.length && attempt.checks.every(check => check.passed);
        action = needsChecks && !checked
          ? bots.project.checks.length ? operation(attempt, "checks", "Run validation checks") : '<p class="form-error">This validation agent needs configured checks. Create a workspace with checks to validate this repository.</p>'
          : operation(attempt, "accept", definition.approval ? "Submit for independent review" : "Accept and continue");
        if (checked) action += operation(attempt, "checks", "Recheck current files", false);
      }
    } else action = '<button class="primary" data-bot-action="start">Run this agent</button>';
  }
  const revise = active && owner && !bots?.busy && attempt && current && ["ready", "applied", "failed", "cancelled", "interrupted"].includes(attempt.status);
  return `<section id="work-progress" aria-label="Current agent"><div class="work-agent-heading"><div><p class="eyebrow">PHASE ${phase + 1} / ${run.stages.length}</p><h3>${escape(definition.agent)}</h3></div><span class="pipeline-chip">${escape(stage.status.replaceAll("_", " "))}</span></div><p>${escape(definition.instructions)}</p><div class="work-next">${action || '<p class="muted">Recorded work is available below.</p>'}</div>
    ${attempt ? `<article class="work-result"><h4>Latest result · ${escape(attempt.status)}</h4>${attempt.error ? `<p class="form-error">${escape(attempt.error)}</p>` : ""}<p>${escape(attempt.summary)}</p>${attempt.handoff ? attempt.handoff.sections.map(section => `<details><summary>${escape(section.title)}</summary><pre>${escape(section.body)}</pre></details>`).join("") + (attempt.handoff.blockers.length ? `<ul class="form-error">${attempt.handoff.blockers.map(blocker => `<li>${escape(blocker)}</li>`).join("")}</ul>` : "") : ""}
    ${attempt.changes.map(change => `<details><summary>Review change · ${escape(change.path)}</summary><h4>Before</h4><pre>${escape(change.before ?? "New file")}</pre><h4>After</h4><pre>${escape(change.after)}</pre></details>`).join("")}
    ${attempt.checks.map(check => `<details><summary>${check.passed ? "Passed" : "Failed"} · ${escape(check.command.executable)} ${escape(check.command.args.join(" "))}</summary><pre>${escape(check.output)}</pre></details>`).join("")}
    <details><summary>Execution details</summary><p>Model: ${escape(attempt.model)}</p><p>Checkout: <code>${escape(attempt.checkout)}</code></p><button class="secondary" data-bot-copy="${escape(attempt.checkout)}">Copy path for your editor</button>${attempt.events.map(event => `<p>${escape(event.message)}</p>`).join("")}</details></article>` : ""}
    ${revise ? `<details><summary>Request changes from this agent</summary><form id="work-revision" data-attempt="${attempt.id}" data-hash="${escape(attempt.proposalHash)}"><label>What should change?<textarea name="feedback" required maxlength="2000" rows="3"></textarea></label><button class="secondary">Run a revision</button></form></details>` : ""}
    ${stage.output ? `<details open><summary>Recorded handoff</summary><pre>${escape(stage.output)}</pre></details>` : ""}
    ${active && owner && !bots?.busy ? '<details><summary>Record your own phase evidence</summary><form id="pipeline-output"><label>Work completed and supporting evidence<textarea name="note" required maxlength="4000" rows="4"></textarea></label><button class="secondary">Record handoff</button></form></details>' : ""}
  </section>`;
}

export function workspaceView(snapshot: PipelineSnapshot | undefined, bots: BotSnapshot | undefined, actor: string, roles: readonly Role[], draft: SessionDraft, materials: Material[], selected?: string, phase?: number, query = "", ontology?: OntologyCatalog): string {
  if (!snapshot) return '<p class="empty">Workspace unavailable.</p>';
  const run = snapshot.runs.find(item => item.id === selected);
  const canStart = roles.includes("admin") || roles.includes("author");
  const references = new Map(snapshot.runs.flatMap(item => item.materials ?? []).map(item => [item.id, item]));
  const setup = `<details class="work-setup"><summary>Workspace setup · ${bots?.project ? "repository connected" : "connect your repository"}</summary><p>Magentic works beside your editor. Agents use an isolated checkout of committed HEAD.</p>${bots?.project ? `<p><code>${escape(bots.project.root)}</code> · ${bots.project.checks.length} validation commands</p>` : roles.includes("admin") ? '<form id="work-project"><label>Git repository path<input name="root" required placeholder="C:\\projects\\my-service"></label><div class="form-grid"><label>Check executable (optional)<input name="executable" placeholder="node"></label><label>Arguments · one per line<textarea name="args" rows="2" placeholder="--test"></textarea></label></div><p class="muted">Checks run only when requested, with your OS account. Configure them before the first agent attempt.</p><button class="secondary">Connect repository</button></form>' : '<p>An admin can connect a repository.</p>'}${roles.includes("admin") ? `<p>Phase agents use the existing models: ${escape([...new Set(snapshot.config.stages.map(item => item.model))].join(", "))}. Source excerpts are sent to that provider when an agent runs. Existing gates remain in place.</p><button class="secondary" data-work-enable>Enable phase agents for new work</button> <button class="secondary" data-desk-config>Advanced setup</button>` : ""}</details>`;
  return `<div class="work-shell"><aside class="work-list"><div class="work-list-heading"><h2>Work</h2>${canStart ? '<button class="secondary" data-work-new>＋ New</button>' : ""}</div><label class="search"><input id="desk-search" type="search" aria-label="Find work" placeholder="Find work…" value="${escape(query)}"></label><div id="desk-session-list">${workList(snapshot, selected, query)}</div></aside><div class="work-main">
    ${run ? `<header class="work-title"><p class="eyebrow">WORK ITEM</p><h2>${escape(run.title)}</h2><details><summary>Outcome and acceptance criteria</summary><p class="work-brief">${escape(run.brief)}</p></details></header><ol class="work-phases" aria-label="Development phases">${run.config.stages.map((item, index) => `<li><button data-bot-phase="${index}" aria-pressed="${index === (phase ?? run.current)}"><span>${run.stages[index]!.status === "complete" ? "✓" : index + 1}</span>${escape(item.name)}</button></li>`).join("")}</ol>${workProgress(run, bots, actor, roles, phase)}<details class="work-context"><summary>Reference material · ${run.materials?.length ?? 0}</summary><p class="muted">These saved excerpts and completed handoffs accompany every agent in this work item.</p>${materialList(run.materials ?? [])}</details><details><summary>Work history · ${run.events.length} events</summary>${run.events.slice().reverse().map(event => `<p><small>${escape(event.at)} · ${escape(event.actor)}</small><br>${escape(event.stage)} · ${escape(event.action)}</p>`).join("")}<button class="secondary" data-jira-history="${run.id}">Jira action history</button></details>`
    : canStart ? `<header class="work-title"><p class="eyebrow">ONE IMPROVEMENT AT A TIME</p><h2>What are you working on?</h2><p>Bring a task and its context. Work through each phase with an agent, then review the handoff.</p></header><form id="desk-start"><label>Work item<input name="title" required minlength="3" maxlength="160" value="${escape(draft.title)}" placeholder="Improve a service, fix a bug, or build a feature"></label><label>Desired outcome<textarea name="brief" required maxlength="4000" rows="4" placeholder="Who needs this, what should change, and how will we know it works?">${escape(draft.brief)}</textarea></label></form>
    <details class="work-context"><summary>Reference material · ${materials.length} selected</summary><p class="muted">Add requirements, design notes, or data excerpts. Text is saved with this work item and passed to each agent. Links are not fetched automatically.</p>${materialList(materials, true)}${ontology ? `<form id="work-ontology"><h3>${ontology.mode === "sample" ? "Sample Ontology" : "Foundry Ontology"} reference</h3><p class="muted">Read one object into this draft. Its saved snapshot will accompany each phase agent. ${ontology.mode === "sample" ? "Synthetic data only. Try Service / demo-service." : "Selected properties reach the phase model when it runs."}</p><label>Object type<select name="objectType">${ontology.objectTypes.map(type => `<option value="${escape(type.apiName)}">${escape(type.apiName)}</option>`).join("")}</select></label><label>Object ID<input name="primaryKey" required maxlength="200" placeholder="${ontology.mode === "sample" ? "demo-service" : "Object primary key"}"></label><button class="secondary">Read and add reference</button></form>` : ""}<form id="work-material"><label>Reference title<input name="title" required maxlength="120" placeholder="Service requirements"></label><label>Source link (optional)<input name="url" type="url" maxlength="2000" placeholder="https://…"></label><label>Excerpt or notes<textarea name="content" maxlength="6000" rows="4"></textarea></label><label>Or import a small text file<input id="work-material-file" type="file" accept=".txt,.md,.csv,.json"></label><button class="secondary">Add reference</button></form>${references.size ? `<label>Reuse from this workspace<select id="work-reuse"><option value="">Choose a reference…</option>${[...references.values()].map(item => `<option value="${item.id}">${escape(item.title)}</option>`).join("")}</select></label>` : ""}</details><div class="work-start-actions"><button class="primary" type="submit" form="desk-start">Start work item</button><button class="secondary" data-work-federal>${draft.title || draft.brief || materials.length ? "Replace draft with public-service example" : "Use public-service example"}</button></div><p class="muted">Example: an accessible disaster declaration finder using an OpenFEMA public-data source. A starter brief; no dataset is imported.</p>` : '<p>Select a work item to review its evidence.</p>'}
    ${setup}</div></div>`;
}
