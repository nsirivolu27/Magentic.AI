import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createZenfluenceDirectory, zenfluenceConfigSchema, zenfluenceMaterial } from "../workbench/zenfluence.js";
import { zenfluenceCommand } from "../workbench/zenfluence-api.js";
import { zenfluencePage } from "../workbench/zenfluence-view.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";

const workspaceId = randomUUID();
const connection = { workspaceId, site: "https://example.atlassian.net", project: "KAN", spaceId: "123",
  emailSetting: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", tokenSetting: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY" };
const config = { connections: [connection] };
const credentials = (name: string) => name.includes("EMAIL") ? "service@example.invalid" : "test-token";
const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const page = (text = "Approved documentation") => ({ id: "456", spaceId: "123", status: "current", title: "Runbook", version: { number: 3 }, body: { atlas_doc_format: { value: JSON.stringify(adf(text)) } } });
const issue = () => ({ key: "KAN-12", fields: { summary: "Build report", status: { name: "In progress" }, project: { key: "KAN" }, updated: "2026-10-16T12:00:00.000Z", description: adf("Acceptance criteria") } });

test("Zenfluence configuration scopes company credentials and refuses arbitrary sites and settings", () => {
  assert.equal(zenfluenceConfigSchema.safeParse(config).success, true);
  for (const change of [{ site: "http://127.0.0.1" }, { site: "https://example.atlassian.net.evil.test" },
    { site: "https://example.atlassian.net/path" }, { tokenSetting: "HOME" }, { token: "secret" }, { spaceId: "../123" }]) {
    assert.equal(zenfluenceConfigSchema.safeParse({ connections: [{ ...connection, ...change }] }).success, false);
  }
  assert.equal(zenfluenceConfigSchema.safeParse({ connections: [connection, connection] }).success, false);
  const directory = createZenfluenceDirectory(config, () => undefined);
  assert.equal(directory(randomUUID()), undefined); assert.equal(directory(workspaceId)!.summary().ready, false);
  assert.doesNotMatch(JSON.stringify(directory(workspaceId)!.summary()), /tokenSetting|emailSetting/);
});

test("Jira and Confluence reads verify returned scope and never follow upstream redirects", async () => {
  let calls = 0; let foreign = false;
  const directory = createZenfluenceDirectory(config, credentials, async (url, options) => {
    calls++; assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
    assert.ok(options?.signal); assert.match(String(url), /^https:\/\/example.atlassian.net\//);
    if (String(url).includes("/rest/api/3/issue/")) return Response.json(foreign ? { ...issue(), key: "OTHER-12" } : issue());
    return Response.json(foreign ? { ...page(), spaceId: "999" } : page());
  });
  const reader = directory(workspaceId)!;
  const ticket = await reader.read({ kind: "jira", id: "KAN-12" }); assert.match(ticket.text, /Acceptance criteria/);
  assert.equal(ticket.url, "https://example.atlassian.net/browse/KAN-12");
  const doc = await reader.read({ kind: "confluence", id: "456" }); assert.equal(doc.revision, "3"); assert.equal(doc.text, "Approved documentation");
  const material = zenfluenceMaterial(doc); assert.match(material.content, /SHA-256/); assert.equal(material.url, doc.url);
  await assert.rejects(reader.read({ kind: "jira", id: "OTHER-12" }), /configured project/); assert.equal(calls, 2);
  foreign = true;
  await assert.rejects(reader.read({ kind: "jira", id: "KAN-12" }), /outside/);
  await assert.rejects(reader.read({ kind: "confluence", id: "456" }), /outside/);
});

test("upstream failures are bounded and sanitized; long source excerpts are labelled", async () => {
  const read = (fetcher: typeof fetch) => createZenfluenceDirectory(config, credentials, fetcher)(workspaceId)!.read({ kind: "confluence", id: "456" });
  await assert.rejects(read(async () => new Response("x".repeat(128001))), /128 KB/);
  await assert.rejects(read(async () => new Response("private upstream detail", { status: 403 })), error => error instanceof Error && /HTTP 403/.test(error.message) && !/private/.test(error.message));
  await assert.rejects(read(async () => { throw new Error("test-token"); }), error => error instanceof Error && !/test-token/.test(error.message));
  await assert.rejects(read(async () => Response.json({ ...page(), status: "draft" })), /valid data/);
  const long = await read(async () => Response.json(page("x".repeat(5000)))); assert.equal(long.truncated, true); assert.equal(long.text.length, 4500);
  assert.match(zenfluenceMaterial(long).content, /truncated/);
});

test("attaching rereads the source, checks workflow revision and preserves a frozen reference", async () => {
  let changed = false; let calls = 0;
  const directory = createZenfluenceDirectory(config, credentials, async () => { calls++; return Response.json(page(changed ? "Changed" : "Approved documentation")); });
  const pipelines = memoryPipelines();
  const identity = { workspaceId, actor: "writer", roles: ["author"] as const };
  const run = pipelines.execute(workspaceId, identity.actor, identity.roles, { action: "start", requestId: randomUUID(), title: "Build a report", brief: "Use the runbook" }, 2).runs[0]!;
  const source = { kind: "confluence", id: "456" };
  const read = await directory(workspaceId)!.read(source);
  const command = { action: "attach", source, runId: run.id, expectedRevision: run.revision, expectedSourceHash: read.contentHash };
  await assert.rejects(zenfluenceCommand(directory, pipelines, { ...identity, actor: "other" }, command), /owner/);
  await assert.rejects(zenfluenceCommand(directory, pipelines, identity, { ...command, runId: randomUUID() }), /not found/);
  assert.equal(calls, 1);
  changed = true; await assert.rejects(zenfluenceCommand(directory, pipelines, identity, command), /source changed/);
  changed = false; await zenfluenceCommand(directory, pipelines, identity, command);
  const saved = pipelines.snapshot(workspaceId).runs[0]!;
  assert.equal(saved.materials!.length, 1); assert.equal(saved.current, 0); assert.equal(saved.stages[0]!.status, "active");
  changed = true; assert.match(saved.materials![0]!.content, /Approved documentation/);
  await assert.rejects(zenfluenceCommand(directory, pipelines, identity, command), /workflow changed/);
});

test("Zenfluence page escapes imported text and clearly distinguishes setup from a connection", () => {
  const source = { kind: "jira" as const, id: "KAN-1", title: "<img>", text: "<script>danger</script>", revision: "1", url: "https://example.atlassian.net/browse/KAN-1", contentHash: "0".repeat(64), retrievedAt: new Date().toISOString(), truncated: false };
  const view = zenfluencePage({ configured: true, ready: true, project: "KAN" }, source, "", [], false);
  assert.match(view.body, /&lt;script&gt;/); assert.doesNotMatch(view.body, /<script>|<img>/);
  assert.match(zenfluencePage({ configured: false }, undefined, "", [], false).body, /No Atlassian data/);
});

test("Zenfluence HTTP requires current membership and rejects a client-supplied tenant", async t => {
  let member = true; let calls = 0;
  const zenfluence = createZenfluenceDirectory(config, credentials, async () => { calls++; return Response.json(issue()); });
  const server = createWorkbenchServer({ assets: new Map(), zenfluence,
    context: { store: memoryStore(), audit: memoryAudit(), members: { rolesFor: async () => member ? ["author"] : [] } },
    authenticate: async request => request.headers.authorization === "session" ? { workspaceId, actor: "writer" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const url = `http://127.0.0.1:${address.port}/api/zenfluence`;
  const input = { action: "read", source: { kind: "jira", id: "KAN-12" } };
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { Authorization: "session", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await post({ ...input, workspaceId: randomUUID() })).status, 400);
  assert.equal((await post(input)).status, 200); member = false;
  assert.equal((await post(input)).status, 403); assert.equal(calls, 1);
});
