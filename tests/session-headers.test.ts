import assert from "node:assert/strict";
import test from "node:test";
import { sessionHeaders } from "../workbench/session-headers.js";

test("managed requests renew their bearer token while retaining the selected workspace", async () => {
  let calls = 0;
  const base = { "Content-Type": "application/json", "X-Magentic-Workspace": "company-one", Authorization: "Bearer obsolete" };
  const getToken = async () => "session-" + ++calls;
  assert.equal((await sessionHeaders(base, true, getToken)).Authorization, "Bearer session-1");
  const second = await sessionHeaders(base, true, getToken);
  assert.equal(second.Authorization, "Bearer session-2");
  assert.equal(second["X-Magentic-Workspace"], "company-one");
  assert.equal(base.Authorization, "Bearer obsolete");
});

test("local mode keeps existing authentication without consulting Clerk", async () => {
  const base = { "X-Magentic-Workspace": "local" };
  assert.deepEqual(await sessionHeaders(base, false, async () => { throw new Error("must not run"); }), base);
});

test("missing and failed managed sessions cannot fall back to stale authorization", async () => {
  const base = { Authorization: "Bearer stale" };
  await assert.rejects(sessionHeaders(base, true, async () => null), /Sign in again/);
  await assert.rejects(sessionHeaders(base, true, async () => { throw new Error("private provider detail"); }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /refresh sign-in/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});
