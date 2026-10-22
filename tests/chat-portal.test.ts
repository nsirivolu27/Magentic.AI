import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { chatRequestSchema, type ChatConfiguration } from "../workbench/chat.js";
import { contextMessages, chatLoginDestination } from "../workbench/chat-settings.js";
import { chatView, emptyChat, resetChat } from "../workbench/chat-view.js";
import { loginPage } from "../workbench/account-portal.js";
import { withCloudModels } from "../workbench/model-catalog.js";

const question = { role: "user", content: "Explain the workflow." };

test("chat controls reject invalid caps, history choices and unknown fields", () => {
  for (const maxOutputTokens of [0, 127, 8193, 512.5, "512"]) {
    const result = chatRequestSchema.safeParse({ messages: [question], maxOutputTokens });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues[0]?.path[0], "maxOutputTokens");
  }
  assert.equal(chatRequestSchema.safeParse({ messages: [question], history: "unlimited" }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [question], admin: true }).success, false);
  assert.equal(chatRequestSchema.parse({ messages: [question], maxOutputTokens: 1024, history: "recent" }).maxOutputTokens, 1024);
  assert.equal(chatRequestSchema.parse({ messages: [question] }).maxOutputTokens, undefined);
});

test("recent history keeps three exchanges and the current question without changing the transcript", () => {
  const messages = Array.from({ length: 11 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index) }));
  assert.deepEqual(contextMessages(messages, "recent").map(message => message.content), ["4", "5", "6", "7", "8", "9", "10"]);
  assert.deepEqual(contextMessages(messages, "current"), [messages.at(-1)]);
  assert.deepEqual(contextMessages(messages, "all"), messages);
  assert.equal(messages.length, 11);
});

test("changing chat destination drops messages, tool results and drafts but retains usage preferences", () => {
  const state = emptyChat();
  state.messages.push({ role: "user", content: "Private workspace question" });
  state.tools.push({ name: "get_workspace_policy", state: "done" });
  state.draft = "Unsent context"; state.history = "current"; state.maxOutputTokens = 1024; state.busy = true;
  const reset = resetChat(state);
  assert.deepEqual(reset.messages, []); assert.deepEqual(reset.tools, []);
  assert.equal(reset.draft, ""); assert.equal(reset.busy, false);
  assert.equal(reset.history, "current"); assert.equal(reset.maxOutputTokens, 1024);
});

test("chat sign-in only accepts the named local destination", () => {
  assert.equal(chatLoginDestination("chat"), "/#/base-chat");
  for (const next of [undefined, "https://example.com", "//example.com", "javascript:alert(1)", "chat#evil"]) {
    assert.equal(chatLoginDestination(next), "/");
    assert.doesNotMatch(loginPage(undefined, next), /href="https:\/\/example.com|href="javascript:/);
  }
  const page = loginPage(undefined, "chat");
  assert.match(page, /Chat with Magentic/); assert.match(page, /href="\/#\/base-chat"/);
  assert.match(page, /Online sign-in is not configured/);
});

test("chat shows usage only when reported and labels the output cap per call", () => {
  const state = emptyChat();
  state.messages.push({ role: "assistant", content: "First answer", usage: { promptTokens: 200, completionTokens: 80 }, elapsedMs: 1200 });
  state.messages.push({ role: "assistant", content: "Second answer" });
  const html = chatView({ configured: true, model: "local" }, state, [], { base: true });
  assert.match(html, /200 input · 80 output tokens \(reported\)/);
  assert.match(html, /1.2s/); assert.match(html, /Token usage not reported/);
  assert.match(html, /Output cap per call/); assert.match(html, /Input tokens are additional/);
  assert.match(html, /One model call per message/);
  assert.match(chatView({ configured: true }, state), /up to four model calls/);
});

async function fixture(t: TestContext, outputLimit = true, waitFor?: Promise<void>) {
  let entered!: () => void;
  const invoked = new Promise<void>(resolve => { entered = resolve; });
  const prompts: string[] = [];
  const limits: (number | undefined)[] = [];
  const chat: ChatConfiguration = { provider: "test", model: "local", outputLimit,
    loadModel: async (_, options) => {
      limits.push(options?.maxOutputTokens);
      return { invoke: async prompt => { prompts.push(prompt); entered(); await waitFor; return { content: JSON.stringify({ type: "answer", content: "Answer" }), usage: { promptTokens: 70, completionTokens: 20 } }; } };
    } };
  const server = createWorkbenchServer({ assets: new Map(), chat,
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "member", roles: ["author"] }]) },
    authenticate: async req => req.headers.authorization ? { workspaceId: "one", actor: req.headers.authorization } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, body: unknown, actor = "member") => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(actor ? { Authorization: actor } : {}) }, body: JSON.stringify(body) });
  return { request, prompts, limits, base, invoked };
}

test("general chat applies history and output controls server-side and reports elapsed time", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/base-chat", { model: "local", metrics: true, history: "current", maxOutputTokens: 1024,
    messages: [{ role: "user", content: "DO_NOT_SEND_OLD_CONTEXT" }, { role: "assistant", content: "Older answer" }, question] });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(f.limits, [1024]); assert.equal(f.prompts.length, 1);
  assert.doesNotMatch(f.prompts[0]!, /DO_NOT_SEND_OLD_CONTEXT|AVAILABLE TOOLS/);
  const answer = events.find(event => event.type === "answer");
  assert.deepEqual(answer.usage, { promptTokens: 70, completionTokens: 20 });
  assert.ok(Number.isFinite(answer.elapsedMs) && answer.elapsedMs >= 0);
});

test("workspace chat accepts the same output cap and includes read-only MCP tool schemas", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/chat", { messages: [question], maxOutputTokens: 512 });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.limits, [512]); assert.match(f.prompts[0]!, /AVAILABLE TOOLS/);
  assert.match(f.prompts[0]!, /get_workspace_policy/);
});

test("both chat endpoints refuse unsigned users, nonmembers and invalid controls before loading a model", async t => {
  const f = await fixture(t);
  for (const path of ["/api/chat", "/api/base-chat"]) {
    for (const [actor, status] of [["", 401], ["outsider", 403]] as const) assert.equal((await f.request(path, { messages: [question] }, actor)).status, status);
    assert.equal((await f.request(path, { messages: [question], maxOutputTokens: 0 })).status, 400);
  }
  assert.equal((await f.request("/api/base-chat", { messages: [question], profile: "00000000-0000-4000-8000-000000000000" })).status, 400);
  assert.equal(f.limits.length, 0);
});

test("an unsupported cap is refused instead of silently ignored; omitted cap remains compatible", async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request("/api/base-chat", { messages: [question], maxOutputTokens: 512 })).status, 400);
  assert.equal(f.limits.length, 0);
  const response = await f.request("/api/base-chat", { messages: [question] });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.limits, [undefined]);
});

test("catalog forwards an output cap to local loaders and keeps omitted defaults intact", async () => {
  const limits: (number | undefined)[] = [];
  const config = withCloudModels({ provider: "ollama", model: "local", outputLimit: true,
    loadModel: async (_, options) => { limits.push(options?.maxOutputTokens); return { invoke: async () => ({ content: "Answer" }) }; } }, {});
  assert.equal((await config.modelOptions!())[0]?.outputLimit, true);
  await config.loadModel("local", { maxOutputTokens: 2048 }); await config.loadModel("local");
  assert.deepEqual(limits, [2048, undefined]);
});

test("each cloud adapter places the output cap in its provider request", async () => {
  const base: ChatConfiguration = { provider: "test", model: "local", loadModel: async () => ({ invoke: async () => ({ content: "Answer" }) }) };
  const bodies: Record<string, unknown>[] = [];
  const config = withCloudModels(base, { OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture", GEMINI_API_KEY: "fixture", AZURE_OPENAI_API_KEY: "fixture", AZURE_OPENAI_INSTANCE: "fixture", AZURE_OPENAI_DEPLOYMENTS: "fixture", MAGENTIC_GATEWAY_BASE_URL: "http://127.0.0.1:9999", MAGENTIC_GATEWAY_MODELS: "fixture" }, async (_, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }], content: [{ type: "text", text: "Answer" }], choices: [{ message: { content: "Answer" } }] });
  });
  for (const option of (await config.modelOptions!()).filter(option => option.outputLimit)) {
    const model = await config.loadModel(option.id, { maxOutputTokens: 1024 }); await model.invoke("Question");
    const body = bodies.at(-1)!;
    assert.equal(body.max_output_tokens ?? body.max_tokens, 1024);
  }
  assert.ok(bodies.length >= 5);
});


test("opt-in chat streams progress while inference is pending", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  t.after(() => complete());
  const f = await fixture(t, true, pending);
  const response = await f.request("/api/base-chat", { messages: [question], metrics: true });
  await f.invoked;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  t.mock.timers.tick(15_000);
  const progress = await reader.read();
  assert.match(decoder.decode(progress.value), /Still working/);
  complete();
  let answer = "";
  while (true) { const chunk = await reader.read(); if (chunk.done) break; answer += decoder.decode(chunk.value); }
  assert.match(answer, /"type":"answer"/);
});
