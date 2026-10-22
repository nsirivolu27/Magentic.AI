import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";

test("the public welcome page grants no workspace access and still honors request guards", async t => {
  let authenticationCalls = 0;
  const server = createWorkbenchServer({
    assets: new Map(),
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([]) },
    authenticate: async () => { authenticationCalls++; return undefined; },
    guard: request => request.headers["x-test-refuse"] ? { status: 403, message: "Refused" } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const welcome = await fetch(origin + "/welcome");
  assert.equal(welcome.status, 200);
  assert.match(welcome.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(welcome.headers.get("set-cookie"), null);
  assert.equal(authenticationCalls, 0);
  const html = await welcome.text();
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /<script/);
  assert.equal((await fetch(origin + "/api/workspace")).status, 401);
  assert.equal(authenticationCalls, 1);
  assert.equal((await fetch(origin + "/welcome", { headers: { "x-test-refuse": "yes" } })).status, 403);
  assert.equal((await fetch(origin + "/welcome", { method: "POST" })).status, 404);
});
