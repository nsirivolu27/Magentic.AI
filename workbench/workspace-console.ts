import type { WorkbenchSnapshot } from "./snapshot.js";
import { configurableStages } from "./agent-configurables.js";
import { escape, status, table, cellLink } from "./ui.js";
import { slackControls } from "./slack-view.js";
import type { SlackPreview } from "./slack.js";

export const WORKSPACE_TABS = ["work", "agents", "tools", "workflows", "readiness", "access"] as const;
export function workspaceTab(query: URLSearchParams): typeof WORKSPACE_TABS[number] {
  return WORKSPACE_TABS.find(tab => tab === query.get("tab")) ?? "work";
}

export function workspaceConsole(snapshot: WorkbenchSnapshot, company: boolean, query: URLSearchParams, preview?: SlackPreview): string {
  const admin = snapshot.roles.includes("admin");
  const tab = workspaceTab(query);
  const controls = query.get("controls");
  const target = tab === "work" ? "#/workspace?controls=" : `#/workspace?tab=${tab}&controls=`;
  const report = snapshot.deployment;
  const blocks = report ? report.blockers.length + report.stages.reduce((count, stage) => count + stage.blockers.length, 0) : undefined;
  const checks = controls === "deployment" ? `<section class="console-drawer" aria-labelledby="console-checks"><div class="console-row"><h2 id="console-checks">Workflow checks</h2><button class="secondary" data-deployment-refresh>Refresh</button><button class="secondary" data-deployment-export>Export report</button></div>
    ${report ? `<p class="text-3">${blocks ? blocks + " blocker(s)" : "Configuration checked"} · Live validation still required</p>
    <ul class="console-checks">${report.blockers.map(item => `<li>${escape(item)}</li>`).join("")}${report.stages.map(stage => `<li><a href="#/workflows/${encodeURIComponent(stage.id)}">${escape(stage.name)}</a><span>${stage.blockers.length ? escape(stage.blockers.join(" ")) : stage.execution === "manual" ? "Human step" : "Configuration checked"}</span></li>`).join("")}</ul>
    <details><summary>Before rollout</summary><ul>${report.remainingChecks.map(item => `<li>${escape(item)}</li>`).join("")}</ul></details>` : '<p>Checks unavailable. Refresh to retry.</p>'}</section>` : "";
  return `<section class="workspace-console" aria-label="Workspace console"><div class="console-row">
    <nav class="console-tabs" aria-label="Workspace views">${WORKSPACE_TABS.map(item => `<a href="#/workspace${item === "work" ? "" : "?tab=" + item}" ${tab === item ? 'aria-current="page"' : ""}>${item[0]!.toUpperCase() + item.slice(1)}</a>`).join("")}</nav>
    <span class="console-role">${escape(snapshot.roles.map(role => role === "approver" ? "Reviewer" : role === "admin" ? "Administrator" : "Author").join(" · "))}</span>
    <details class="console-menu"><summary>Controls</summary><nav aria-label="Workspace controls">
      <a href="${target}deployment">Workflow checks${blocks === undefined ? "" : ` · ${blocks} blocked`}</a>
      <a href="#/workflows">${admin ? "Stage assignments" : "View workflow"}</a><a href="#/connections">Model connections</a><a href="#/mcp">MCP access</a>
      <a href="${target}slack">Slack · audit &amp; messages</a><a href="${company ? "/companies" : "#/onboarding"}">${company ? "Company &amp; team" : "Access &amp; setup"}</a>
    </nav></details></div>${controls ? `<a class="console-close" href="#/workspace${tab === "work" ? "" : "?tab=" + tab}">Close controls</a>` : ""}${checks}
    ${controls === "slack" ? slackControls(snapshot.slack, preview) : ""}</section>`;
}

export function workspaceAgents(snapshot: WorkbenchSnapshot): string {
  const pipeline = snapshot.pipelines?.config;
  const admin = snapshot.roles.includes("admin");
  const profiles = snapshot.studio?.profiles.filter(profile => profile.workspaceId === snapshot.workspaceId) ?? [];
  const rows = profiles.map(profile => {
    const stages = pipeline?.stages.filter(stage => stage.assistantId === profile.id) ?? [];
    return { cells: [cellLink("#/assistants/" + profile.id, profile.name, "Model Studio assistant"), escape(profile.createdBy),
      stages.map(stage => cellLink("#/workflows/" + stage.id, stage.name)).join(", ") || "Unassigned",
      status(profile.status === "disabled" ? "warn" : "neutral", profile.status === "disabled" ? "Disabled" : "Inspect release"),
      `<a href="#/assistants/${encodeURIComponent(profile.id)}">Open</a>`] };
  });
  for (const agent of pipeline?.configurables ?? []) {
    const stages = configurableStages(pipeline!, agent);
    rows.push({ cells: [cellLink("#/agent-studio/" + agent.id, agent.name, "Repository agent"), "Shared configuration",
      stages.map(stage => cellLink("#/workflows/" + stage.id, stage.name)).join(", ") || "Unassigned",
      status("neutral", "Review test evidence"), `<a href="#/agent-studio/${encodeURIComponent(agent.id)}">Inspect</a>`] });
  }
  return `<section aria-labelledby="team-agents"><div class="console-row"><h2 id="team-agents">Team agents</h2>
    ${admin ? '<a class="secondary" href="#/agent-studio">Create agent</a><a class="secondary" href="#/workflows">Assign stages</a>' : ""}</div>
    <p class="text-3">Shared within this workspace. A creator is not an exclusive owner; access follows company roles.</p>
    ${snapshot.studioError ? '<p role="status">Model Studio could not load. The list may be incomplete.</p>' : ""}
    ${table([{ label: "Agent" }, { label: "Created by / scope" }, { label: "Assigned stages" }, { label: "Review" }, { label: "Action" }], rows,
      { label: "Team agents", empty: 'No agents yet. <a href="#/marketplace">Browse templates</a>', compact: true })}</section>`;
}
