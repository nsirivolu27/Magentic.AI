import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { escape, more, status } from "./ui.js";

export interface WorkspaceSetupStep {
  id: string; title: string; state: "pending" | "recorded" | "unavailable";
  detail: string; href: string; action: string; owner: string;
}

export function workspaceSetupSteps(snapshot: WorkbenchSnapshot): WorkspaceSetupStep[] {
  const admin = snapshot.roles.includes("admin");
  const author = snapshot.canAuthor;
  const documents = snapshot.documents?.documents.filter(item => item.workspaceId === snapshot.workspaceId && item.secretFindings === 0).length ?? 0;
  const agents = snapshot.pipelines?.config.configurables?.length ?? 0;
  const assistants = snapshot.studio?.profiles.length ?? 0;
  const runs = snapshot.pipelines?.runs.length ?? 0;
  // These are setup facts, not a release certificate or a model health check.
  return [
    { id: "model", title: "Configure a model", state: snapshot.chat.configured ? "recorded" : "pending",
      detail: snapshot.chat.configured ? "Configuration saved. Test a response in Chat." : "Add your provider or a company model connection.",
      href: "#/connections", action: "Open connections", owner: "You or an administrator" },
    { id: "documents", title: "Add reference material", state: !snapshot.documents ? "unavailable" : documents ? "recorded" : "pending",
      detail: !snapshot.documents ? "Document storage is unavailable." : documents ? `${documents} document(s) without credential findings. Check their suitability before use.` : "Add a policy, SOP or project brief.",
      href: "#/documents", action: author ? "Add documents" : "View documents", owner: "Author or administrator" },
    { id: "agents", title: "Choose an agent", state: !snapshot.pipelines && !snapshot.studio ? "unavailable" : agents + assistants ? "recorded" : "pending",
      detail: `${agents} saved configuration(s), ${assistants} assistant profile(s). Saved does not mean approved or runnable.`,
      href: admin ? "#/agent-studio" : "#/assistants", action: admin ? "Open Agent Studio" : "View assistants", owner: "Administrator; authors can prepare Model Studio candidates" },
    { id: "workflow", title: "Review the workflow", state: snapshot.pipelines ? "recorded" : "unavailable",
      detail: snapshot.pipelines ? `${snapshot.pipelines.config.stages.length} stages configured. Check assignments and review gates before running.` : "Workflow storage is unavailable.",
      href: "#/workflows", action: admin ? "Configure workflow" : "View workflow", owner: "Administrator" },
    { id: "run", title: "Try a supervised run", state: !snapshot.pipelines ? "unavailable" : runs ? "recorded" : "pending",
      detail: runs ? `${runs} run(s) recorded. Inspect the evidence and handoff status.` : "Start with one task and stop at its review gate.",
      href: "#/desk", action: author ? "Open work items" : "Review work items", owner: "Author starts; independent reviewers approve" },
  ];
}

export function workspaceSetupPage(snapshot: WorkbenchSnapshot, company: boolean, name = snapshot.workspaceId): Page {
  const admin = snapshot.roles.includes("admin");
  const canReview = snapshot.roles.includes("approver") || admin;
  const roles = [
    { id: "author", name: "Author", detail: "Prepare work, add references and start runs." },
    { id: "approver", name: "Reviewer", detail: "Review evidence and approve eligible handoffs." },
    { id: "admin", name: "Administrator", detail: "Configure workflows and workspace settings." },
  ];
  const roleGuide = roles.map(role => `<li><strong>${role.name}</strong> — ${role.detail}</li>`).join("");
  const cards = workspaceSetupSteps(snapshot).map(step => `<section class="panel account-panel" aria-labelledby="setup-${step.id}"><h2 id="setup-${step.id}">${step.title}</h2>
    ${status(step.state === "recorded" ? "neutral" : "warn", step.state === "recorded" ? "Recorded" : step.state === "unavailable" ? "Unavailable" : "To do")}
    <p>${escape(step.detail)}</p><p class="text-3">${escape(step.owner)}</p>
    ${step.state === "unavailable" ? "" : `<a class="secondary" href="${step.href}">${step.action}</a>`}</section>`).join("");
  const approvals = snapshot.workflow.requiredApprovals;
  return { title: "Workspace setup", context: `${company ? "Company" : "Local"} workspace · ${name}`,
    actions: company ? '<a class="secondary" href="/companies">Companies &amp; team</a>' : '<a class="secondary" href="#/account">Account settings</a>',
    body: `<section class="panel account-panel"><span class="eyebrow">YOUR ACCESS</span><h2>${escape(name)}</h2>
      <p>${roles.filter(role => snapshot.roles.includes(role.id as "author" | "approver" | "admin")).map(role => role.name).join(" · ") || "No workspace roles"}</p>
      <p class="text-3">${company ? "Membership and roles are verified through Clerk on each request." : "This is local access, not company sign-in."}</p>
      ${more("What each role does", `<ul>${roleGuide}</ul><p>Roles can be combined. Administrators cannot bypass independent approval rules.</p>`)}
      <details><summary>Workspace identity</summary><dl class="account-facts"><div><dt>Workspace</dt><dd>${escape(snapshot.workspaceId)}</dd></div><div><dt>Signed in as</dt><dd>${escape(snapshot.actor)}</dd></div></dl></details></section>
      <div class="account-grid">${cards}<section class="panel account-panel"><h2>Arrange reviewers</h2>${status("warn", "Verify with your team")}
        <p>Gated workflow handoffs need ${approvals} independent approval${approvals === 1 ? "" : "s"}. The run owner and output author cannot approve their own handoff.</p>
        <p class="text-3">Team coverage is not verified here. Model releases have their own approval policy.</p>
        ${company ? '<a class="secondary" href="/companies">Companies &amp; team</a>' : '<p class="text-3">A single local owner cannot complete independent approvals.</p>'}
        ${canReview ? '<a class="secondary" href="#/workspace">Open review queue</a>' : ""}</section></div>
      ${company ? '<p class="text-3">Repository execution requires an isolated worker in company mode.</p>' : ""}` };
}
