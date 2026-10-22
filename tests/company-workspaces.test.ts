import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { accountsSchema, type AccountsConfig } from "../workbench/accounts.js";
import { accountPublicConfig } from "../workbench/account-portal.js";
import { clerkMemberships, createCompanyAccess, type CompanyMembership } from "../workbench/company-access.js";
import { companyGuard, companyDatasetFiles } from "../workbench/company-server.js";
import { workspaceDirectory } from "../workbench/workspace-directory.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { filePipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { createDocuments, memoryDocumentStore } from "../workbench/documents.js";
import { installWorkforceAgents } from "../workbench/workforce-marketplace.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = accountsSchema.parse({
  clerk: { issuer: "https://company.example.clerk.accounts.dev", publishableKey: `pk_test_${Buffer.from("company.example.clerk.accounts.dev$").toString("base64")}`,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), authorizedParties: ["https://portal.example"] },
  members: [], companies: {},
});
function token(actor: string, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const content = [ { alg: "RS256" }, { iss: config.clerk.issuer, azp: "https://portal.example", sub: actor,
    sid: "sess_fixture", iat: now, nbf: now - 1, exp: now + 60, ...extra } ].map(item => Buffer.from(JSON.stringify(item)).toString("base64url")).join(".");
  return content + "." + sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url");
}
function membership(org: string, role = "org:admin", name = "Same company name"): CompanyMembership {
  return { id: "membership_" + org, role, organization: { id: org, name } };
}
function setup() {
  const path = mkdtempSync(join(tmpdir(), "magentic-companies-"));
  const store = fileWorkspaceStore(path);
  const directory = workspaceDirectory(path, store, "system");
  const access = new Map<string, CompanyMembership[]>([
    ["user_admin", [membership("org_one")]], ["user_member", [membership("org_one", "org:member")]],
    ["user_reviewer", [membership("org_one", "org:reviewer")]], ["user_other", [membership("org_two")]],
  ]);
  const companies = createCompanyAccess(config, directory, async actor => structuredClone(access.get(actor) ?? []));
  return { path, store, directory, access, companies, close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}

test("company config rejects mixed static membership and keeps public settings minimal", () => {
  assert.deepEqual(accountPublicConfig(config), { enabled: true, issuer: config.clerk.issuer, publishableKey: config.clerk.publishableKey, companies: true });
  assert.equal(accountsSchema.safeParse({ ...config, companies: undefined }).success, false);
  assert.equal(accountsSchema.safeParse({ ...config, companies: { enabled: true } }).success, false);
  assert.equal(accountsSchema.safeParse({ ...config, members: [{ actor: "user_admin", workspaceId: "system", roles: ["admin"] }] }).success, false);
  assert.equal(accountsSchema.safeParse({ ...config, companies: { roles: { "org:member": ["owner"] } } }).success, false);
});

test("company provisioning is admin-only, idempotent and independent of display names", async () => {
  const f = setup();
  try {
    await assert.rejects(f.companies.open("user_member", { organizationId: "org_one" }), /admin/);
    await assert.rejects(f.companies.open("user_admin", { organizationId: "org_two" }), /not a member/);
    await assert.rejects(f.companies.open("user_admin", { organizationId: "org_one", roles: ["admin"] }));
    const first = await f.companies.open("user_admin", { organizationId: "org_one" });
    const repeated = await Promise.all(Array.from({ length: 4 }, () => f.companies.open("user_admin", { organizationId: "org_one" })));
    assert.ok(repeated.every(item => item.workspaceId === first.workspaceId));
    assert.deepEqual(await f.companies.open("user_member", { organizationId: "org_one" }), first);
    const other = await f.companies.open("user_other", { organizationId: "org_two" });
    assert.notEqual(first.workspaceId, other.workspaceId);
    assert.equal(f.directory.list().workspaces.length, 3);
    assert.deepEqual((await f.companies.listing("user_admin")).workspaces.map(item => item.id), [first.workspaceId]);
    assert.equal((await f.companies.listing("user_unknown")).workspaces.length, 0);
  } finally { f.close(); }
});

test("company role changes and removals take effect without cached privileges", async () => {
  const f = setup();
  try {
    const { workspaceId } = await f.companies.open("user_admin", { organizationId: "org_one" });
    assert.ok((await f.companies.members.rolesFor(workspaceId, "user_admin")).includes("admin"));
    f.access.set("user_admin", [membership("org_one", "org:member")]);
    assert.deepEqual(await f.companies.members.rolesFor(workspaceId, "user_admin"), ["author"]);
    f.access.set("user_admin", [membership("org_one", "org:unmapped")]);
    assert.deepEqual(await f.companies.members.rolesFor(workspaceId, "user_admin"), []);
    f.access.delete("user_admin");
    assert.deepEqual(await f.companies.members.rolesFor(workspaceId, "user_admin"), []);
    assert.deepEqual(await f.companies.members.rolesFor("system", "user_other"), []);
  } finally { f.close(); }
});

test("company bindings and installed agents survive reopening storage", async () => {
  const f = setup();
  let reopened: ReturnType<typeof fileWorkspaceStore> | undefined;
  try {
    const { workspaceId } = await f.companies.open("user_admin", { organizationId: "org_one" });
    filePipelines(f.store).execute(workspaceId, "user_admin", ["admin"], { action: "configure", expectedVersion: 1,
      config: installWorkforceAgents(DEFAULT_PIPELINE, ["ontology"]) }, 2);
    f.store.close(); reopened = fileWorkspaceStore(f.path);
    const directory = workspaceDirectory(f.path, reopened, "system");
    assert.equal(directory.company("org_one")?.id, workspaceId);
    assert.equal(filePipelines(reopened).snapshot(workspaceId).config.configurables?.length, 1);
  } finally { reopened?.close(); f.close(); }
});

test("membership transport validates pagination, user binding and sanitized failures", async () => {
  const calls: string[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); assert.equal(init?.redirect, "error");
    return Response.json({ data: [membership(calls.length === 1 ? "org_one" : "org_two")], total_count: 2 });
  }) as typeof fetch;
  assert.equal((await clerkMemberships("sk_test_fixture", transport)("user_admin")).length, 2);
  assert.match(calls[1]!, /offset=1$/);
  for (const data of [
    { data: [membership("org_one"), membership("org_one")], total_count: 2 },
    { data: [{ ...membership("org_one"), public_user_data: { user_id: "user_other" } }], total_count: 1 },
    { data: [], total_count: 1 }, { data: [], total_count: 3000 }, { data: "unexpected" },
  ]) {
    await assert.rejects(clerkMemberships("sk_test_fixture", (async () => Response.json(data)) as typeof fetch)("user_admin"), /could not be verified/);
  }
  await assert.rejects(clerkMemberships("sk_test_fixture", (async () => { throw new Error("private provider response"); }) as typeof fetch)("user_admin"), error => error instanceof Error && !error.message.includes("private"));
  await assert.rejects(clerkMemberships("sk_test_fixture", (async () => new Response("secret", { status: 429 })) as typeof fetch)("user_admin"), /could not be verified/);
});

test("company guard refuses foreign hosts, cross-origin writes and cookie writes without origin", () => {
  const guard = companyGuard("https://portal.example");
  const request = (headers: object, method = "POST") => ({ headers, method }) as IncomingMessage;
  assert.equal(guard(request({ host: "portal.example", origin: "https://portal.example" })), undefined);
  assert.equal(guard(request({ host: "portal.example", authorization: "Bearer fixture" })), undefined);
  assert.equal(guard(request({ host: "foreign.example", origin: "https://portal.example" }))?.status, 403);
  assert.equal(guard(request({ host: "portal.example", origin: "https://foreign.example" }))?.status, 403);
  assert.equal(guard(request({ host: "portal.example", cookie: "__session=fixture" }))?.status, 403);
  assert.throws(() => companyGuard("http://public.example"));
  assert.throws(() => companyGuard("https://portal.example/path"));
});

test("HTTP company sign-in isolates marketplace agents, documents and automation runs", async () => {
  const f = setup();
  const pipelines = filePipelines(f.store);
  const studio = memoryModelStudio();
  const documents = createDocuments({ store: memoryDocumentStore(), studio, pipelines, requiredApprovals: 2 });
  const server = createWorkbenchServer({ accounts: config, companies: f.companies, workspaces: f.directory, assets: new Map(),
    context: { store: memoryStore(), audit: memoryAudit(), members: f.companies.members }, authenticate: f.companies.authenticate,
    pipelines, studio, documents });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (path: string, actor: string, body?: unknown, workspace?: string, extraToken = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token(actor, extraToken)}`, "Content-Type": "application/json",
      ...(workspace ? { "X-Magentic-Workspace": workspace } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call("/api/companies", "user_admin", undefined, undefined, { exp: 0 })).status, 401);
    assert.equal((await call("/api/workspaces", "user_admin")).status, 200);
    const one = await (await call("/api/companies/open", "user_admin", { organizationId: "org_one" })).json() as { workspaceId: string };
    const two = await (await call("/api/companies/open", "user_other", { organizationId: "org_two" })).json() as { workspaceId: string };
    const config = installWorkforceAgents(DEFAULT_PIPELINE, ["knowledge", "ontology"]);
    const change = { action: "configure", expectedVersion: 1, config };
    assert.equal((await call("/api/pipeline", "user_member", change, one.workspaceId)).status, 403);
    assert.equal((await call("/api/pipeline", "user_admin", change, one.workspaceId)).status, 200);
    assert.equal((await call("/api/pipeline", "user_admin", change, one.workspaceId)).status, 409);
    assert.equal((await call("/api/documents", "user_member", { action: "add_document", title: "Internal SOP", text: "Synthetic company-only procedure." }, one.workspaceId)).status, 200);
    assert.equal((await call("/api/pipeline", "user_member", { action: "start", requestId: randomUUID(), title: "Review company procedure", brief: "Review the authorized SOP." }, one.workspaceId)).status, 200);
    const own = await (await call("/api/workspace", "user_member", undefined, one.workspaceId)).json();
    assert.equal(own.pipelines.config.configurables.length, 2);
    assert.equal(own.pipelines.runs.length, 1);
    assert.equal(own.documents.documents.length, 1);
    const other = await (await call("/api/workspace", "user_other", undefined, two.workspaceId)).json();
    assert.equal(other.pipelines.config.configurables, undefined);
    assert.equal(other.pipelines.runs.length, 0);
    assert.equal(other.documents.documents.length, 0);
    for (const path of ["/api/workspace", "/api/account", "/api/agent-studio/models"]) assert.equal((await call(path, "user_other", undefined, one.workspaceId)).status, 403);
    assert.equal((await call("/api/pipeline-mcp", "user_other", { jsonrpc: "2.0", id: 1, method: "tools/list" }, one.workspaceId)).status, 403);
    assert.equal((await call("/api/workspaces/open", "user_other", { workspaceId: one.workspaceId }, two.workspaceId)).status, 403);
    f.access.delete("user_member");
    assert.equal((await call("/api/workspace", "user_member", undefined, one.workspaceId, { org_role: "org:admin" })).status, 403);
    assert.equal((await call("/api/bots", "user_admin", { action: "attach", path: "C:/" }, one.workspaceId)).status, 404);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    f.close();
  }
});


test("company datasets accept inline storage but never host file imports", () => {
  const path = mkdtempSync(join(tmpdir(), "magentic-company-datasets-"));
  try {
    const files = companyDatasetFiles(path);
    const saved = files.store('{"prompt":"Synthetic request","completion":"Synthetic answer"}\n');
    assert.match(files.read(saved.file), /Synthetic answer/);
    assert.throws(() => files.importFile(), /Host file imports are unavailable/);
  } finally { rmSync(path, { recursive: true, force: true }); }
});
