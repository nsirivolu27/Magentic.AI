import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createSlack, slackConfigSchema, slackCommandSchema, type SlackPreview, type SlackReceipt } from "../workbench/slack.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { Role } from "../registry/roles.js";

const config = { connections: [{ workspaceId: "one", channel: "#company-audit", webhookSetting: "MAGENTIC_SLACK_WEBHOOK_ONE" }] };
function fixture() {
  const rows = new Map<string, SlackReceipt[]>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let time = Date.parse("2026-10-22T12:00:00Z");
  let destination = "https://hooks.slack.com/services/TTEST/BTEST/testvalue";
  let failWrite = false;
  let respond: () => Promise<Response> = async () => new Response("ok");
  const store = {
    read: (workspace: string) => structuredClone(rows.get(workspace) ?? []),
    write: (workspace: string, values: SlackReceipt[]) => {
      if (failWrite) throw new Error("storage unavailable");
      rows.set(workspace, structuredClone(values));
    },
  };
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return respond(); };
  const runtime = () => createSlack(config, store, () => destination, fetcher, () => time);
  const slack = runtime();
  const preview = () => slack.preview("one", "admin", "message", "Release review is ready.", "");
  return { slack, runtime, store, calls, preview, setDestination: (value: string) => { destination = value; },
    advance: () => { time += 300_001; }, failStorage: () => { failWrite = true; },
    response: (value: () => Promise<Response>) => { respond = value; } };
}

test("Slack rejects unknown configuration, duplicate workspaces and caller-selected destinations", () => {
  assert.equal(slackConfigSchema.safeParse({ ...config, unknown: true }).success, false);
  const duplicate = slackConfigSchema.safeParse({ connections: [...config.connections, ...config.connections] });
  assert.equal(duplicate.success, false);
  if (!duplicate.success) assert.deepEqual(duplicate.error.issues[0]!.path, ["connections", 1, "workspaceId"]);
  assert.equal(slackCommandSchema.safeParse({ action: "preview", kind: "message", note: "Ready", workspaceId: "two" }).success, false);
  assert.equal(slackCommandSchema.safeParse({ action: "send", url: "https://example.com" }).success, false);
});

test("Slack previews never contact Slack or expose its credential in workspace summaries", () => {
  const f = fixture(), preview = f.preview();
  assert.equal(f.calls.length, 0);
  assert.equal(preview.channel, "#company-audit");
  assert.doesNotMatch(JSON.stringify(f.slack.summary("one", true)), /hooks\.slack|testvalue|Release review/);
  assert.deepEqual(f.slack.summary("two", true), { configured: false, ready: false, canSend: false, receipts: [] });
  for (const url of ["http://hooks.slack.com/services/A/B/C", "https://example.com/services/A/B/C", "https://hooks.slack.com.evil.test/services/A/B/C"]) {
    f.setDestination(url); assert.equal(f.slack.summary("one", true).ready, false); assert.throws(f.preview, /valid Slack/);
  }
  f.setDestination("https://hooks.slack-gov.com/services/A/B/C");
  assert.equal(f.slack.summary("one", true).ready, true);
});

test("Slack send is bound to workspace, actor, exact content, expiry and configured destination", async () => {
  const f = fixture(), p = f.preview();
  for (const [workspace, actor, hash] of [["two", "admin", p.hash], ["one", "other", p.hash], ["one", "admin", "a".repeat(64)]]) {
    await assert.rejects(f.slack.send(workspace!, actor!, p.id, hash!), /expired or changed/);
  }
  f.setDestination("https://hooks.slack.com/services/A/B/changed");
  await assert.rejects(f.slack.send("one", "admin", p.id, p.hash), /destination changed/);
  f.advance();
  await assert.rejects(f.slack.send("one", "admin", p.id, p.hash), /expired or changed/);
  assert.equal(f.calls.length, 0);
});

test("Slack accepts a confirmed preview once and keeps receipts without message content", async () => {
  const f = fixture();
  const p = f.slack.preview("one", "admin", "message", "Review <@U123> & <!channel> safely.", "");
  const first = await f.slack.send("one", "admin", p.id, p.hash);
  assert.equal(first.state, "sent");
  assert.deepEqual(await f.slack.send("one", "admin", p.id, p.hash), first);
  assert.deepEqual(await f.runtime().send("one", "admin", p.id, p.hash), first);
  assert.equal(f.calls.length, 1);
  const payload = JSON.parse(String(f.calls[0]!.init!.body));
  assert.equal(payload.blocks[0].text.type, "plain_text");
  assert.equal(payload.blocks[0].text.text, p.text);
  assert.match(payload.text, /&lt;!channel&gt;/);
  assert.equal(payload.mrkdwn, false);
  assert.equal(f.calls[0]!.init!.redirect, "error");
  assert.doesNotMatch(JSON.stringify(f.store.read("one")), /safely|hooks\.slack|testvalue/);
  await assert.rejects(f.slack.send("one", "other", p.id, p.hash), /another request/);
});

test("Slack uncertain delivery is durable and never automatically retried", async () => {
  for (const response of [async () => { throw new Error("network timed out"); },
    async () => new Response("invalid_payload", { status: 400 }), async () => new Response("unexpected", { status: 200 })]) {
    const f = fixture(); f.response(response);
    const p = f.preview(), result = await f.slack.send("one", "admin", p.id, p.hash);
    assert.equal(result.state, "unknown");
    assert.equal((await f.runtime().send("one", "admin", p.id, p.hash)).state, "unknown");
    assert.equal(f.calls.length, 1);
  }
});

test("Slack refuses network delivery when the pending receipt cannot be persisted", async () => {
  const f = fixture(), p = f.preview(); f.failStorage();
  await assert.rejects(f.slack.send("one", "admin", p.id, p.hash), /storage unavailable/);
  assert.equal(f.calls.length, 0);
});

test("Slack refuses known credentials and excessive content before creating a preview", () => {
  const f = fixture();
  for (const note of ["api_key=" + "x".repeat(40), "https://hooks.slack.com/services/A/B/C", "x".repeat(3000)]) {
    assert.throws(() => f.slack.preview("one", "admin", "message", note, ""), /credentials or shorten/);
  }
  assert.throws(() => f.slack.preview("one", "admin", "message", " ", ""), /Write a team update/);
  assert.equal(f.calls.length, 0);
});

test("Slack concurrent requests for one preview produce one outbound request", async () => {
  const f = fixture(), p = f.preview();
  let finish!: (response: Response) => void;
  f.response(() => new Promise(resolve => { finish = resolve; }));
  const first = f.slack.send("one", "admin", p.id, p.hash);
  const second = await f.slack.send("one", "admin", p.id, p.hash);
  assert.equal(second.state, "unknown");
  finish(new Response("ok"));
  assert.equal((await first).state, "sent");
  assert.equal(f.calls.length, 1);
});

test("Slack API requires current membership, admin role and a human company-session capability", async t => {
  const f = fixture();
  let revoked = false;
  const server = createWorkbenchServer({
    assets: new Map(), slack: f.slack,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW,
      members: { async rolesFor(_workspace, actor): Promise<readonly Role[]> {
        if (actor === "removed" || (revoked && actor === "admin")) return [];
        return actor === "reader" ? ["author"] : ["admin"];
      } } },
    authenticate: async request => {
      const actor = request.headers.authorization?.replace("Bearer ", "");
      return actor ? { actor, workspaceId: actor === "foreign" ? "two" : "one",
        canSendSlack: actor !== "agent", canRunAutomations: true } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const post = (actor: string, input: unknown, origin?: string) => fetch(url + "/api/slack", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + actor, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(input) });
  const command = { action: "preview", kind: "audit", note: "" };
  assert.equal((await fetch(url + "/api/slack")).status, 401);
  for (const actor of ["reader", "agent", "removed"]) assert.equal((await post(actor, command)).status, 403);
  assert.equal((await post("admin", command, "https://foreign.example")).status, 403);
  assert.equal((await post("admin", { ...command, workspaceId: "two" })).status, 400);
  const response = await post("admin", command); assert.equal(response.status, 200);
  const p = await response.json() as SlackPreview;
  assert.match(p.text, /Workspace: one/); assert.match(p.text, /does not approve or execute/);
  assert.equal(f.calls.length, 0);
  const send = { action: "send", previewId: p.id, expectedHash: p.hash };
  assert.equal((await post("foreign", send)).status, 409);
  revoked = true; assert.equal((await post("admin", send)).status, 403);
  revoked = false; assert.equal((await post("admin", send)).status, 200);
  assert.equal(f.calls.length, 1);
  const snapshot = await (await fetch(url + "/api/workspace", { headers: { Authorization: "Bearer agent" } })).json() as { slack: { canSend: boolean } };
  assert.equal(snapshot.slack.canSend, false);
});
