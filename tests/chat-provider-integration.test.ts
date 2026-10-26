import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chatConfiguration } from "../workbench/chat-config.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { createChatMcpServer } from "../workbench/chat-mcp.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";

async function listen(server: Server, t: TestContext) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("API-only workbench startup selects a configured API without requiring Ollama or optional adapters", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const config = chatConfiguration(false, { env: { OPENAI_API_KEY: "test-only-placeholder", MAGENTIC_OPENAI_MODELS: "account-text-model" },
    request: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      assert.equal(init?.redirect, "error");
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"type":"answer","content":"Fixture"}' }] }],
        usage: { input_tokens: 7, output_tokens: 4 } });
    } });
  assert.ok(config);
  assert.equal(config.model, "openai/account-text-model");
  assert.equal(config.provider, "openai");
  const choices = await config.modelOptions!();
  assert.ok(!choices.some(choice => choice.local));
  assert.doesNotMatch(JSON.stringify(choices), /test-only-placeholder/);
  const model = await config.loadModel(undefined, { maxOutputTokens: 256 });
  const answer = await model.invoke("JSON answer please");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0]!.body.max_output_tokens, 256);
  assert.equal(calls[0]!.body.model, "account-text-model");
  assert.deepEqual(answer.usage, { promptTokens: 7, completionTokens: 4 });
  assert.equal(chatConfiguration(false, { env: {} }), undefined);
});

test("an explicitly configured API model keeps its identity and missing credentials are not called connected", async () => {
  const env = { MAGENTIC_LLM_PROVIDER: "openai", MAGENTIC_LLM_CHAT_MODEL: "chosen-model", MAGENTIC_OPENAI_MODELS: "other-model" };
  const disconnected = chatConfiguration(false, { env })!;
  assert.equal(disconnected.model, "openai/chosen-model");
  assert.equal((await disconnected.modelOptions!()).find(model => model.id === disconnected.model)?.available, false);
  await assert.rejects(disconnected.loadModel(), /OPENAI_API_KEY/);
  let selected = "";
  const connected = chatConfiguration(false, { env: { ...env, OPENAI_API_KEY: "test-only-placeholder" },
    request: async (_, init) => {
      selected = JSON.parse(String(init?.body)).model;
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
    } })!;
  await (await connected.loadModel()).invoke("JSON");
  assert.equal(selected, "chosen-model");
  await assert.rejects(connected.loadModel("openai/not-declared"), /not available/);
});

test("a configured compatible base URL cannot fall back to the public OpenAI endpoint", async () => {
  const urls: string[] = [];
  const config = chatConfiguration(false, { env: { MAGENTIC_LLM_PROVIDER: "openai", MAGENTIC_LLM_CHAT_MODEL: "private-model",
    MAGENTIC_LLM_BASE_URL: "https://router.example/v1", OPENAI_API_KEY: "test-only-placeholder" },
    request: async url => { urls.push(String(url)); return Response.json({ choices: [{ message: { content: "ok" } }] }); } })!;
  assert.equal(config.model, "gateway/private-model");
  await (await config.loadModel()).invoke("JSON");
  assert.deepEqual(urls, ["https://router.example/v1/chat/completions"]);
});

test("native Ollama protocol reaches general chat, workspace MCP chat and external Chat MCP", { timeout: 20_000 }, async t => {
  const requests: Record<string, unknown>[] = [];
  const ollama = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "installed-fixture" }, { name: "installed-fixture" }] })); return;
    }
    assert.equal(request.url, "/api/chat");
    assert.equal(request.headers["content-type"], "application/json");
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.end(JSON.stringify({ done: true, message: { content: '{"type":"answer","content":"Protocol fixture answer."}' },
      prompt_eval_count: 12, eval_count: 6 }));
  });
  const origin = await listen(ollama, t);
  const chat = chatConfiguration(false, { env: { MAGENTIC_LLM_PROVIDER: "ollama",
    MAGENTIC_LLM_BASE_URL: origin, MAGENTIC_LLM_CHAT_MODEL: "installed-fixture" } })!;
  assert.deepEqual(await chat.listModels!(), ["installed-fixture"]);
  await assert.rejects(chat.loadModel("not-installed"), /no longer available/);
  const access = createChatAccess({ base: chat, vault: memoryChatVault(), managedLogin: false, entitled: async () => false });
  const token = access.issueToken("workspace", "operator");
  const workbench = createWorkbenchServer({ assets: new Map(), chat, chatAccess: access,
    context: { store: memoryStore(), audit: memoryAudit(),
      members: memoryMembers([{ workspaceId: "workspace", actor: "operator", roles: ["author", "admin"] }]) },
    authenticate: async request => access.authenticateToken(request.headers.authorization?.replace(/^Bearer /, "") ?? ""),
  });
  const base = await listen(workbench, t);
  for (const path of ["/api/base-chat", "/api/chat"]) {
    const response = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "installed-fixture", maxOutputTokens: 256, messages: [{ role: "user", content: "Say hello." }] }) });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    const answer = events.find(event => event.type === "answer");
    assert.equal(answer?.content, "Protocol fixture answer.");
    assert.deepEqual(answer.usage, { promptTokens: 12, completionTokens: 6 });
  }
  const client = new Client({ name: "provider-integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/api/chat-mcp"),
    { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }) as never);
  t.after(() => client.close());
  const models = await client.callTool({ name: "list_chat_models", arguments: {} });
  assert.match(JSON.stringify(models), /installed-fixture/);
  const answer = await client.callTool({ name: "chat", arguments: { model: "installed-fixture", maxOutputTokens: 256,
    messages: [{ role: "user", content: "Say hello." }] } });
  assert.ok(!answer.isError);
  assert.match(JSON.stringify(answer), /Protocol fixture answer/);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.model, "installed-fixture");
    assert.equal(request.stream, false);
    assert.equal(request.format, "json");
    assert.equal((request.options as Record<string, unknown>).num_predict, 256);
  }
  access.revokeToken("workspace", "operator");
  const denied = await fetch(base + "/api/chat/models", { headers: { Authorization: `Bearer ${token.token}` } });
  assert.equal(denied.status, 401);
});

test("MCP cancellation reaches the provider and releases its active request slot", { timeout: 10_000 }, async t => {
  let received!: () => void; const started = new Promise<void>(resolve => { received = resolve; });
  let stopped!: () => void; const aborted = new Promise<void>(resolve => { stopped = resolve; });
  const access = createChatAccess({ vault: memoryChatVault(), managedLogin: false, entitled: async () => false,
    base: { provider: "fixture", model: "fixture", loadModel: async () => ({
      invoke: async (_, options) => {
        received();
        return new Promise((_, reject) => options!.signal.addEventListener("abort", () => {
          stopped(); reject(new Error("Cancelled"));
        }, { once: true }));
      },
    }) } });
  const server = createChatMcpServer(access, "workspace", "operator", async () => true);
  const client = new Client({ name: "cancellation-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left as never); await client.connect(right as never);
  t.after(async () => { await client.close(); await server.close(); });
  const controller = new AbortController();
  const pending = client.callTool({ name: "chat", arguments: { messages: [{ role: "user", content: "Wait." }] } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await Promise.all([rejected, aborted]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const release = access.acquire("workspace", "operator"); release();
});

test("Connections distinguishes installed Ollama, offline services and personal credentials", () => {
  const summary = { tier: "free" as const, auto: false, managedReady: false, connections: [], accountedTokens: 0, budgetDate: "today", mcp: { active: false } };
  const html = chatConnectionsPage(summary, undefined, undefined, { loading: false, models: [
    { id: "fixture", label: "<local-model>", provider: "Ollama · local", local: true, available: false, detail: "Service unavailable." },
    { id: "personal/openai/private-model", label: "private-model", provider: "Private", local: false, available: true, detail: "" },
  ] }).body;
  assert.match(html, /Server models/);
  assert.match(html, /&lt;local-model&gt;/);
  assert.match(html, /Unavailable/);
  assert.match(html, /not to your laptop/);
  assert.match(html, /not your personal keys/);
  assert.doesNotMatch(html, /<local-model>|private-model/);
});
