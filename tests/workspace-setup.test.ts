import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { workspaceSetupPage, workspaceSetupSteps } from "../workbench/workspace-setup.js";
import { companyClientScript } from "../workbench/company-page.js";

function snapshot(roles: WorkbenchSnapshot["roles"] = ["author"]): WorkbenchSnapshot {
  return { workspaceId: "one", actor: "user_member", roles, canAuthor: roles.includes("author") || roles.includes("admin"),
    workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, records: [], audit: [], demo: false,
    mcp: { agents: [], withheld: [] }, chat: { configured: false } };
}

test("setup distinguishes missing services from empty configured services", () => {
  const empty = snapshot();
  const steps = workspaceSetupSteps(empty);
  assert.equal(steps.find(item => item.id === "model")!.state, "pending");
  for (const id of ["documents", "agents", "workflow", "run"]) assert.equal(steps.find(item => item.id === id)!.state, "unavailable");
  const available = workspaceSetupSteps({ ...empty, documents: { documents: [] }, pipelines: memoryPipelines().snapshot("one") });
  assert.equal(available.find(item => item.id === "documents")!.state, "pending");
  assert.equal(available.find(item => item.id === "agents")!.state, "pending");
  assert.equal(available.find(item => item.id === "workflow")!.state, "recorded");
  assert.equal(available.find(item => item.id === "run")!.state, "pending");
});

test("credential-flagged and foreign documents never count toward reference setup", () => {
  const document = { id: randomUUID(), workspaceId: "one", title: "SOP", contentHash: "a".repeat(64), bytes: 10,
    secretFindings: 1, excerpt: "", addedBy: "user_member", addedAt: "", runs: [], datasets: [] };
  const current = { ...snapshot(), documents: { documents: [document, { ...document, workspaceId: "two", secretFindings: 0 }] } };
  assert.equal(workspaceSetupSteps(current).find(item => item.id === "documents")!.state, "pending");
  current.documents.documents.push({ ...document, id: randomUUID(), secretFindings: 0 });
  assert.equal(workspaceSetupSteps(current).find(item => item.id === "documents")!.state, "recorded");
});

test("onboarding presents role-appropriate actions without granting privileges", () => {
  const data = { ...snapshot(["approver"]), documents: { documents: [] }, pipelines: memoryPipelines().snapshot("one") };
  const reviewer = workspaceSetupPage(data, true).body;
  assert.match(reviewer, />View documents</);
  assert.match(reviewer, />View workflow</);
  assert.match(reviewer, />Open review queue</);
  assert.doesNotMatch(reviewer, />Configure workflow</);
  assert.doesNotMatch(reviewer, />Open Agent Studio</);
  const administrator = workspaceSetupPage({ ...data, roles: ["admin"], canAuthor: true }, true).body;
  assert.match(administrator, />Configure workflow</);
  assert.match(administrator, />Open Agent Studio</);
  assert.match(administrator, /cannot approve their own handoff/);
  assert.match(administrator, /Team coverage is not verified/);
  assert.match(administrator, /2 independent approvals/);
});

test("local onboarding cannot claim company sign-in and escapes workspace identity", () => {
  const local = workspaceSetupPage({ ...snapshot(), actor: "<script>bad()</script>", workspaceId: "<workspace>" }, false, "<company>").body;
  assert.match(local, /local access, not company sign-in/);
  assert.doesNotMatch(local, /href="\/companies"/);
  assert.doesNotMatch(local, /<script>|<company>|<workspace>/);
  assert.match(local, /&lt;company&gt;/);
  assert.match(local, /&lt;script&gt;/);
});

test("recorded model configuration and runs never claim completed approval or connectivity", () => {
  const pipelines = memoryPipelines();
  const state = pipelines.execute("one", "user_member", ["author"], {
    action: "start", requestId: randomUUID(), title: "First task", brief: "Check the SOP." }, 2);
  const data = { ...snapshot(), chat: { configured: true }, pipelines: state };
  const steps = workspaceSetupSteps(data);
  assert.equal(steps.find(item => item.id === "model")!.state, "recorded");
  assert.match(steps.find(item => item.id === "model")!.detail, /Test a response/);
  assert.equal(steps.find(item => item.id === "run")!.state, "recorded");
  assert.match(steps.find(item => item.id === "run")!.detail, /Inspect the evidence/);
  const fresh = workspaceSetupSteps({ ...snapshot(), workspaceId: "two", pipelines: pipelines.snapshot("two") });
  assert.equal(fresh.find(item => item.id === "run")!.state, "pending");
});

test("company selection shows verified roles and opens onboarding only after the server accepts", async () => {
  class Element {
    textContent = ""; className = ""; disabled = false;
    children: Element[] = []; onclick?: () => Promise<void>;
    append(...children: Element[]) { this.children.push(...children); }
    appendChild(child: Element) { this.children.push(child); }
    replaceChildren() { this.children = []; }
  }
  const elements = new Map(["company-switcher", "company-list", "company-error", "company-refresh"].map(id => [id, new Element()]));
  const destinations: string[] = [];
  const saved = new Map<string, string>();
  let allowed = false;
  const context = {
    window: { magenticAccountReady: Promise.resolve({ companies: true }),
      Clerk: { isSignedIn: true, mountOrganizationSwitcher() {}, session: { getToken: async () => "fixture" } } },
    document: { getElementById: (id: string) => elements.get(id), createElement: () => new Element() },
    location: { assign: (url: string) => destinations.push(url), replace: (url: string) => destinations.push(url) },
    sessionStorage: { setItem: (key: string, value: string) => saved.set(key, value) },
    AbortSignal,
    fetch: async (path: string, init: RequestInit) => {
      if (path === "/api/companies") return Response.json([{ name: "<Company>", organizationId: "org_one", roles: ["author"], workspaceId: "one", canCreate: false }]);
      assert.equal(path, "/api/companies/open");
      assert.deepEqual(JSON.parse(String(init.body)), { organizationId: "org_one" });
      return allowed ? Response.json({ workspaceId: "one" }) : Response.json({ error: "Membership changed." }, { status: 403 });
    },
  };
  await runInNewContext(companyClientScript, context);
  const card = elements.get("company-list")!.children[0]!;
  assert.equal(card.children[0]!.textContent, "<Company>");
  assert.equal(card.children[1]!.textContent, "Your roles: Author");
  await card.children[2]!.onclick!();
  assert.equal(destinations.length, 0);
  assert.equal(saved.size, 0);
  assert.equal(elements.get("company-error")!.textContent, "Membership changed.");
  allowed = true;
  await card.children[2]!.onclick!();
  assert.deepEqual(destinations, ["/#/onboarding"]);
  assert.equal(saved.get("magentic.companyWorkspace"), "one");
});
