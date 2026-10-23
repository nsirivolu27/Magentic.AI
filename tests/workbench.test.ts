import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "../workbench/server.js";

const definition = { name: "reader", title: "Reader", description: "Read conversations.", version: "1.0.0", tools: ["list_conversations"], instructions: "Read only." };

async function fixture(t: TestContext) {
  const context = {
    store: memoryStore(), audit: memoryAudit(),
    workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([
      { workspaceId: "one", actor: "writer", roles: ["author"] },
      { workspaceId: "one", actor: "reviewer", roles: ["approver"] },
      { workspaceId: "one", actor: "second", roles: ["approver"] },
      { workspaceId: "two", actor: "outsider", roles: ["admin"] },
    ]),
  };
  const server = createWorkbenchServer({ context, assets: new Map(), authenticate: async (request) => {
    const actor = request.headers.authorization?.replace("Bearer ", "");
    return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(actor = "", path = "/api/workspace", data?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), "Content-Type": "application/json", ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json(), cache: response.headers.get("cache-control") };
  }
  async function seed() {
    assert.equal((await request("writer", "/api/records", { definition })).status, 200);
    const hash = (await request("writer")).data.records[0].hash;
    assert.equal((await request("writer", "/api/records/reader/submit", { expectedHash: hash })).status, 200);
    return hash as string;
  }
  return { context, request, seed };
}

test("workbench requires authenticated workspace membership and does not cache private data", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request()).status, 401);
  assert.equal((await request("unknown")).status, 403);
  const response = await request("writer");
  assert.equal(response.status, 200);
  assert.equal(response.cache, "no-store");
});

test("workbench enforces roles and two distinct approvals through the existing gate", async (t) => {
  const { request, seed } = await fixture(t);
  const expectedHash = await seed();
  assert.equal((await request("writer", "/api/records/reader/approve", { expectedHash })).status, 403);
  assert.equal((await request("reviewer", "/api/records/reader/approve", { expectedHash })).status, 200);
  assert.equal((await request("writer")).data.records[0].eligible, false);
  assert.equal((await request("reviewer", "/api/records/reader/approve", { expectedHash })).status, 409);
  assert.equal((await request("second", "/api/records/reader/approve", { expectedHash })).status, 200);
  const result = (await request("writer")).data;
  assert.equal(result.records[0].eligible, true);
  assert.equal(result.audit.length, 4);
});

test("workbench rejects impersonation, cross-workspace access and cross-origin writes", async (t) => {
  const { request, seed } = await fixture(t);
  const expectedHash = await seed();
  assert.deepEqual((await request("outsider")).data.records, []);
  assert.equal((await request("outsider", "/api/records/reader/approve", { expectedHash })).status, 404);
  assert.equal((await request("writer", "/api/records/reader/approve", { expectedHash, actor: "reviewer" })).status, 400);
  assert.equal((await request("reviewer", "/api/records/reader/approve", { expectedHash }, { Origin: "https://other.example" })).status, 403);
});

test("workbench refuses to sign content that changed after the reviewer loaded it", async (t) => {
  const { request, seed, context } = await fixture(t);
  const expectedHash = await seed();
  const record = (await context.store.get("one", "reader"))!;
  await context.store.put({ ...record, definition: { ...record.definition, instructions: "Changed." } });
  assert.equal((await request("reviewer", "/api/records/reader/approve", { expectedHash })).status, 409);
  assert.equal((await context.audit.list("one")).length, 2);
});

test("simultaneous approvals retain both signatures", async (t) => {
  const { request, seed } = await fixture(t);
  const expectedHash = await seed();
  const results = await Promise.all(["reviewer", "second"].map((actor) => request(actor, "/api/records/reader/approve", { expectedHash })));
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.equal((await request("writer")).data.records[0].validApprovers.length, 2);
});

test("editing is limited to drafts and requires the previously loaded hash", async (t) => {
  const { request } = await fixture(t);
  await request("writer", "/api/records", { definition });
  assert.equal((await request("writer", "/api/records", { definition })).status, 409);
  const expectedHash = (await request("writer")).data.records[0].hash;
  assert.equal((await request("writer", "/api/records", { definition: { ...definition, title: "Updated" }, expectedHash })).status, 200);
});

test("workbench refuses personal mode and oversized definitions", async (t) => {
  assert.throws(() => createWorkbenchServer({ context: { store: memoryStore(), audit: memoryAudit() }, assets: new Map(), authenticate: async () => undefined }), /member directory/);
  const { request } = await fixture(t);
  assert.equal((await request("writer", "/api/records", { definition: { ...definition, instructions: "x".repeat(70_000) } })).status, 413);
});
