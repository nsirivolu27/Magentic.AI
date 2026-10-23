import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createChatHistory } from "../workbench/chat-history.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { companyChatIdentity } from "../workbench/company-chat.js";
import { formatChatText } from "../workbench/chat-format.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";
import { runWorkspaceAgent, type ChatEvent } from "../workbench/chat.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";

const chat = { channel: "general", profile: "", selectedModel: "local", messages: [{ role: "user", content: "Draft a release note" }, { role: "assistant", content: "## Release\n- Tested", usage: { promptTokens: 20, completionTokens: 10 } }] };
const base = { provider: "ollama", model: "local", loadModel: async () => ({ invoke: async () => ({ content: '{"type":"answer","content":"Ready"}' }) }) };
const context = () => ({ store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "member", roles: ["author"] }]) });

test("saved chats are isolated by company and member and reject stale updates", () => {
  const vault = memoryChatVault(); const history = createChatHistory(vault);
  const saved = history.execute("one", "member", { action: "save", expectedRevision: 0, chat });
  assert.equal(createChatHistory(vault).list("one", "member")[0]?.id, saved.id);
  assert.deepEqual(history.list("two", "member"), []);
  assert.deepEqual(history.list("one", "other"), []);
  assert.throws(() => history.execute("two", "member", { action: "open", id: saved.id }), /not found/);
  assert.throws(() => history.execute("one", "other", { action: "save", id: saved.id, expectedRevision: 1, chat }), /not found/);
  assert.throws(() => history.execute("one", "member", { action: "save", id: saved.id, expectedRevision: 0, chat }), /another tab/);
  const updated = history.execute("one", "member", { action: "save", id: saved.id, expectedRevision: 1, chat });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.chat.messages[1]?.usage, { promptTokens: 20, completionTokens: 10 });
  updated.chat.messages[0]!.content = "Mutated";
  assert.equal(history.execute("one", "member", { action: "open", id: saved.id }).chat.messages[0]!.content, chat.messages[0]!.content);
});

test("saved chat contracts bound storage and refuse forged settings", () => {
  const history = createChatHistory(memoryChatVault());
  const save = (value: unknown) => history.execute("one", "member", { action: "save", expectedRevision: 0, chat: value });
  assert.throws(() => save({ ...chat, apiKey: "secret" }));
  assert.throws(() => save({ ...chat, messages: Array.from({ length: 10 }, () => ({ role: "user", content: "x".repeat(12000) })) }));
  for (let i = 0; i < 30; i++) save(chat);
  assert.throws(() => save(chat), /30 saved chats/);
});

test("company chat credentials cannot authenticate other endpoints or select another company", async () => {
  const access = createChatAccess({ base, vault: memoryChatVault(), managedLogin: true, entitled: async () => false });
  const { token } = access.issueToken("one", "member");
  const auth = companyChatIdentity(access, async () => ({ workspaceId: "one", actor: "session" }));
  const req = (url: string, selected?: string) => ({ url, headers: { authorization: `Bearer ${token}`, ...(selected ? { "x-magentic-workspace": selected } : {}) } }) as IncomingMessage;
  assert.deepEqual(await auth(req("/api/chat-mcp")), { workspaceId: "one", actor: "member" });
  for (const path of ["/api/pipeline", "/api/chat/history", "/api/base-chat", "/api/workspace"]) assert.equal(await auth(req(path)), undefined);
  assert.equal(await auth(req("/api/chat-mcp", "two")), undefined);
  access.revokeToken("one", "member");
  assert.equal(await auth(req("/api/chat-mcp")), undefined);
});

test("company history HTTP endpoints check membership and never accept a client tenant", async t => {
  let member = true;
  const ctx = context(); ctx.members = { rolesFor: async () => member ? ["author"] : [] };
  const access = createChatAccess({ base, vault: memoryChatVault(), managedLogin: true, entitled: async () => false });
  const server = createWorkbenchServer({ context: ctx, assets: new Map(), chat: base, chatAccess: access,
    authenticate: async req => req.headers.authorization === "session" ? { workspaceId: "one", actor: "member" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/chat/history`;
  const request = (data: unknown) => fetch(url, { method: "POST", headers: { Authorization: "session", "Content-Type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await request({ action: "save", expectedRevision: 0, chat, workspace: "two" })).status, 400);
  assert.equal((await request({ action: "save", expectedRevision: 0, chat })).status, 200);
  const records = await (await fetch(url, { headers: { Authorization: "session" } })).json();
  assert.equal(records.length, 1); assert.equal(records[0].chat, undefined);
  member = false;
  assert.equal((await request({ action: "open", id: records[0].id })).status, 403);
});

test("workspace chat reads the real pipeline through MCP without gaining a write tool", async () => {
  const pipelines = memoryPipelines(); const events: ChatEvent[] = []; let calls = 0;
  await runWorkspaceAgent(context(), "one", "member", [{ role: "user", content: "Summarize our workflow" }], { invoke: async prompt => {
    assert.doesNotMatch(prompt, /"name":"start_pipeline_run"/);
    if (++calls === 1) { assert.match(prompt, /"name":"get_pipeline"/); return { content: '{"type":"tool","name":"get_pipeline","arguments":{}}' }; }
    assert.match(prompt, /Intake/);
    return { content: '{"type":"answer","content":"The workflow begins with Intake."}', usage: { promptTokens: 20, completionTokens: 10 } };
  } }, new AbortController().signal, event => events.push(event), undefined, undefined, { pipelines });
  assert.ok(events.some(event => event.type === "tool" && event.name === "get_pipeline" && event.state === "done"));
  assert.equal(events.at(-1)?.type, "answer");
  await assert.rejects(runWorkspaceAgent(context(), "one", "member", [{ role: "user", content: "Start a run" }], {
    invoke: async () => ({ content: '{"type":"tool","name":"start_pipeline_run","arguments":{}}' }),
  }, new AbortController().signal, () => {}, undefined, undefined, { pipelines }), /unavailable/);
  assert.equal(pipelines.snapshot("one").runs.length, 0);
});

test("chat formatting renders code and lists while keeping HTML and links inert", () => {
  const html = formatChatText('## Plan\n- **Review**\n- `<img>`\n```js\nconst unsafe = "<script>";\n```\n[click](javascript:alert(1))');
  assert.match(html, /<h3>Plan<\/h3>/); assert.match(html, /<ul><li><strong>Review/);
  assert.match(html, /<pre><code>const unsafe/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|<a /);
  const state = emptyChat(); state.messages = [{ role: "assistant", content: "```ts\nlet x = 1;\n```" }];
  assert.match(chatView({ configured: true, model: "local" }, state, [], { base: true }), /Copy answer/);
});

test("workflow questions receive authoritative MCP evidence before a model can guess", async () => {
  const events: ChatEvent[] = [];
  await runWorkspaceAgent(context(), "one", "member", [{ role: "user", content: "What is our first workflow stage?" }], {
    invoke: async prompt => {
      assert.ok(events.some(event => event.type === "tool" && event.name === "get_pipeline" && event.state === "done"));
      assert.match(prompt.slice(prompt.indexOf("OBSERVATIONS")), /Intake/);
      return { content: '{"type":"answer","content":"Intake is the first stage."}' };
    },
  }, new AbortController().signal, event => events.push(event), undefined, undefined, { pipelines: memoryPipelines() });
  assert.equal(events.at(-1)?.type, "answer");
  let invoked = false;
  await assert.rejects(runWorkspaceAgent(context(), "other", "member", [{ role: "user", content: "Read the pipeline" }], {
    invoke: async () => { invoked = true; return { content: "" }; },
  }, new AbortController().signal, () => {}, undefined, undefined, { pipelines: memoryPipelines() }), /membership/);
  assert.equal(invoked, false);
});
