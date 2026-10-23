import type { McpOverview } from "./mcp-portal.js";

export interface InspectorTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface InspectorState {
  tools: InspectorTool[]; protocolVersion?: string; selected: string; arguments: string;
  output: string; failed: boolean; elapsed?: number;
}
export function emptyInspector(): InspectorState {
  return { tools: [], selected: "", arguments: "{}", output: "Connect to discover the tools this server exposes.", failed: false };
}
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function mcpView(overview: McpOverview, inspector: InspectorState, endpoint: string, demo: boolean, actor: string): string {
  const selected = inspector.tools.find((tool) => tool.name === inspector.selected);
  const config = JSON.stringify({ url: endpoint, transport: "streamable-http", headers: { Authorization: `Bearer ${demo ? actor : "<workspace access token>"}` } }, null, 2);
  return `<div class="mcp-connection"><div><p class="eyebrow">WORKSPACE MCP</p><h2>A connection you can inspect.</h2>
    <p class="muted">Read approved agent definitions and workflow policy from your workspace. Conversation execution uses the separate relay adapter.</p>
    <div class="mcp-endpoint"><code>${escape(endpoint)}</code><button class="secondary" data-mcp-action="copy">Copy URL</button></div>
    <div class="mcp-tags"><span class="badge approved">Read only</span><span>Streamable HTTP</span><span>Bearer authentication</span></div></div>
    <div class="mcp-connect-action"><button class="primary" data-mcp-action="connect">${inspector.protocolVersion ? "Reconnect" : "Connect & inspect"}</button>
    <small>${inspector.protocolVersion ? `Connected · protocol ${escape(inspector.protocolVersion)}` : "Connection has not been tested"}</small></div></div>
    <details class="mcp-config"><summary>Client connection settings</summary><p class="muted">Use these values in your client's MCP connection form. Config file formats vary by client. ${demo ? "This public demo token only accesses disposable local sample data." : "Use a token issued by your workspace's authentication system."}</p><pre>${escape(config)}</pre></details>
    <div class="mcp-columns"><section class="mcp-card"><div class="mcp-section-title"><h2>Tool inspector</h2><span class="muted">${inspector.tools.length} tools</span></div>
    <p class="muted">Make a real request and see the response.</p>
    <label for="mcp-tool">Tool<select id="mcp-tool" ${inspector.tools.length ? "" : "disabled"}>${inspector.tools.length ? inspector.tools.map((tool) => `<option value="${escape(tool.name)}" ${tool.name === inspector.selected ? "selected" : ""}>${escape(tool.name)}</option>`).join("") : '<option>Connect to discover tools</option>'}</select></label>
    <p class="muted mcp-tool-description">${escape(selected?.description ?? "The connection is scoped to the selected workspace identity.")}</p>
    ${selected ? `<details class="mcp-schema"><summary>Input schema</summary><pre>${escape(JSON.stringify(selected.inputSchema, null, 2))}</pre></details>` : ""}
    <label for="mcp-arguments">Arguments · JSON<textarea id="mcp-arguments" rows="5" spellcheck="false" ${selected ? "" : "disabled"}>${escape(inspector.arguments)}</textarea></label>
    <button class="primary" data-mcp-action="run" ${selected ? "" : "disabled"}>Run tool <span aria-hidden="true">↗</span></button></section>
    <section class="mcp-card mcp-response"><div class="mcp-section-title"><h2>Response</h2><span class="${inspector.failed ? "error-message" : "muted"}">${inspector.failed ? "Failed" : inspector.elapsed === undefined ? "Ready when you are" : `${inspector.elapsed} ms`}</span></div>
    <pre id="mcp-output" role="status" aria-live="polite">${escape(inspector.output)}</pre></section></div>
    <section class="mcp-catalog"><div class="mcp-section-title"><div><h2>Approved catalog</h2><p class="muted">Signatures are checked against the current content on every MCP call.</p></div><button class="secondary" data-mcp-action="refresh">Refresh</button></div>
    ${overview.agents.length ? overview.agents.map((agent) => `<div class="mcp-agent"><div><strong>${escape(agent.title)}</strong><p class="muted">${escape(agent.description)}</p><small>${escape(agent.name)} · ${agent.readTools.length} declared read tools</small></div><span class="badge approved">Available</span><button class="secondary" data-mcp-agent="${escape(agent.name)}">Inspect definition</button></div>`).join("") : '<p class="empty">No agents meet the current policy. Complete their reviews in Agents to make them available here.</p>'}
    <h3>Withheld from MCP · ${overview.withheld.length}</h3>${overview.withheld.map((agent) => `<div class="mcp-withheld"><div><strong>${escape(agent.name)}</strong><small>${escape(agent.detail)}</small></div><button class="secondary" data-record="${escape(agent.name)}">Review agent</button></div>`).join("") || '<p class="muted">Every agent currently meets the catalog requirements.</p>'}</section>`;
}

let requestId = 0;
export async function mcpRequest(token: string, method: string, params: unknown, protocolVersion?: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch("/api/mcp", {
    method: "POST", headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++requestId }), method, params }),
    signal: AbortSignal.timeout(15_000), cache: "no-store",
  });
  if (response.status === 202) return {};
  const message = await response.json();
  if (!response.ok || message.error) throw new Error(typeof message.error === "string" ? message.error : message.error?.message ?? `MCP request failed (${response.status}).`);
  return message.result;
}

export function formatToolResult(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return JSON.stringify(result, null, 2);
  return result.content.map((block: { type?: string; text?: string }) => {
    if (block.type !== "text" || typeof block.text !== "string") return JSON.stringify(block, null, 2);
    try { return JSON.stringify(JSON.parse(block.text), null, 2); }
    catch { return block.text; }
  }).join("\n\n");
}
