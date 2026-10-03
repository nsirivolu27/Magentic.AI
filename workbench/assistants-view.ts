import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { ago, callout, cellLink, detail, empty, escape, graph, hint, more, panel, short, status, table, when } from "./ui.js";
import { candidateOf, configOf, eventText, projectOf, releaseOf, releaseStatusLabel, viewerOf } from "./studio-model.js";
import { assistantFlow, TOOL_NAMES } from "./flow-model.js";
import { agenticUnits } from "./units.js";

/**
 * Assistants: deployed capabilities, not chat presets.
 *
 * The built in workspace assistant is listed with the ones created from
 * approved releases, because a person asking "what can I use?" wants one
 * answer. A profile whose release is retired or whose own status is
 * disabled is shown, marked, and never offered for chat.
 */

export const WORKSPACE_ASSISTANT = "workspace";
const TOOLS = TOOL_NAMES;

export interface AssistantRow {
  id: string; name: string; purpose: string; release: string; releaseHref?: string; model: string; tools: string; workspace: string;
  usable: boolean; statusHtml: string; updatedAt: string;
}

export function assistantRows(snapshot: WorkbenchSnapshot): AssistantRow[] {
  const studio = snapshot.studio;
  const rows: AssistantRow[] = [{
    id: WORKSPACE_ASSISTANT, name: "Workspace assistant", purpose: "Answers questions about approved agents and workspace policy through MCP.",
    release: "Built in", model: snapshot.chat.model ?? "Not configured", tools: TOOLS.join(", "), workspace: snapshot.workspaceId,
    usable: snapshot.chat.configured, statusHtml: snapshot.chat.configured ? status("ok", "Available") : status("neutral", "Model not configured"), updatedAt: "",
  }];
  if (!studio) return rows;
  for (const profile of studio.profiles) {
    const release = releaseOf(studio, profile.releaseId);
    const project = projectOf(studio, release?.projectId);
    const candidate = project ? candidateOf(studio, project) : undefined;
    const config = configOf(studio, studio.jobs.find((job) => job.id === release?.jobId));
    const usable = profile.status === "active" && release?.status === "approved";
    rows.push({
      id: profile.id, name: profile.name, purpose: project ? `${studio.recipes.find((recipe) => recipe.id === project.recipeId)?.title ?? ""} · ${project.purpose || ""}`.replace(/ · $/, "") : "",
      release: release ? `v${release.version} · ${project?.name ?? ""}` : "Missing", ...(release ? { releaseHref: `#/approvals/${release.id}` } : {}),
      model: `${config?.baseModel ?? "?"} (${candidate?.artifact?.label ?? "development"} artifact)`, tools: TOOLS.join(", "), workspace: profile.workspaceId,
      usable, statusHtml: usable ? status("ok", "Active") : profile.status === "disabled" ? status("neutral", "Disabled") : status("bad", release ? releaseStatusLabel(release) : "Release missing"), updatedAt: profile.updatedAt,
    });
  }
  return rows;
}

export function assistantsListPage(snapshot: WorkbenchSnapshot): Page {
  const rows = assistantRows(snapshot);
  const body = table([{ label: "Assistant" }, { label: "Purpose" }, { label: "Active release", nowrap: true }, { label: "Model" }, { label: "Allowed tools" }, { label: "Workspace", nowrap: true }, { label: "Status", nowrap: true }, { label: "Last changed", nowrap: true }],
    rows.map((row) => ({ href: `#/assistants/${row.id}`, cells: [cellLink(`#/assistants/${row.id}`, row.name), `<span class="text-2">${escape(row.purpose)}</span>`, row.releaseHref ? `<a href="${row.releaseHref}">${escape(row.release)}</a>` : escape(row.release), `<span class="wrap">${escape(row.model)}</span>`, `<small class="m0">${escape(row.tools)}</small>`, escape(row.workspace), row.statusHtml, row.updatedAt ? `<span class="dim">${ago(row.updatedAt)}</span>` : '<span class="dim">—</span>'] })),
    { label: "Assistants" });
  const cards = `<div class="employee-shortcuts">${rows.map((row) => `<article class="employee-card"><div class="employee-card-heading"><span class="employee-card-icon" aria-hidden="true">✦</span>${row.statusHtml}</div><h2>${escape(row.name)}</h2><p>${escape(row.purpose)}</p><a class="employee-card-link" href="#/assistants/${row.id}">${row.usable ? "Open assistant" : "View availability"} →</a></article>`).join("")}</div>`;
  return { title: "Assistants", context: "Choose the help you need.", body: `${snapshot.studioError ? `<div class="inline-error" role="alert">${escape(snapshot.studioError)}</div>` : ""}${cards}${more("Models and permissions", body)}` };
}

export function assistantDetailPage(snapshot: WorkbenchSnapshot, id: string, chatHtml: string): Page {
  const studio = snapshot.studio;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  const crumbs: [string, string][] = [["Assistants", "#/assistants"]];
  if (id === WORKSPACE_ASSISTANT) {
    const body = `<div class="employee-focus">${panel("Chat", `<div class="panel-body chat-panel">${chatHtml}</div>`)}${more("Assistant details", panel("Summary", `<div class="panel-body">${detail([
      ["Purpose", "Answers questions about this workspace: which agents are approved, what they do and what the approval policy requires."],
      ["Model", escape(snapshot.chat.model ?? "Not configured") + (snapshot.chat.provider ? ` · ${escape(snapshot.chat.provider)}` : "")],
      ["Knowledge", "Workspace MCP, read only" + (snapshot.ontology ? " · ontology objects" : "")],
      ["Tools and permissions", `${TOOLS.map((tool) => `<code>${tool}</code>`).join(" ")}<br><small class="text-3">Cannot approve, edit, retire, send email or run agents.</small>`],
    ], true)}</div>`) + panel("Approved agents it can read", `<div class="panel-body">${snapshot.mcp.agents.length ? table([{ label: "Agent" }, { label: "Tools" }], snapshot.mcp.agents.map((agent) => ({ cells: [`${escape(agent.title)}<small>${escape(agent.description)}</small>`, escape(agent.readTools.join(", "))] })), { compact: true }) : empty("No approved agents yet.", { label: "Open Agents", href: "#/agents" })}</div>`))}</div>`;
    return { title: "Workspace assistant", crumbs, context: "Ask about approved agents and workspace rules.", actions: snapshot.chat.configured ? status("ok", "Available") : status("neutral", "Model not configured"), body };
  }
  const profile = studio?.profiles.find((item) => item.id === id);
  if (!studio || !profile) return { title: "Assistant not found", crumbs, body: empty("This assistant does not exist in the current workspace.", { label: "Back to Assistants", href: "#/assistants" }) };
  const release = releaseOf(studio, profile.releaseId);
  const project = projectOf(studio, release?.projectId);
  const job = studio.jobs.find((item) => item.id === release?.jobId);
  const config = configOf(studio, job);
  const evaluation = studio.evaluations.find((item) => item.id === release?.evaluationId);
  const usable = profile.status === "active" && release?.status === "approved";
  const history = [...studio.events].reverse().filter((event) => (event.entity === "profile" && event.entityId === profile.id) || (event.entity === "release" && event.entityId === release?.id));
  const otherReleases = project ? studio.releases.filter((item) => item.projectId === project.id && item.id !== release?.id) : [];
  const state = !release ? callout("bad", "Release missing.", " The release this assistant was assigned to no longer exists.")
    : profile.status === "disabled" ? callout("warn", "Disabled.", ` This assistant was disabled${release.status === "retired" ? ` when release v${release.version} was retired` : ""}. It does not answer.`)
    : release.status !== "approved" ? callout("bad", "Not usable.", ` Release v${release.version} is ${releaseStatusLabel(release).toLowerCase()}.`) : "";
  const summary = detail([
    ["Purpose", escape(project ? project.purpose || studio.recipes.find((recipe) => recipe.id === project.recipeId)?.purpose || "" : "")],
    ["Approved release", release ? `<a href="#/approvals/${release.id}">v${release.version} · ${escape(project?.name ?? "")}</a> ${status(release.status === "approved" ? "ok" : "bad", releaseStatusLabel(release))}<br><small class="text-3">hash ${short(release.contentHash, 16)}</small>` : "Missing"],
    ["Model", config ? `${escape(config.baseModel)}<br><small class="text-3">${escape(job?.artifact?.label ?? "development")} artifact ${job?.artifact ? short(job.artifact.hash) : ""}. ${escape(job?.artifact?.note ?? "")}</small>` : "—"],
    ["Evaluation", evaluation ? `${evaluation.passed ? status("ok", "Passed") : status("bad", "Failed")} <a href="#/evaluations/${evaluation.id}">${escape(evaluation.suiteId)}</a>` : "—"],
    ["Knowledge", "Workspace MCP, read only" + (snapshot.ontology ? " · ontology objects" : "")],
    ["Tools and permissions", `${TOOLS.map((tool) => `<code>${tool}</code>`).join(" ")}<br><small class="text-3">Cannot approve, edit, retire, send email or run agents. Instructions cannot grant tools.</small>`],
    ["Workspace", escape(profile.workspaceId)],
    ["Created", `${escape(profile.createdBy)} · ${when(profile.createdAt)}`],
  ], true);
  const behavior = `<pre class="pre">${escape(profile.instructions)}</pre>`;
  const historyHtml = history.length ? `<ul class="timeline">${history.map((event) => { const text = eventText(studio, event); return `<li><strong>${escape(event.actor)}</strong> ${escape(text.summary)}${text.to ? ` <span class="text-3">· ${escape(text.to)}</span>` : ""}<small>${ago(event.at)} · ${when(event.at)}</small></li>`; }).join("")}</ul>` : empty("No history yet.");
  // The stages this assistant staffs in the workflow: where it works, not only where it chats.
  const unit = agenticUnits(snapshot).find((item) => item.profile.id === profile.id);
  const stagesHtml = unit?.stages.length
    ? `<ul class="timeline">${unit.stages.map((stage) => `<li><a href="#/workflows/${stage.id}"><strong>${escape(stage.name)}</strong></a>${stage.approval ? ' <span class="text-3">· review gate</span>' : ""}<small>${escape(stage.instructions)}</small></li>`).join("")}</ul>${unit.working ? `<p class="text-2 mt8">${status("progress", "Working")} in ${unit.working === 1 ? "an open run" : `${unit.working} open runs`}.</p>` : ""}`
    : snapshot.pipelines ? empty("Not staffing any workflow stage.", { label: "Open Workflows", href: "#/workflows" }) : empty("Workflows are not configured.");
  const rollback = otherReleases.length ? table([{ label: "Release" }, { label: "Status" }, { label: "Requested" }], [...otherReleases].reverse().map((item) => ({ href: `#/approvals/${item.id}`, cells: [cellLink(`#/approvals/${item.id}`, `v${item.version}`), status(item.status === "approved" ? "ok" : item.status === "pending_approval" ? "warn" : "neutral", releaseStatusLabel(item)), `${escape(item.requestedBy)}<small>${when(item.requestedAt)}</small>`] })), { compact: true }) : '<p class="text-3">No other releases of this project. Rolling back means assigning an earlier approved release, which is done from the project\'s Use phase.</p>';
  const actions = `${usable ? status("ok", "Active") : status("neutral", "Not usable")}${viewer.author && profile.status === "active" && (viewer.admin || profile.createdBy === viewer.actor) ? `<details class="menu"><summary aria-label="More actions">⋯</summary><div><a href="#/studio/${project?.id}/use">Open project</a><button class="danger" data-confirm="disable_profile:${profile.id}">Disable assistant</button></div></details>` : ""}`;
  const chain = graph(assistantFlow(studio, profile, release), "assistant", { label: `${profile.name} connections` });
  const body = `<div class="employee-focus">${state}${usable ? panel("Chat", `<div class="panel-body chat-panel">${chatHtml}</div>`) : ""}${more("Assistant details", `${chain}${panel("Summary", `<div class="panel-body">${summary}</div>`)}${panel("System behavior", `<div class="panel-body">${behavior}</div>`)}${panel("Workflow stages", `<div class="panel-body">${stagesHtml}</div>`)}${panel("Recent assignments", `<div class="panel-body">${historyHtml}</div>`)}${panel("Other releases", `<div class="panel-body">${rollback}</div>`)}`)}</div>`;
  return { title: profile.name, crumbs, context: project ? `${escape(project.name)} · release v${release?.version ?? "?"}` : "", actions, body };
}


