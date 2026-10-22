import { escape, status } from "./ui.js";
import type { PipelineRun } from "./pipeline.js";
import type { ZenfluenceSource } from "./zenfluence.js";

/** What GET /api/zenfluence returns: the connection as configured, never a credential value. */
export interface ZenfluenceSummary {
  configured: boolean; ready?: boolean; site?: string; project?: string; spaceId?: string; workspaceId?: string;
  settings?: { email: { name: string; configured: boolean }; token: { name: string; configured: boolean } };
}
export type ZenfluenceDraft = { kind: string; id: string; runId: string };

/** One of four states a person can be in, each with the single next step that leaves it. */
export function connectionState(summary: ZenfluenceSummary | undefined, error: string): "loading" | "error" | "setup" | "credentials" | "ready" {
  if (error) return "error";
  if (!summary) return "loading";
  if (!summary.configured) return "setup";
  return summary.ready ? "ready" : "credentials";
}

function connectionPanel(summary: ZenfluenceSummary | undefined, error: string, loading: boolean, draft: ZenfluenceDraft): string {
  const state = connectionState(summary, error);
  const pill = { loading: status("neutral", "Checking"), error: status("bad", "Error"), setup: status("neutral", "Not connected"),
    credentials: status("warn", "Credentials needed"), ready: status("ok", "Ready") }[state];
  const head = `<div class="zen-head"><h2>Jira + Confluence</h2>${pill}</div>`;
  if (state === "loading") return head + '<p class="text-3">Loading connection…</p>';
  if (state === "error") return head + `<p role="alert" class="callout bad">${escape(error)}</p><p class="text-3">Refresh the connection, or check the server log for the connection file message.</p>`;
  if (state === "setup") {
    const id = summary?.workspaceId ? `<code>${escape(summary.workspaceId)}</code>` : "this workspace’s id";
    return head + `<p>Connect your company’s Jira project and Confluence space in server settings.</p><p class="text-3">No Atlassian data is connected yet.</p>
      <ol class="zen-steps">
        <li>Copy <code>examples/zenfluence.json</code> and set <code>workspaceId</code> to ${id}, plus your Atlassian site, Jira project key and numeric Confluence space id.</li>
        <li>Point the <code>MAGENTIC_ZENFLUENCE_FILE</code> setting at that file.</li>
        <li>Set the email and API token settings the file names, then restart the server.</li>
      </ol><p class="text-3">Credentials are setting names in the file, never values. Reads are limited to the configured project and space.</p>`;
  }
  const where = `<dl class="zen-facts"><div><dt>Site</dt><dd>${escape(summary!.site ?? "")}</dd></div><div><dt>Jira project</dt><dd>${escape(summary!.project ?? "")}</dd></div><div><dt>Confluence space</dt><dd>${escape(summary!.spaceId ?? "")}</dd></div></dl>`;
  if (state === "credentials") {
    const missing = [summary!.settings?.email, summary!.settings?.token].filter(item => item && !item.configured).map(item => `<li><code>${escape(item!.name)}</code></li>`).join("");
    return head + where + `<p>The connection file is loaded. The server still needs these settings, then a restart:</p><ul class="zen-steps">${missing || "<li>Credential settings</li>"}</ul><p class="text-3">Use a service account limited to this project and space. Values are never shown here.</p>`;
  }
  return head + where + `<form id="zenfluence-read" class="zen-read"><label class="field">Source<select name="kind"><option value="jira" ${draft.kind === "jira" ? "selected" : ""}>Jira ticket</option><option value="confluence" ${draft.kind === "confluence" ? "selected" : ""}>Confluence page</option></select></label>
    <label class="field">Ticket key or page ID<input name="sourceId" value="${escape(draft.id)}" required maxlength="60" placeholder="${escape(summary!.project ?? "KAN")}-123 or 123456"></label>
    <button class="primary" ${loading ? "disabled" : ""}>${loading ? "Reading…" : "Read source"}</button></form>
    <p class="text-3">Read only. Nothing is written to Atlassian from this page.</p>`;
}

function sourcePanel(source: ZenfluenceSource | undefined, runs: PipelineRun[], loading: boolean, draft: ZenfluenceDraft, state: ReturnType<typeof connectionState>): string {
  if (!source) {
    const text = state === "ready" ? "Read a ticket or page to review it here before attaching it to a workflow." : "A reviewed snapshot of a ticket or page appears here once the connection is ready.";
    return `<section class="panel zen-source zen-empty" aria-label="Source"><h2>Source</h2><p class="text-3">${text}</p></section>`;
  }
  const attach = runs.length
    ? `<form id="zenfluence-attach" class="zen-attach"><label class="field">Workflow<select name="runId">${runs.map(run => `<option value="${escape(run.id)}" ${draft.runId === run.id ? "selected" : ""}>${escape(run.title)}</option>`).join("")}</select></label><button class="primary" ${loading ? "disabled" : ""}>Attach snapshot</button></form><p class="text-3">The source is read again on attach and refused if it changed.</p>`
    : '<p class="text-3">Start a workflow to attach this reference.</p>';
  return `<section class="panel zen-source" aria-label="Source"><div class="zen-head"><h2>${escape(source.title)}</h2>${status("neutral", source.kind === "jira" ? "Jira ticket" : "Confluence page")}</div>
    <p class="text-2"><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a> · Revision ${escape(source.revision)}${source.truncated ? " · Excerpt, truncated at 4,500 characters" : ""}</p>
    <pre class="wrap">${escape(source.text)}</pre>${attach}</section>`;
}

export function zenfluencePage(summary: ZenfluenceSummary | undefined, source: ZenfluenceSource | undefined, error: string,
  runs: PipelineRun[], loading: boolean, draft: ZenfluenceDraft = { kind: "jira", id: "", runId: "" }) {
  const state = connectionState(summary, error);
  return { title: "Zenfluence", context: "Tickets → knowledge → workflows", actions: '<a class="secondary" href="#/canvas">Workflow canvas</a>',
    body: `<div class="zenfluence-panels"><section class="panel zen-connection" aria-label="Connection">${connectionPanel(summary, error, loading, draft)}
      <button class="secondary" data-zenfluence-refresh ${loading ? "disabled" : ""}>Refresh connection</button></section>${sourcePanel(source, runs, loading, draft, state)}</div>` };
}
