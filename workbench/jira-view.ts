import type { JiraIntent, PendingJiraAction } from "./jira.js";

export interface JiraReview {
  mode: "preview" | "live";
  intent: JiraIntent;
  expectedIntentHash: string;
}
export interface JiraHistory {
  mode: "preview" | "live";
  siteOrigin: string;
  runId: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  actions: PendingJiraAction[];
}
const escape = (value: string | number) => String(value).replace(/[&<>"']/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const label = (value: string) => escape(value.replaceAll("_", " "));
const header = (title: string) => `<div class="dialog-top"><span class="eyebrow">JIRA WORKFLOW</span><button class="icon-button" data-close="jira-dialog" aria-label="Close Jira review">×</button></div><h2 id="jira-title">${title}</h2>`;

export function jiraReviewView(review: JiraReview): string {
  const intent = review.intent;
  const preview = review.mode === "preview";
  return `${header("Review this Jira action")}
    <p class="pipeline-disclosure">${preview ? "Preview mode. Saving records this proposal locally; nothing will be sent to Jira." : "Live delivery. Confirming sends this exact action to the Jira site below."}</p>
    <dl class="jira-facts"><dt>Operation</dt><dd>${label(intent.operation)}</dd><dt>Destination</dt><dd>${preview ? "Local preview only" : escape(intent.siteOrigin)}</dd>
    <dt>Project / type</dt><dd>${escape(intent.project)} / ${escape(intent.issueType)}</dd><dt>Issue</dt><dd>${escape(intent.issueKey ?? "New issue")}</dd>
    <dt>Workflow status</dt><dd>${escape(intent.status)}</dd></dl>
    <h3>${escape(intent.summary)}</h3><pre class="jira-content">${escape(intent.comment)}</pre>
    ${intent.fields ? `<h3>Fields to update</h3><pre class="jira-content">${escape(JSON.stringify(intent.fields, null, 2))}</pre>` : ""}
    <details><summary>Traceability</summary><p class="muted">This review is bound to the content and destination shown above.</p><dl class="jira-facts"><dt>Run</dt><dd>${escape(intent.runId)}</dd><dt>Event</dt><dd>${escape(intent.eventId)}</dd><dt>Content hash</dt><dd>${escape(review.expectedIntentHash)}</dd></dl></details>
    <label class="checkbox"><input id="jira-confirm-reviewed" type="checkbox"> I reviewed this action and its destination.</label>
    <p id="jira-error" class="error-message" role="alert"></p>
    <div class="dialog-footer"><button class="secondary" data-close="jira-dialog">Cancel</button><button class="primary" id="jira-confirm" disabled>${preview ? "Save local preview" : "Send to Jira"}</button></div>`;
}

function evidenceLink(action: PendingJiraAction): string {
  if (!action.evidence) return "";
  let url: URL;
  try { url = new URL(action.evidence.url); } catch { return escape(action.evidence.issueKey); }
  // Stored evidence is still data. It must not turn a rendered issue link
  // into script execution or navigation to a different destination.
  if (url.protocol !== "https:" || url.origin !== new URL(action.intent.siteOrigin).origin) return escape(action.evidence.issueKey);
  return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(action.evidence.issueKey)} ↗</a>`;
}

export function jiraHistoryView(history: JiraHistory): string {
  return `${header("Saved Jira actions")}
    <p class="muted">${history.total} saved actions · ${history.mode === "preview" ? "Preview mode · no live delivery" : `Live adapter · ${escape(history.siteOrigin)}`}</p>
    ${history.actions.map(action => `<article class="pipeline-jira jira-saved-action"><div><strong>${label(action.intent.operation)}</strong><span class="pipeline-chip">${label(action.status)}</span></div>
      <p>${escape(action.intent.summary)}</p><small>Reviewed by ${escape(action.authorizedBy)} · Attempts: ${action.attempts}</small>
      ${action.evidence ? `<p>Confirmed issue: ${evidenceLink(action)}<br><small>${escape(action.evidence.at)}</small></p>` : '<p class="muted">No confirmed Jira delivery.</p>'}
      ${action.status === "uncertain" ? '<p class="jira-warning">The outcome is unknown. This action will not be retried automatically.</p>' : ""}
      ${action.retryNotBefore ? `<p>Retry available after ${escape(action.retryNotBefore)}. Review the action again before retrying.</p>` : ""}
      ${action.lastError ? `<p class="muted">${escape(action.lastError)}</p>` : ""}
      <details><summary>Evidence and completed steps</summary><p class="hash">${escape(action.intentHash)}</p><ul>${action.steps.map(step => `<li>${label(step.name)} · ${escape(step.at)}<p>${escape(step.detail)}</p></li>`).join("") || "<li>No completed delivery steps.</li>"}</ul></details>
    </article>`).join("") || '<p class="empty">No saved actions yet. Review a Jira preview from this run to record one.</p>'}
    <div class="dialog-footer">${history.offset > 0 ? `<button class="secondary" data-jira-history="${escape(history.runId)}" data-jira-offset="${Math.max(0, history.offset - 20)}">Previous</button>` : ""}
    ${history.nextOffset !== null ? `<button class="secondary" data-jira-history="${escape(history.runId)}" data-jira-offset="${history.nextOffset}">Next</button>` : ""}
    <button class="secondary" data-jira-history="${escape(history.runId)}" data-jira-offset="${history.offset}">Refresh evidence</button><button class="primary" data-close="jira-dialog">Done</button></div>`;
}
