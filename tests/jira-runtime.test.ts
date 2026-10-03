import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { filePipelines, type PipelineRun } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { createJiraRuntime } from "../workbench/jira-runtime.js";
import { deliver, workspaceActionStore } from "../workbench/jira-actions.js";
import { previewDelivery, restDelivery, type JiraDelivery, type PendingJiraAction } from "../workbench/jira.js";

const owner = { workspaceId: "one", actor: "owner", roles: ["admin"] as const };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "magentic-jira-runtime-"));
  const store = fileWorkspaceStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = filePipelines(store);
  const start = () => engine.execute("one", "owner", ["admin"], {
    action: "start", requestId: randomUUID(), title: "Review Jira action", brief: "Keep the workflow evidence.",
  }, 1).runs[0]!;
  return { directory, store, engine, start, actions: workspaceActionStore(store) };
}
function reference(run: PipelineRun) { return { runId: run.id, eventId: run.jira[0]!.eventId }; }
function sent(action: PendingJiraAction): PendingJiraAction {
  return { ...action, status: "sent", attempts: action.attempts + 1,
    evidence: { issueKey: "ENG-1", url: "https://fixture.invalid/browse/ENG-1", at: new Date().toISOString() } };
}

test("concurrent Jira actions and pipeline writes preserve each other's state after restart", async t => {
  const f = fixture(t);
  const first = f.start(); const second = f.start();
  const waiting: { action: PendingJiraAction; resolve(value: PendingJiraAction): void }[] = [];
  const delivery: JiraDelivery = { mode: "live", siteOrigin: "https://fixture.invalid",
    send(action) { return new Promise(resolve => waiting.push({ action, resolve })); } };
  const context = { pipelines: f.engine, actions: f.actions, delivery };
  const one = deliver(context, owner, reference(first));
  const two = deliver(context, owner, reference(second));
  assert.equal(waiting.length, 2);
  const duplicate = await deliver(context, owner, reference(first));
  assert.equal(duplicate.dispatched, false); assert.equal(duplicate.action.status, "claimed");
  assert.equal(waiting.length, 2);
  f.engine.execute("one", "owner", ["admin"], { action: "pause", runId: first.id, expectedRevision: 1 }, 1);
  assert.deepEqual(f.actions.list("one").map(action => action.status), ["claimed", "claimed"]);
  waiting[1]!.resolve(sent(waiting[1]!.action)); await two;
  waiting[0]!.resolve(sent(waiting[0]!.action)); await one;
  assert.deepEqual(f.actions.list("one").map(action => action.status), ["sent", "sent"]);
  f.store.close();
  const reopened = fileWorkspaceStore(f.directory);
  try {
    const engine = filePipelines(reopened);
    assert.equal(engine.snapshot("one").runs.find(run => run.id === first.id)?.status, "paused");
    assert.equal("jiraActions" in engine.snapshot("one"), false);
    engine.execute("one", "owner", ["admin"], { action: "resume", runId: first.id, expectedRevision: 2 }, 1);
    assert.deepEqual(workspaceActionStore(reopened).list("one").map(action => action.status), ["sent", "sent"]);
  } finally { reopened.close(); }
});

test("preview stays pending with a stable action id and requires the reviewed destination hash", async t => {
  const f = fixture(t); const ref = reference(f.start());
  const runtime = createJiraRuntime(f.engine, f.store);
  const preview = await runtime.execute(owner, { action: "preview", ...ref });
  assert.ok("expectedIntentHash" in preview);
  assert.equal(f.actions.list("one").length, 0);
  await assert.rejects(runtime.execute(owner, { action: "deliver", ...ref, expectedIntentHash: "0".repeat(64) }), /Preview and review/);
  const command = { action: "deliver", ...ref, expectedIntentHash: preview.expectedIntentHash };
  const first = await runtime.execute(owner, command); const again = await runtime.execute(owner, command);
  assert.ok("action" in first && "action" in again);
  assert.equal(first.action.id, again.action.id); assert.equal(first.action.status, "pending");
  assert.equal(first.dispatched, false); assert.equal(f.actions.list("one").length, 1);
  const live = createJiraRuntime(f.engine, f.store, { mode: "live", siteOrigin: "https://fixture.invalid", async send() { assert.fail("No dispatch"); } });
  await assert.rejects(live.execute(owner, command), /destination changed/);
  await assert.rejects(runtime.execute({ ...owner, roles: ["author"] }, command), /admin/);
  await assert.rejects(runtime.execute(owner, { ...command, authorizedBy: "someone-else" }), /authorizedBy/);
  assert.throws(() => runtime.inspect("two", { runId: ref.runId }), /workspace/);
});

test("pending action payloads and stored hashes cannot be substituted on retry", async t => {
  const f = fixture(t);
  const run = f.engine.execute("one", "owner", ["admin"], {
    action: "start", requestId: randomUUID(), title: "Update an issue", brief: "Review these fields.", issueKey: "ENG-2",
  }, 1).runs[0]!;
  const context = { pipelines: f.engine, actions: f.actions, delivery: previewDelivery() };
  const request = { ...reference(run), operation: "update_fields" as const, fields: { summary: "Reviewed words" } };
  const { action } = await deliver(context, owner, request);
  await assert.rejects(deliver(context, owner, { ...request, fields: { summary: "Different words" } }), /different authorized intent/);
  assert.throws(() => f.actions.commit("one", [{ ...action, intent: { ...action.intent, summary: "Changed on disk" } }]), /changed intent/);
  assert.throws(() => f.actions.commit("one", [{ ...action, intent: { ...action.intent, extra: true } } as PendingJiraAction]), /extra/);
  assert.throws(() => f.actions.commit("one", [{ ...action, dedupeKey: "0".repeat(64) }]), /dedupe key/);
  assert.equal(f.actions.list("one")[0]!.intentHash, action.intentHash);
});

test("rate limits survive restart and an eligible retry clears the old wait", async t => {
  const f = fixture(t); const ref = reference(f.start());
  let time = Date.parse("2026-01-01T00:00:00Z"); let calls = 0;
  const delivery: JiraDelivery = { mode: "live", siteOrigin: "https://fixture.invalid", async send(action) {
    calls++;
    return calls === 1 ? { ...action, status: "failed", attempts: 1, retryAfterMs: 42_000 } : sent(action);
  } };
  const context = { pipelines: f.engine, actions: f.actions, delivery, now: () => new Date(time) };
  await deliver(context, owner, ref);
  f.store.close();
  const reopened = fileWorkspaceStore(f.directory);
  try {
    const next = { ...context, pipelines: filePipelines(reopened), actions: workspaceActionStore(reopened) };
    await assert.rejects(deliver(next, owner, ref), /wait until/);
    assert.equal(calls, 1);
    time += 42_000;
    const outcome = await deliver(next, owner, ref);
    assert.equal(outcome.action.status, "sent"); assert.equal(calls, 2);
    assert.equal(outcome.action.retryNotBefore, undefined); assert.equal(outcome.action.retryAfterMs, undefined);
  } finally { reopened.close(); }
});

test("transport exceptions are redacted, uncertain and never blindly retried", async t => {
  const f = fixture(t); const ref = reference(f.start()); let calls = 0;
  const delivery: JiraDelivery = { mode: "live", siteOrigin: "https://fixture.invalid", async send() {
    calls++; throw new Error("private-token-in-transport-error");
  } };
  const context = { pipelines: f.engine, actions: f.actions, delivery };
  const result = await deliver(context, owner, ref);
  assert.equal(result.action.status, "uncertain");
  await deliver(context, owner, ref); assert.equal(calls, 1);
  assert.equal(JSON.stringify(f.actions.list("one")).includes("private-token"), false);
});

test("shutdown waits for evidence and rejects new commands", async t => {
  const f = fixture(t); const ref = reference(f.start());
  let finish!: () => void;
  const runtime = createJiraRuntime(f.engine, f.store, { mode: "live", siteOrigin: "https://fixture.invalid",
    send(action) { return new Promise(resolve => { finish = () => resolve(sent(action)); }); } });
  const preview = await runtime.execute(owner, { action: "preview", ...ref });
  assert.ok("expectedIntentHash" in preview);
  const attempt = runtime.execute(owner, { action: "deliver", ...ref, expectedIntentHash: preview.expectedIntentHash });
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await assert.rejects(runtime.execute(owner, { action: "preview", ...ref }), /shutting down/);
  assert.equal(closed, false);
  finish(); await attempt; await closing;
  assert.equal(f.actions.list("one")[0]!.status, "sent");
});

test("REST transport exceptions also remain uncertain without persisting credentials", async t => {
  const f = fixture(t); const ref = reference(f.start()); let calls = 0;
  const delivery = restDelivery({ baseUrl: "https://fixture.invalid", email: "test@example.invalid", apiToken: "private-token" }, async () => {
    calls++; throw new Error("connection failed with private-token");
  });
  const context = { pipelines: f.engine, actions: f.actions, delivery };
  assert.equal((await deliver(context, owner, ref)).action.status, "uncertain");
  await deliver(context, owner, ref); assert.equal(calls, 1);
  assert.equal(JSON.stringify(f.actions.list("one")).includes("private-token"), false);
});
