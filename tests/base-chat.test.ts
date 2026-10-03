import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryAudit } from "../registry/audit.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { runBaseChat, type ChatEvent } from "../workbench/chat.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";

test("base chat answers once without workspace tools or profile instructions", async () => {
  const events: ChatEvent[] = [];
  let calls = 0;
  await runBaseChat([{ role: "user", content: "Help me plan a presentation." }], { async invoke(prompt) {
    calls++;
    assert.match(prompt, /Help me plan a presentation/);
    assert.doesNotMatch(prompt, /AVAILABLE TOOLS|OBSERVATIONS|ASSISTANT PROFILE|list_approved_agents/);
    return { content: '{"type":"answer","content":"Start with your audience and the decision you need."}' };
  } }, new AbortController().signal, (event) => events.push(event));
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, "answer");
  assert.equal(events.some((event) => event.type === "tool"), false);
});

test("base chat rejects tool requests and oversized replies", async () => {
  for (const content of ['{"type":"tool","name":"get_workspace_policy","arguments":{}}', "x".repeat(16001)]) {
    const events: ChatEvent[] = [];
    await assert.rejects(runBaseChat([{ role: "user", content: "Hello" }], { async invoke() { return { content }; } }, new AbortController().signal, (event) => events.push(event)));
    assert.equal(events.some((event) => event.type === "answer" || event.type === "tool"), false);
  }
});

test("base chat stops even when the model ignores cancellation", async () => {
  const controller = new AbortController();
  const pending = runBaseChat([{ role: "user", content: "Hello" }], { async invoke() { return new Promise(() => {}); } }, controller.signal, () => {});
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

test("base chat endpoint shares authentication, model validation and request limits", async (t) => {
  let calls = 0;
  const server = createWorkbenchServer({
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "team", actor: "writer", roles: ["author"] }]) },
    assets: new Map(), authenticate: async (request) => request.headers.authorization ? { workspaceId: "team", actor: request.headers.authorization.replace(/^Bearer /, "") } : undefined,
    chat: { provider: "test", model: "base-model", loadModel: async () => ({ async invoke() { calls++; return { content: '{"type":"answer","content":"Hello from the base model."}' }; } }) },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (data: unknown, actor = "writer") => fetch(`http://127.0.0.1:${address.port}/api/base-chat`, { method: "POST", headers: { "Content-Type": "application/json", ...(actor ? { Authorization: `Bearer ${actor}` } : {}) }, body: JSON.stringify(data) });
  const messages = [{ role: "user", content: "Hello" }];
  assert.equal((await request({ messages }, "")).status, 401);
  assert.equal((await request({ messages }, "outsider")).status, 403);
  assert.equal((await request({ messages, model: "unknown" })).status, 400);
  assert.equal((await request({ messages, profile: "11111111-1111-4111-8111-111111111111" })).status, 400);
  assert.equal((await request({ messages, tools: ["get_workspace_policy"] })).status, 400);
  assert.equal((await request({ messages: Array.from({ length: 21 }, () => messages[0]) })).status, 400);
  assert.equal(calls, 0);
  const response = await request({ messages, model: "base-model" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /x-ndjson/);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as ChatEvent);
  assert.deepEqual(events.at(-1), { type: "answer", content: "Hello from the base model." });
  assert.equal(calls, 1);
});

test("base chat view has general prompts, model selection and escaped replies", () => {
  const state = emptyChat();
  const config = { configured: true, provider: "ollama", model: "local-model" };
  const body = chatView(config, state, [], { locked: true, base: true });
  assert.match(body, /What can I help with/);
  assert.match(body, /Draft an update/);
  assert.match(body, /id="chat-model"/);
  assert.match(body, /No workspace tools/);
  assert.doesNotMatch(body, /List approved agents|id="chat-profile"/);
  state.messages = [{ role: "assistant", content: "<script>alert(1)</script>" }];
  assert.match(chatView(config, state, [], { base: true }), /&lt;script&gt;/);
  assert.doesNotMatch(chatView(config, state, [], { base: true }), /<script>/);
});
