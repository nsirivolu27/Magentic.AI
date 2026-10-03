import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Role } from "../registry/roles.js";
import { filePipelines, type PipelineEngine, type PipelineSnapshot } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import {
  correlationMarker, JiraError, previewDelivery, restDelivery,
  type JiraSite, type PendingJiraAction,
} from "../workbench/jira.js";
import {
  deliver, recoverInterrupted, resolveUncertain, workspaceActionStore,
  type CallerIdentity, type JiraActionContext,
} from "../workbench/jira-actions.js";

const WS = "magentic";
const ADMIN: CallerIdentity = { workspaceId: WS, actor: "s.patel", roles: ["admin"] as Role[] };
const AUTHOR: CallerIdentity = { workspaceId: WS, actor: "a.rivera", roles: ["author"] as Role[] };
const SITE: JiraSite = { baseUrl: "https://magenticai.atlassian.net", email: "a@b.test", apiToken: "super-secret" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "magentic-jira-"));
}

/** A real workspace with one run that has a Jira preview on it. */
function workspace(dir = scratch()) {
  const store = fileWorkspaceStore(dir);
  const pipelines = filePipelines(store);
  const snapshot = pipelines.execute(WS, "a.rivera", ["author"], {
    action: "start", requestId: "11111111-1111-4111-8111-111111111111",
    title: "Durable Jira actions", brief: "Wire the lifecycle end to end.",
  }, 1);
  const run = snapshot.runs[0]!;
  return { dir, store, pipelines, run, actions: workspaceActionStore(store) };
}

function context(parts: Partial<JiraActionContext> & { pipelines: PipelineEngine; actions: JiraActionContext["actions"] }): JiraActionContext {
  return { delivery: previewDelivery(), ...parts };
}

function request(run: { id: string; jira: { eventId: string }[] }) {
  return { runId: run.id, eventId: run.jira[0]!.eventId };
}

test("an author cannot authorize, and nothing is sent", async () => {
  const ws = workspace();
  let called = false;
  const delivery = restDelivery(SITE, async () => { called = true; return new Response("{}", { status: 200 }); });
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  await assert.rejects(() => deliver(ctx, AUTHOR, request(ws.run)),
    (error: unknown) => error instanceof JiraError && /cannot authorize/.test(error.message));
  assert.equal(called, false, "an unauthorized request must produce no outbound call");
  assert.deepEqual(ws.actions.list(WS), []);
  ws.store.close();
});

test("a request naming another workspace's run is refused with no outbound call", async () => {
  const ws = workspace();
  let called = false;
  const delivery = restDelivery(SITE, async () => { called = true; return new Response("{}", { status: 200 }); });
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  const stranger: CallerIdentity = { workspaceId: "other", actor: "s.patel", roles: ["admin"] as Role[] };
  await assert.rejects(() => deliver(ctx, stranger, request(ws.run)), (error: unknown) => error instanceof JiraError);
  assert.equal(called, false);
  ws.store.close();
});

test("an event that is not in the run is refused", async () => {
  const ws = workspace();
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions });
  await assert.rejects(
    () => deliver(ctx, ADMIN, { runId: ws.run.id, eventId: "99999999-9999-4999-8999-999999999999" }),
    (error: unknown) => error instanceof JiraError && /no Jira preview/.test(error.message));
  ws.store.close();
});

test("preview mode stores the action and sends nothing", async () => {
  const ws = workspace();
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions });
  const { action } = await deliver(ctx, ADMIN, request(ws.run));
  assert.equal(action.status, "pending");
  assert.equal(action.evidence, undefined);
  assert.match(action.lastError ?? "", /nothing was sent/i);
  assert.equal(ws.actions.list(WS).length, 1, "it is durable even though nothing was sent");
  ws.store.close();
});

test("a create records the returned key, and a repeat does not dispatch again", async () => {
  const ws = workspace();
  let calls = 0;
  const delivery = restDelivery(SITE, async () => { calls++; return new Response(JSON.stringify({ key: "KAN-42" }), { status: 201 }); });
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  const first = await deliver(ctx, ADMIN, request(ws.run));
  assert.equal(first.dispatched, true);
  assert.equal(first.action.status, "sent");
  assert.equal(first.action.evidence?.issueKey, "KAN-42");

  const second = await deliver(ctx, ADMIN, request(ws.run));
  assert.equal(second.dispatched, false, "a second request for the same event must not dispatch");
  assert.equal(calls, 1);
  ws.store.close();
});

test("concurrent requests for one event dispatch once", async () => {
  const ws = workspace();
  let calls = 0;
  const delivery = restDelivery(SITE, async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ key: "KAN-7" }), { status: 201 });
  });
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  const [a, b] = await Promise.all([deliver(ctx, ADMIN, request(ws.run)), deliver(ctx, ADMIN, request(ws.run))]);
  assert.equal(calls, 1, "the second caller must find the first one's claim");
  assert.equal([a.dispatched, b.dispatched].filter(Boolean).length, 1);
  ws.store.close();
});

test("a timeout becomes uncertain and is not retried blindly", async () => {
  const ws = workspace();
  let calls = 0;
  const delivery = restDelivery(SITE, async (_url, init) => {
    calls++;
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted"); error.name = "AbortError"; reject(error);
      });
    });
  }, 30);
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  const first = await deliver(ctx, ADMIN, request(ws.run));
  assert.equal(first.action.status, "uncertain");
  assert.equal(first.action.evidence, undefined, "an uncertain write has no evidence");

  const again = await deliver(ctx, ADMIN, request(ws.run));
  assert.equal(again.dispatched, false, "an uncertain action must be reconciled, not resent");
  assert.equal(calls, 1);
  ws.store.close();
});

test("reconciliation finds a write that landed, and one that did not", async () => {
  const ws = workspace();
  const uncertain = async (): Promise<PendingJiraAction> => {
    const delivery = restDelivery(SITE, async (_u, init) => await new Promise((_r, reject) => {
      init?.signal?.addEventListener("abort", () => { const e = new Error("x"); e.name = "AbortError"; reject(e); });
    }), 20);
    const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });
    return (await deliver(ctx, ADMIN, request(ws.run))).action;
  };

  const action = await uncertain();
  assert.equal(action.status, "uncertain");

  // The marker is present: the write landed.
  const found = context({
    pipelines: ws.pipelines, actions: ws.actions, site: SITE,
    fetchImpl: async (url) => {
      assert.match(String(url), new RegExp(encodeURIComponent(correlationMarker(action.id)).slice(0, 20)));
      return new Response(JSON.stringify({ issues: [{ key: "KAN-99" }] }), { status: 200 });
    },
  });
  const landed = await resolveUncertain(found, WS, action.id);
  assert.equal(landed.status, "sent");
  assert.equal(landed.evidence?.issueKey, "KAN-99");

  // And the other way round, on a fresh workspace.
  const other = workspace();
  const otherDelivery = restDelivery(SITE, async (_u, init) => await new Promise((_r, reject) => {
    init?.signal?.addEventListener("abort", () => { const e = new Error("x"); e.name = "AbortError"; reject(e); });
  }), 20);
  const pendingAction = (await deliver(
    context({ pipelines: other.pipelines, actions: other.actions, delivery: otherDelivery }), ADMIN, request(other.run),
  )).action;
  const missing = await resolveUncertain(context({
    pipelines: other.pipelines, actions: other.actions, site: SITE,
    fetchImpl: async () => new Response(JSON.stringify({ issues: [] }), { status: 200 }),
  }), WS, pendingAction.id);
  assert.equal(missing.status, "pending", "nothing landed, so it becomes retryable again");
  assert.equal(missing.evidence, undefined);
  ws.store.close(); other.store.close();
});

test("an interrupted attempt is recovered as uncertain after a restart", async () => {
  const dir = scratch();
  const first = workspace(dir);
  // A claim left behind is what a crash mid attempt looks like on disk.
  const ctx = context({ pipelines: first.pipelines, actions: first.actions });
  const { action } = await deliver(ctx, ADMIN, request(first.run));
  first.actions.commit(WS, [{ ...action, status: "claimed", claim: { attemptId: "22222222-2222-4222-8222-222222222222", at: new Date().toISOString() } }]);
  first.store.close();

  const store = fileWorkspaceStore(dir);
  const pipelines = filePipelines(store);
  const actions = workspaceActionStore(store);
  const recovered = await recoverInterrupted(context({ pipelines, actions }), WS);
  assert.equal(recovered[0]?.status, "uncertain");
  assert.equal(recovered[0]?.claim, undefined);
  assert.match(recovered[0]?.lastError ?? "", /interrupted/i);
  store.close();
});

test("a stored action survives a restart with its evidence and audit trail", async () => {
  const dir = scratch();
  const first = workspace(dir);
  const delivery = restDelivery(SITE, async () => new Response(JSON.stringify({ key: "KAN-5" }), { status: 201 }));
  const { action } = await deliver(context({ pipelines: first.pipelines, actions: first.actions, delivery }), ADMIN, request(first.run));
  first.store.close();

  const store = fileWorkspaceStore(dir);
  const reloaded = workspaceActionStore(store).list(WS);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.id, action.id);
  assert.equal(reloaded[0]?.status, "sent");
  assert.equal(reloaded[0]?.evidence?.issueKey, "KAN-5");
  assert.equal(reloaded[0]?.authorizedBy, "s.patel");
  assert.equal(reloaded[0]?.steps[0]?.name, "create_issue");
  store.close();
});

test("a rate limit records Retry-After and stays retryable", async () => {
  const ws = workspace();
  const delivery = restDelivery(SITE, async () => new Response("slow down", { status: 429, headers: { "retry-after": "42" } }));
  const { action } = await deliver(context({ pipelines: ws.pipelines, actions: ws.actions, delivery }), ADMIN, request(ws.run));
  assert.equal(action.status, "failed");
  assert.equal(action.retryAfterMs, 42_000);
  ws.store.close();
});

test("credentials never reach an error or the stored evidence", async () => {
  const ws = workspace();
  const delivery = restDelivery(SITE, async () => new Response("denied", { status: 403 }));
  const { action } = await deliver(context({ pipelines: ws.pipelines, actions: ws.actions, delivery }), ADMIN, request(ws.run));
  assert.equal(action.status, "failed");
  assert.match(action.lastError ?? "", /403/);
  const serialized = JSON.stringify(ws.actions.list(WS));
  assert.equal(serialized.includes(SITE.apiToken), false, "the token must not be persisted anywhere");
  assert.equal(serialized.includes("Basic "), false, "nor the authorization header");
  ws.store.close();
});

test("a caller-supplied authorization object is ignored", async () => {
  const ws = workspace();
  let calls = 0;
  const delivery = restDelivery(SITE, async () => { calls++; return new Response(JSON.stringify({ key: "KAN-1" }), { status: 201 }); });
  const ctx = context({ pipelines: ws.pipelines, actions: ws.actions, delivery });

  // Whatever else is on the request, only runId, eventId and operation are read.
  const forged = { ...request(ws.run), authorizedBy: "s.patel", intentHash: "0".repeat(64), status: "sent" } as never;
  await assert.rejects(() => deliver(ctx, AUTHOR, forged), (error: unknown) => error instanceof JiraError);
  assert.equal(calls, 0, "a forged authorization must not buy a dispatch");
  ws.store.close();
});
