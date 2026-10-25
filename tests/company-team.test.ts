import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clerkCompanyRoster, companyTeamReport, type CompanyTeamMember, type CompanyTeamReport } from "../workbench/company-team.js";
import { companyTeamPanel } from "../workbench/company-team-view.js";
import { createCompanyTeamView } from "../workbench/company-team-controller.js";
import { createCompanyAccess } from "../workbench/company-access.js";
import { accountsSchema } from "../workbench/accounts.js";
import { workspaceDirectory } from "../workbench/workspace-directory.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

const member = (actor: string, org = "org_one") => ({ id: "membership_" + actor, role: "org:reviewer",
  organization: { id: org }, public_user_data: { user_id: actor, identifier: "not-returned@example.test" } });
const transport = (pages: unknown[]) => {
  let page = 0;
  return (async () => Response.json(pages[page++])) as typeof fetch;
};

test("company roster follows pagination, binds every member to its company and returns no contact details", async () => {
  const calls: string[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    return Response.json({ data: [member(calls.length === 1 ? "user_first" : "user_second")], total_count: 2 });
  }) as typeof fetch;
  const rows = await clerkCompanyRoster("sk_test_fixture", request)("org_one");
  assert.deepEqual(rows, [{ actor: "user_first", role: "org:reviewer" }, { actor: "user_second", role: "org:reviewer" }]);
  assert.equal(calls[0], "https://api.clerk.com/v1/organizations/org_one/memberships?limit=500&offset=0");
  assert.match(calls[1]!, /offset=1$/);
  assert.doesNotMatch(JSON.stringify(rows), /identifier|example.test/);
});

test("partial, duplicate, foreign and changing roster pages fail closed", async () => {
  const first = member("user_first");
  for (const pages of [
    [{ data: [], total_count: 1 }],
    [{ data: [first, first], total_count: 2 }],
    [{ data: [first, { ...first, id: "another" }], total_count: 2 }],
    [{ data: [member("user_other", "org_other")], total_count: 1 }],
    [{ data: [{ ...first, public_user_data: null }], total_count: 1 }],
    [{ data: [], total_count: 2501 }],
    [{ data: [first], total_count: 2 }, { data: [member("user_second")], total_count: 3 }],
  ]) await assert.rejects(clerkCompanyRoster("sk_test_fixture", transport(pages))("org_one"), /could not be verified/);
  await assert.rejects(clerkCompanyRoster("sk_test_fixture", (async () => { throw new Error("private upstream details"); }) as typeof fetch)("org_one"),
    error => error instanceof Error && !error.message.includes("private"));
  await assert.rejects(clerkCompanyRoster("sk_test_fixture", (async () => new Response("secret", { status: 429 })) as typeof fetch)("org_one"), /could not be verified/);
  await assert.rejects(clerkCompanyRoster("sk_test_fixture", transport([]))("../other"), /Invalid company/);
});

function waitingRun() {
  const pipeline = memoryPipelines();
  const snapshot = pipeline.execute("one", "user_owner", ["author"], {
    action: "start", requestId: randomUUID(), title: "Review documentation", brief: "Check the supplied SOP.",
  }, 3);
  const run = snapshot.runs[0]!;
  run.stages[0]!.status = "awaiting_review";
  run.stages[0]!.outputBy = "user_writer";
  run.stages[0]!.approvals = ["user_signed"];
  return run;
}

test("coverage excludes owners, output authors and previous signers, deduplicates reviewers and honors the run's saved requirement", () => {
  const run = waitingRun();
  const members: CompanyTeamMember[] = ["user_owner", "user_writer", "user_signed", "user_next", "user_next"].map(actor => ({ actor, roles: ["admin"] }));
  members.push({ actor: "user_author", roles: ["author"] });
  const before = structuredClone(run);
  const report = companyTeamReport("one", members, [run, { ...run, workspaceId: "two", title: "Foreign" }]);
  assert.equal(report.handoffs.length, 1);
  assert.deepEqual(report.handoffs[0], { runId: run.id, title: run.title, stage: run.config.stages[0]!.name,
    required: 3, recorded: 1, available: 1, shortfall: 1 });
  members.push({ actor: "user_additional", roles: ["approver"] });
  assert.equal(companyTeamReport("one", members, [run]).handoffs[0]!.shortfall, 0);
  assert.deepEqual(run, before);
  run.status = "complete";
  assert.equal(companyTeamReport("one", members, [run]).handoffs.length, 0);
  assert.equal(companyTeamReport("one", members).pipelineAvailable, false);
  assert.equal(companyTeamReport("one", members, []).pipelineAvailable, true);
});

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = accountsSchema.parse({
  clerk: { issuer: "https://team.example.clerk.accounts.dev",
    publishableKey: `pk_test_${Buffer.from("team.example.clerk.accounts.dev$").toString("base64")}`,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), authorizedParties: ["https://portal.example"] },
  members: [], companies: {},
});
function token(actor: string) {
  const now = Math.floor(Date.now() / 1000);
  const data = [{ alg: "RS256" }, { iss: config.clerk.issuer, azp: "https://portal.example", sub: actor,
    sid: "sess_fixture", iat: now, nbf: now - 1, exp: now + 300 }].map(item => Buffer.from(JSON.stringify(item)).toString("base64url")).join(".");
  return data + "." + sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url");
}
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "magentic-team-"));
  const store = fileWorkspaceStore(path);
  const directory = workspaceDirectory(path, store, "system");
  const workspace = directory.provisionCompany("org_one", "Company workspace").workspaceId;
  const other = directory.provisionCompany("org_two", "Other workspace").workspaceId;
  const roles = new Map([["user_admin", "org:admin"], ["user_member", "org:member"]]);
  let calls = 0, revoke = false;
  const companies = createCompanyAccess(config, directory, async actor => roles.has(actor)
    ? [{ id: "membership", role: roles.get(actor)!, organization: { id: "org_one", name: "Company workspace" } }] : [],
    async org => {
      assert.equal(org, "org_one"); calls++;
      if (revoke) roles.delete("user_admin");
      return [{ actor: "user_admin", role: "org:admin" }, { actor: "user_member", role: "org:member" },
        { actor: "user_unmapped", role: "org:unknown" }];
    });
  return { companies, workspace, other, roles, get calls() { return calls; }, revoke() { revoke = true; },
    close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}

test("company team access checks current admin membership before and after lookup and does not grant unmapped roles", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.companies.team(f.workspace, "user_member"), /administrator/);
    await assert.rejects(f.companies.team(f.other, "user_admin"), /administrator/);
    assert.equal(f.calls, 0);
    const result = await f.companies.team(f.workspace, "user_admin");
    assert.deepEqual(result.find(item => item.actor === "user_unmapped")!.roles, []);
    assert.deepEqual(result.find(item => item.actor === "user_member")!.roles, ["author"]);
    f.revoke();
    await assert.rejects(f.companies.team(f.workspace, "user_admin"), /access changed/);
  } finally { f.close(); }
});

test("team HTTP route requires signed-in company admin, refuses tenant overrides and writes, and does not cache membership", async t => {
  const f = fixture();
  const server = createWorkbenchServer({
    assets: new Map(), accounts: config, companies: f.companies, authenticate: f.companies.authenticate,
    context: { store: memoryStore(), audit: memoryAudit(), members: f.companies.members, workflow: DEFAULT_WORKFLOW },
    pipelines: memoryPipelines(),
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); f.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/company-team`;
  const headers = (actor: string, workspace = f.workspace) => ({ Authorization: "Bearer " + token(actor), "X-Magentic-Workspace": workspace });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: headers("user_member") })).status, 403);
  assert.equal((await fetch(url, { headers: headers("user_admin", f.other) })).status, 403);
  assert.equal((await fetch(url + "?workspaceId=other", { headers: headers("user_admin") })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers: headers("user_admin") })).status, 405);
  assert.equal(f.calls, 0);
  const response = await fetch(url, { headers: headers("user_admin") });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json() as CompanyTeamReport;
  assert.equal(report.workspaceId, f.workspace); assert.equal(report.members.length, 3);
  assert.equal(report.pipelineAvailable, true);
  f.roles.set("user_admin", "org:member");
  assert.equal((await fetch(url, { headers: headers("user_admin") })).status, 403);
  assert.equal(f.calls, 1);
});

test("team panel keeps rosters admin-only, escapes values and distinguishes missing workflow data", () => {
  const run = waitingRun(); run.title = "<img src=x>";
  const report = companyTeamReport("one", [{ actor: "<member>", roles: [] }], [run]);
  const html = companyTeamPanel(true, true, { loading: false, report });
  assert.match(html, /Needs 2 more reviewer/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<member>/);
  assert.match(html, /not an approval/);
  assert.match(html, /No workspace access/);
  assert.doesNotMatch(companyTeamPanel(true, false, { loading: false, report }), /Member ID|data-company-team-refresh|&lt;member/);
  assert.match(companyTeamPanel(false, true), /Local mode/);
  assert.match(companyTeamPanel(true, true, { loading: false, report: companyTeamReport("one", []) }), /could not be checked/);
});

test("late team responses cannot cross workspace or identity changes and failed refreshes discard previous counts", async () => {
  let resolve!: (report: CompanyTeamReport) => void;
  let fail = false;
  const controller = createCompanyTeamView({ render() {}, request: () => fail ? Promise.reject(new Error("private"))
    : new Promise<CompanyTeamReport>(done => { resolve = done; }) });
  controller.context("one", "user_admin");
  const first = controller.load();
  assert.equal(controller.state.loading, true);
  controller.context("two", "user_admin"); controller.context("one", "user_admin");
  resolve(companyTeamReport("one", []));
  await first;
  assert.equal(controller.state.report, undefined);
  const second = controller.load();
  resolve(companyTeamReport("one", [])); await second;
  assert.ok(controller.state.report);
  fail = true; await controller.load();
  assert.equal(controller.state.report, undefined); assert.ok(controller.state.error);
  assert.doesNotMatch(controller.state.error!, /private/);
  fail = false;
  const third = controller.load(); controller.context();
  resolve(companyTeamReport("one", [])); await third;
  assert.equal(controller.state.report, undefined);
  controller.context("one", "user_admin");
  const mismatched = controller.load();
  resolve(companyTeamReport("two", [])); await mismatched;
  assert.equal(controller.state.report, undefined);
  assert.ok(controller.state.error);
});

