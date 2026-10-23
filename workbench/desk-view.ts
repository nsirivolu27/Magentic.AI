import type { PipelineSnapshot, PipelineRun } from "./pipeline.js";
import type { BotSnapshot } from "./bot-schema.js";
import type { Role } from "../registry/roles.js";
import { DEVELOPMENT_PLAYBOOKS, type SessionDraft } from "./playbooks.js";
import { projectView } from "./bot-view.js";

export type SessionFilter = "all" | "active" | "review" | "complete";
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function latestAttempt(run: PipelineRun, bots?: BotSnapshot) {
  return bots?.attempts.findLast(attempt => attempt.runId === run.id
    && attempt.stageId === run.config.stages[run.current]?.id && attempt.revision === run.revision);
}

export function sessionNeedsReview(run: PipelineRun, bots?: BotSnapshot): boolean {
  if (run.status !== "running") return false;
  const attempt = latestAttempt(run, bots);
  return run.stages[run.current]?.status === "awaiting_review"
    || attempt?.status === "ready" || attempt?.status === "applied";
}

export function deskSessions(snapshot: PipelineSnapshot, bots: BotSnapshot | undefined, filter: SessionFilter, query: string): string {
  const runs = snapshot.runs.filter(run => {
    if (filter === "active" && !["running", "paused", "blocked"].includes(run.status)) return false;
    if (filter === "review" && !sessionNeedsReview(run, bots)) return false;
    if (filter === "complete" && run.status !== "complete") return false;
    return `${run.title} ${run.brief} ${run.issueKey ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!runs.length) return '<p class="desk-empty">No sessions match this view. Start a task or change the filter.</p>';
  return runs.map(run => {
    const stage = run.config.stages[run.current]!;
    const attempt = latestAttempt(run, bots);
    const status = sessionNeedsReview(run, bots) ? "Needs your review" : run.status === "running" && attempt?.status === "running" ? "Bot working" : run.status.replaceAll("_", " ");
    return `<button class="desk-session" data-desk-run="${escape(run.id)}"><span class="desk-session-main"><strong>${escape(run.title)}</strong><small>${escape(stage.name)} · ${escape(stage.bot?.kind ?? "manual")} · ${escape(stage.model)}</small></span><span class="desk-session-meta"><span class="pipeline-chip">${escape(status)}</span><small>${run.current + 1}/${run.stages.length} phases · ${escape(new Date(run.updatedAt).toLocaleString())}</small></span></button>`;
  }).join("");
}

export function deskView(snapshot: PipelineSnapshot | undefined, bots: BotSnapshot | undefined, roles: Role[], filter: SessionFilter, query: string, draft?: SessionDraft, selectedPlaybook?: string): string {
  if (!snapshot) return '<p class="empty">This workspace has no development pipeline configured.</p>';
  const canStart = roles.includes("admin") || roles.includes("author");
  const chosen = DEVELOPMENT_PLAYBOOKS.find(item => item.id === selectedPlaybook);
  return `<div class="desk-layout"><section class="desk-work"><div class="desk-composer"><p class="eyebrow">NEW DEVELOPMENT SESSION</p><h2>What are we building?</h2><p>Give the work a clear outcome. Follow each bot through planning, implementation, checks, and review.</p>
    <section class="playbook-section" aria-label="Development starters"><h3>Choose a starting point</h3><p class="muted">Your tools. Your stack. A clear definition of done.</p>
    <div class="playbook-grid">${DEVELOPMENT_PLAYBOOKS.map(item => `<button class="playbook-card" data-playbook="${item.id}" aria-pressed="${chosen?.id === item.id}"><small>${escape(item.category)}</small><strong>${escape(item.name)}</strong><span>${escape(item.description)}</span></button>`).join("")}</div>
    ${chosen ? `<div class="playbook-preview"><h4>${escape(chosen.name)} starter</h4><p>${escape(chosen.outcome)}</p><ul>${chosen.acceptance.map(item => `<li>${escape(item)}</li>`).join("")}</ul><p class="muted">${escape(chosen.context)}</p>${canStart ? `<button class="secondary" data-use-playbook="${chosen.id}">${draft?.title || draft?.brief ? "Replace draft with this starter" : "Use this starter"}</button>` : ""}<p class="muted">Prefills an editable brief. Your configured phases, models and review gates stay in effect.</p></div>` : ""}</section>
    ${canStart ? `<form id="desk-start"><label>Task name<input name="title" required minlength="3" maxlength="160" value="${escape(draft?.title ?? "")}" placeholder="Fix a bug, build a feature, investigate an idea…"></label><label>Outcome and acceptance criteria<textarea name="brief" rows="4" required maxlength="4000" placeholder="What should change? What will prove it works?">${escape(draft?.brief ?? "")}</textarea></label><div class="desk-compose-footer"><span>${escape(snapshot.config.name)} · v${snapshot.version}<small>Creates a session. Bots run when you start their phase.</small></span><button class="primary" type="submit">＋ Start session</button></div></form>` : '<p>Authors and admins can start development sessions.</p>'}
    </div><section class="desk-sessions" aria-label="Development sessions"><div class="desk-section-heading"><h3>Your sessions</h3><label class="desk-search">Search sessions<input id="desk-search" type="search" maxlength="160" value="${escape(query)}" placeholder="Task or issue key"></label></div><div class="desk-filters" role="group" aria-label="Filter sessions">${([['all', 'All'], ['active', 'In progress'], ['review', 'Needs review'], ['complete', 'Completed']] as const).map(([value, label]) => `<button class="secondary" data-desk-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join("")}</div><div id="desk-session-list">${deskSessions(snapshot, bots, filter, query)}</div></section></section>
    <aside class="desk-context" aria-label="Project context"><section class="desk-context-card"><p class="eyebrow">YOUR ENVIRONMENT</p><h3>${bots?.project ? 'Repository connected' : 'Connect a repository'}</h3><p>${bots?.project ? `<code>${escape(bots.project.root)}</code>` : 'Bring an existing Git project. Keep your editor and development tools.'}</p><p>${bots?.project ? `${bots.project.checks.length} validation commands configured` : 'Attach your repository below before running a bot.'}</p><span class="pipeline-chip">${snapshot.storage === 'file' ? 'Saved on this computer' : 'Temporary demo data'}</span></section>
    <section class="desk-context-card"><div class="desk-section-heading"><h3>Bot timeline</h3><button class="secondary" data-desk-config>Configure</button></div><ol class="desk-phases">${snapshot.config.stages.map((stage, index) => `<li><span>${index + 1}</span><div><strong>${escape(stage.name)}</strong><small>${escape(stage.bot?.kind ?? 'manual')} · ${escape(stage.model)}</small>${stage.approval ? '<small class="desk-gate">Independent review required</small>' : ''}</div></li>`).join('')}</ol><p class="muted">Each new session keeps these assignments. Changes to configuration do not alter existing sessions.</p></section>
    <section class="desk-context-card"><h3>Workspace tools</h3><div class="desk-tools"><button class="secondary" data-view="chat">✦ Ask the assistant</button><button class="secondary" data-view="mcp">⌘ Inspect MCP tools</button><button class="secondary" data-view="agents">▦ Agent definitions</button></div><p class="muted">You review proposed edits and request validation before handing work to the next phase.</p></section></aside></div>
    ${bots ? projectView(bots) : ''}`;
}
