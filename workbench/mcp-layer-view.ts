import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { mcpView, type InspectorState } from "./mcp-view.js";
import { empty, escape, more, panel, status } from "./ui.js";

export function mcpLayerPage(snapshot: WorkbenchSnapshot, inspector: InspectorState, origin: string): Page {
  const endpoint = new URL("/api/mcp", origin).href;
  const pipelineEndpoint = new URL("/api/pipeline-mcp", origin).href;
  const agents = snapshot.mcp.agents.length
    ? `<ul class="marketplace-installed">${snapshot.mcp.agents.map((agent) => `<li><div><strong>${escape(agent.title)}</strong><small>${escape(agent.description)}</small></div><button class="secondary small" data-mcp-agent="${escape(agent.name)}">Inspect definition</button></li>`).join("")}</ul>`
    : empty("No approved agent definitions are available.", { label: "Review agent setup", href: "#/agents" });
  const cards = `<div class="employee-shortcuts">
    <article class="employee-card"><div class="employee-card-heading"><span class="marketplace-category">Workspace MCP</span>${inspector.failed ? status("bad", "Check failed") : inspector.protocolVersion ? status("ok", "Connection checked") : status("neutral", "Not tested")}</div><h2>Workspace tools</h2><p>Read approved agent definitions and workspace rules.</p><code class="mcp-layer-endpoint">${escape(endpoint)}</code><div class="employee-actions"><button class="primary" data-mcp-action="connect">Check connection</button><button class="secondary" data-mcp-action="copy">Copy URL</button></div><small class="text-3">Read only · Does not execute agents</small></article>
    <article class="employee-card"><div class="employee-card-heading"><span class="marketplace-category">Workflow MCP</span>${status("neutral", snapshot.pipelines ? "Configured" : "Not configured")}</div><h2>Workflow tools</h2><p>Read task progress and record authorized handoffs.</p>${snapshot.pipelines ? `<code class="mcp-layer-endpoint">${escape(pipelineEndpoint)}</code><a class="employee-card-link" href="#/tasks">Open tasks →</a><small class="text-3">Can update tasks · Workspace permissions apply</small>` : '<small class="text-3">Enable workflows to make this endpoint available.</small>'}</article>
  </div>`;
  const ontology = snapshot.ontology
    ? `<p>${status(snapshot.ontology.mode === "sample" ? "neutral" : "info", snapshot.ontology.mode === "sample" ? "Sample data" : "Foundry configured")} ${snapshot.ontology.objectTypes.length} allowed object types</p><p class="text-2">${snapshot.ontology.mode === "sample" ? "Synthetic reference data for trying the workspace tools." : "Read-only access to the configured ontology. Test a tool to verify access."}</p>`
    : '<p class="text-2">No ontology data source is configured.</p>';
  // Discovery and tool results belong to the existing inspector, so this
  // page cannot imply a successful connection from configuration alone.
  const inspectorHtml = mcpView(snapshot.mcp, inspector, endpoint, snapshot.demo, snapshot.actor);
  return { title: "MCP layer", context: "Connect tools to your workspace and agent team.", actions: '<a class="secondary" href="#/team">Configure agent team</a>', body: `${cards}${panel("Available agent definitions", agents, { count: String(snapshot.mcp.agents.length) })}${more("Data connections", ontology)}${more("Connection settings and tool inspector", `<div class="mcp-layer-inspector">${inspectorHtml}</div>`, !!inspector.protocolVersion || inspector.failed)}${snapshot.mcp.withheld.length ? more(`${snapshot.mcp.withheld.length} definitions not available`, `<ul class="attention">${snapshot.mcp.withheld.map((item) => `<li><div><strong>${escape(item.name)}</strong><small>${escape(item.detail)}</small></div><button class="secondary small" data-record="${escape(item.name)}">Review</button></li>`).join("")}</ul>`) : ""}<p class="text-3">Client connections require workspace authentication. Adding a configurable does not grant MCP access.</p>` };
}
