import type { WorkbenchSnapshot } from "./snapshot.js";
import { companyTeamPanel, type CompanyTeamState } from "./company-team-view.js";
import { workspaceAgents, workspaceTab } from "./workspace-console.js";
import { homeView } from "./home-view.js";
import { escape, status, table, cellLink } from "./ui.js";

const services = [
  { group: "Connect", name: "Ontology", detail: "Foundry, datasets and allowed object types.", href: "#/ontology" },
  { group: "Build", name: "Agent Studio", detail: "Instructions, models and tool permissions.", href: "#/agent-studio" },
  { group: "Build", name: "Agent marketplace", detail: "Find configurations for your workflow.", href: "#/marketplace" },
  { group: "Build", name: "Model Studio", detail: "Candidates, evaluations and releases.", href: "#/studio" },
  { group: "Connect", name: "Model connections", detail: "Providers and company model access.", href: "#/connections" },
  { group: "Connect", name: "MCP tools", detail: "Inspect exposed tools and access rules.", href: "#/mcp" },
  { group: "Connect", name: "Reference documents", detail: "Ground agents in workspace material.", href: "#/documents" },
  { group: "Coordinate", name: "Jira & Confluence", detail: "Tickets, source material and evidence.", href: "#/zenfluence" },
  { group: "Coordinate", name: "Slack", detail: "Preview audit updates and team messages.", href: "#/workspace?tab=tools&controls=slack" },
  { group: "Coordinate", name: "Audit trail", detail: "Who acted, what changed and when.", href: "#/activity" },
];

export function workspaceTools(query = ""): string {
  const matches = services.filter(service => (service.name + " " + service.detail + " " + service.group).toLowerCase().includes(query.trim().toLowerCase()));
  return `<section class="team-section" aria-labelledby="tools-title">
    <div class="team-section-head"><div><h2 id="tools-title">Tools</h2><p>Open a service in this workspace.</p></div>
      <form id="workspace-tool-search" role="search"><label for="workspace-tool-query" class="visually-hidden">Find a tool</label><input id="workspace-tool-query" name="q" type="search" value="${escape(query)}" placeholder="Find a tool" maxlength="120"><button class="secondary" type="submit">Find</button>${query ? '<a href="#/workspace?tab=tools">Clear</a>' : ""}</form></div>
    <div class="team-service-grid">${["Build", "Connect", "Coordinate"].map(group => {
      const rows = matches.filter(service => service.group === group);
      return rows.length ? `<section class="team-service-group"><h3>${group}</h3>${rows.map(service => `<a class="team-service" href="${service.href}"><span><strong>${escape(service.name)}</strong><small>${escape(service.detail)}</small></span><span aria-hidden="true">↗</span></a>`).join("")}</section>` : "";
    }).join("")}</div>
    ${matches.length ? "" : '<p role="status">No tools match. Try “model”, “MCP” or “Slack”.</p>'}</section>`;
}

export function workspaceWorkflow(snapshot: WorkbenchSnapshot): string {
  const pipeline = snapshot.pipelines;
  if (!pipeline) return '<section class="team-section"><h2>Workflow unavailable</h2><p>Refresh the workspace to retry.</p></section>';
  const admin = snapshot.roles.includes("admin");
  const rows = pipeline.config.stages.map((stage, index) => {
    const profile = snapshot.studio?.profiles.find(item => item.workspaceId === snapshot.workspaceId && item.id === stage.assistantId);
    const report = snapshot.deployment?.stages.find(item => item.id === stage.id);
    const repository = !stage.assistantId && stage.bot && stage.bot.kind !== "manual";
    // Assistant models come from the release, which can differ from the stage's saved preference.
    const model = stage.assistantId ? report?.release ? report.model : "Inspect approved release" : repository ? stage.model : "—";
    const limits = repository ? `${stage.bot!.maxSteps} steps · ${stage.bot!.timeoutSeconds}s` : stage.assistantId ? "Release policy" : "Person completes";
    return { cells: [
      cellLink("#/workflows/" + stage.id, `${index + 1}. ${stage.name}`),
      escape(stage.assistantId ? profile?.name ?? "Assistant unavailable" : repository ? stage.agent : "Manual step"),
      escape(model), escape(limits),
      status(stage.approval ? "warn" : "neutral", stage.approval ? "Review required" : "No review gate"),
      `<a href="#/workflows/${encodeURIComponent(stage.id)}">${admin ? "Configure" : "Inspect"}</a>`,
    ] };
  });
  return `<section class="team-section" aria-labelledby="team-workflow"><div class="team-section-head"><div><h2 id="team-workflow">${escape(pipeline.config.name)}</h2><p>Version ${pipeline.version} · ${pipeline.config.stages.length} stages · Changes apply to new runs.</p></div>
    <a class="primary" href="#/canvas">${admin ? "Open canvas" : "View canvas"}</a></div>
    <ol class="team-stage-strip" aria-label="Stage sequence">${pipeline.config.stages.map((stage, index) => `<li><a href="#/workflows/${encodeURIComponent(stage.id)}"><small>${String(index + 1).padStart(2, "0")}</small>${escape(stage.name)}${stage.approval ? '<span aria-label="Review required">◇</span>' : ""}</a></li>`).join("")}</ol>
    ${table([{ label: "Stage" }, { label: "Assigned agent" }, { label: "Model" }, { label: "Execution limit" }, { label: "Handoff" }, { label: "Settings" }], rows, { label: "Workflow configuration", compact: true })}
    <div class="team-section-foot"><a href="#/workspace?tab=agents">Team agents</a><a href="#/workspace?tab=readiness">Check readiness</a><a href="#/desk">Open work items</a></div></section>`;
}

export function workspaceReadiness(snapshot: WorkbenchSnapshot): string {
  const report = snapshot.deployment;
  const actions = '<button class="secondary" data-deployment-refresh>Refresh checks</button><button class="secondary" data-deployment-export>Export report</button>';
  if (!report) return `<section class="team-section"><h2>Readiness unavailable</h2><p>Refresh checks to retry.</p>${actions}</section>`;
  const blockers = report.blockers.length + report.stages.reduce((sum, stage) => sum + stage.blockers.length, 0);
  return `<section class="team-section" aria-labelledby="readiness-title"><div class="team-section-head"><div><h2 id="readiness-title">Before deployment</h2><p>Configuration checks. A live test and independent review are still required.</p></div><div class="team-actions">${actions}</div></div>
    <div class="team-readiness-summary">${status(blockers ? "warn" : "neutral", blockers ? blockers + " blocker(s)" : "Needs live validation")}<span>Checked ${escape(report.checkedAt)}</span></div>
    ${report.blockers.length ? `<ul>${report.blockers.map(item => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}
    ${table([{ label: "Stage" }, { label: "Execution" }, { label: "Configuration check" }], report.stages.map(stage => ({ cells: [
      cellLink("#/workflows/" + stage.id, stage.name),
      escape(stage.execution === "manual" ? "Person" : stage.execution === "assistant" ? "Approved assistant" : "Repository agent"),
      stage.blockers.length ? stage.blockers.map(item => escape(item)).join("<br>") : "Configuration checked",
    ] })), { label: "Readiness checks", compact: true })}
    <details class="team-rollout"><summary>Remaining checks (${report.remainingChecks.length})</summary><ul>${report.remainingChecks.map(item => `<li>${escape(item)}</li>`).join("")}</ul></details>
    <div class="team-section-foot"><a href="#/connections">Review connections</a><a href="#/desk">Run supervised test</a><a href="#/approvals">Release approvals</a></div>
    <p class="team-footnote">This console does not provision cloud infrastructure.</p></section>`;
}

export function workspaceAccess(snapshot: WorkbenchSnapshot, company: boolean, team?: CompanyTeamState): string {
  return `<section class="team-section" aria-labelledby="access-title"><div class="team-section-head"><div><h2 id="access-title">Access &amp; team</h2><p>${company ? "Company membership controls workspace access." : "Local workspace · company sign-in is not active here."}</p></div><a class="secondary" href="${company ? "/companies" : "#/onboarding"}">${company ? "Manage team" : "Workspace setup"}</a></div>
    <div class="team-access-grid"><section><h3>Your identity</h3><p>${escape(snapshot.actor)}</p><small>${escape(snapshot.workspaceId)}</small></section>
      <section><h3>Your roles</h3><p>${snapshot.roles.map(role => role === "admin" ? "Administrator" : role === "approver" ? "Reviewer" : "Author").join(" · ") || "No workspace roles"}</p><small>Server checks apply to every action.</small></section>
      <section><h3>Independent review</h3><p>${snapshot.workflow.requiredApprovals} required for gated handoffs</p><small>Reviewer coverage has not been verified.</small></section></div>
    <div class="team-section-foot"><a href="#/workflow">Review policy</a><a href="#/account">Account settings</a><a href="#/activity">Audit trail</a></div></section>
    ${companyTeamPanel(company, snapshot.roles.includes("admin"), team)}`;
}

export function workspaceServiceView(snapshot: WorkbenchSnapshot, company: boolean, query: URLSearchParams, team?: CompanyTeamState): string {
  switch (workspaceTab(query)) {
    case "agents": return workspaceAgents(snapshot);
    case "tools": return workspaceTools(query.get("q") ?? "");
    case "workflows": return workspaceWorkflow(snapshot);
    case "readiness": return workspaceReadiness(snapshot);
    case "access": return workspaceAccess(snapshot, company, team);
    default: return homeView(snapshot);
  }
}
