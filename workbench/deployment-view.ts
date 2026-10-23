import type { DeploymentReport } from "./deployment-report.js";
import type { Page } from "./studio-view.js";
import { escape, more, status } from "./ui.js";

export function deploymentPage(report?: DeploymentReport): Page {
  if (!report) return { title: "Deployments", body: '<section class="panel"><h2>Checks unavailable</h2><p>Refresh the workspace to retry.</p></section>' };
  const rows = report.stages.map(stage => `<section class="panel account-panel"><h2>${escape(stage.name)}</h2>
    ${status(stage.blockers.length ? "warn" : "neutral", stage.blockers.length ? "Blocked" : stage.execution === "manual" ? "Human step" : "Configuration checked")}
    <dl class="account-facts"><div><dt>Execution</dt><dd>${stage.execution === "assistant" ? "Approved assistant" : stage.execution === "repository" ? "Repository agent" : "Person"}</dd></div>
    ${stage.execution !== "manual" ? `<div><dt>Model</dt><dd>${escape(stage.model)}</dd></div>` : ""}
    <div><dt>Handoff</dt><dd>${stage.approval ? report.requiredApprovals + " independent approval(s)" : "Human completion"}</dd></div></dl>
    ${stage.release ? `<p>Release v${stage.release.version} · ${stage.release.artifact === "development" ? "Development artifact — no trained weights" : "Trained artifact"}</p>` : ""}
    ${stage.blockers.length ? `<ul>${stage.blockers.map(item => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}
    <a class="secondary" href="#/workflows/${encodeURIComponent(stage.id)}">Review stage</a>
    ${stage.assistantId ? `<a class="secondary" href="#/assistants/${encodeURIComponent(stage.assistantId)}">Inspect assistant</a>` : ""}</section>`).join("");
  return { title: "Deployments", context: "Prepare this workflow for supervised use.",
    actions: '<button class="secondary" data-deployment-refresh>Refresh checks</button><button class="secondary" data-deployment-export>Download report</button>',
    body: `<section class="panel account-panel"><span class="eyebrow">CURRENT WORKFLOW</span><h2>${escape(report.workflow?.name ?? "No workflow")}</h2>
      ${status(report.status === "blocked" ? "warn" : "neutral", report.status === "blocked" ? "Resolve blockers" : "Needs live validation")}
      <p>${report.workflow ? `Version ${report.workflow.version} · ${report.workflow.storage === "file" ? "Saved on disk" : "Memory only"} · ` : ""}${report.mode === "company" ? "Company workspace" : report.mode === "demo" ? "Demo" : "Local workspace"}</p>
      <p class="text-3">A readiness check, not a deployment. Existing runs keep their saved workflow.</p>
      ${report.blockers.map(item => `<p>${escape(item)}</p>`).join("")}
      ${more("Report details", `<dl class="account-facts"><div><dt>Checked at</dt><dd>${escape(report.checkedAt)}</dd></div><div><dt>Workspace</dt><dd>${escape(report.workspaceId)}</dd></div><div><dt>Workflow hash</dt><dd><code>${escape(report.workflow?.hash ?? "Unavailable")}</code></dd></div></dl><p>Export rereads the current configuration and release gates. It includes identifiers and checks, not credentials, instructions or document content.</p>`)}</section>
      <div class="account-grid">${rows}</div>
      <section class="panel account-panel"><h2>Before rollout</h2><ul>${report.remainingChecks.map(item => `<li>${escape(item)}</li>`).join("")}</ul>
        <div class="panel-actions"><a class="secondary" href="#/connections">Connections</a><a class="secondary" href="#/onboarding">Workspace setup</a><a class="secondary" href="#/desk">Run supervised test</a></div></section>
      <section class="panel account-panel"><h2>Execution surfaces</h2><p>Use this workspace for supervised runs. Inspect approved registry definitions through MCP. The separate relay container does not host this company workspace.</p>
        <a class="secondary" href="#/mcp">Inspect workspace MCP</a><p class="text-3">Cloud provisioning, public hosting and multi-worker rollout are not available from this page.</p></section>` };
}
