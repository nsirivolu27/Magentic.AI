import type { CompanyTeamReport } from "./company-team.js";
import { cellLink, escape, status, table } from "./ui.js";

export interface CompanyTeamState { report?: CompanyTeamReport; loading: boolean; error?: string }

export function companyTeamPanel(company: boolean, admin: boolean, state: CompanyTeamState = { loading: false }): string {
  if (!company) return '<section class="team-section"><div class="team-section-head"><div><h2>Team coverage</h2><p>Local mode has one operator. Company sign-in is needed to check independent reviewers.</p></div></div></section>';
  if (!admin) return '<section class="team-section"><div class="team-section-head"><div><h2>Team coverage</h2><p>Ask a company administrator to check reviewer coverage.</p></div></div></section>';
  const report = state.report;
  const handoffs = !report ? "" : !report.pipelineAvailable ? '<p class="team-footnote" role="status">Workflow data is unavailable. Handoff coverage could not be checked.</p>'
    : table([{ label: "Waiting handoff" }, { label: "Recorded / required" }, { label: "Other eligible reviewers" }, { label: "Coverage" }],
      report.handoffs.map(item => ({ cells: [
        cellLink("#/tasks/" + encodeURIComponent(item.runId), item.title, item.stage),
        `${item.recorded} / ${item.required}`, String(item.available),
        status(item.shortfall ? "warn" : "neutral", item.shortfall ? `Needs ${item.shortfall} more reviewer(s)` : "Reviewers available"),
      ] })), { label: "Handoff reviewer coverage", empty: '<p class="team-footnote">No handoffs are waiting for review.</p>', compact: true });
  return `<section class="team-section" aria-labelledby="company-team-title"><div class="team-section-head"><div><h2 id="company-team-title">Team coverage</h2>
    <p>Check who can review waiting handoffs.</p></div><button class="secondary" data-company-team-refresh ${state.loading ? "disabled" : ""}>${state.loading ? "Checking…" : report ? "Refresh team coverage" : "Check team coverage"}</button></div>
    ${state.error ? `<p class="team-footnote" role="alert">${escape(state.error)}</p>` : ""}
    ${report ? `<div class="team-readiness-summary"><span>Checked ${escape(report.checkedAt)} · ${report.members.length} company member(s)</span></div>${handoffs}
      <details class="team-rollout"><summary>Members &amp; workspace roles</summary>
      ${table([{ label: "Member ID" }, { label: "Workspace roles" }], report.members.map(member => ({ cells: [
        escape(member.actor), member.roles.map(role => role === "admin" ? "Administrator" : role === "approver" ? "Reviewer" : "Author").join(" · ") || "No workspace access",
      ] })), { label: "Company workspace roles", empty: "<p>No members returned.</p>", compact: true })}</details>
      <p class="team-footnote">A point-in-time staffing check, not an approval. Owners, output authors and existing signers are excluded from the remaining reviewers. Model releases have separate approval rules.</p>`
      : '<p class="team-footnote">Membership is read from Clerk on request. Roles are managed through your company settings.</p>'}</section>`;
}

