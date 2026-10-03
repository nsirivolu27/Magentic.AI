import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { withCloudModels } from "../workbench/model-catalog.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";
import type { ChatConfiguration } from "../workbench/chat.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";

const base: ChatConfiguration = { provider: "ollama", model: "local:latest", listModels: async () => ["local:latest"],
  loadModel: async () => ({ invoke: async () => ({ content: "local answer" }) }) };

test("catalog shows every provider without keys while only local models can run", async () => {
  const config = withCloudModels(base, {});
  const choices = await config.modelOptions!();
  assert.deepEqual([...new Set(choices.map((model) => model.provider))], ["Ollama · local", "OpenAI", "Anthropic · Claude", "Google · Gemini", "Azure · OpenAI", "Gateway · OpenAI compatible"]);
  assert.deepEqual(await config.listModels!(), ["local:latest"]);
  assert.ok(choices.some((model) => model.label === "Claude Sonnet 5"));
  await assert.rejects(config.loadModel("anthropic/claude-sonnet-5"), /ANTHROPIC_API_KEY/);
  assert.equal((await (await config.loadModel("local:latest")).invoke("Hello")).content, "local answer");
});

test("a stopped Ollama service does not hide cloud choices or expose connection secrets", async () => {
  const config = withCloudModels({ ...base, listModels: async () => { throw new Error("private endpoint secret"); } }, { OPENAI_API_KEY: "test-secret" });
  const choices = await config.modelOptions!();
  assert.equal(choices[0]?.available, false);
  assert.ok(choices.find((model) => model.id === "openai/gpt-6-astra")?.available);
  assert.doesNotMatch(JSON.stringify(choices), /test-secret|private endpoint/);
});

for (const scenario of [
  { id: "openai/gpt-6-astra", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/responses", response: { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "answer" }] }] } },
  { id: "anthropic/claude-sonnet-5", key: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/messages", response: { content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }] } },
  { id: "google/gemini-3.8-flash", key: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", response: { choices: [{ message: { content: "answer" } }] } },
]) {
  test(`selected ${scenario.id} uses its own endpoint, credentials, and cancellation`, async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const request: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, scenario.url); assert.equal(init?.signal, signal); assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, scenario.id.split("/")[1]);
      const headers = new Headers(init?.headers);
      if (scenario.key === "ANTHROPIC_API_KEY") {
        assert.equal(headers.get("x-api-key"), "test-secret"); assert.equal(headers.get("anthropic-version"), "2023-06-01");
      } else assert.equal(headers.get("authorization"), "Bearer test-secret");
      if (scenario.key === "OPENAI_API_KEY") { assert.equal(body.store, false); assert.equal(body.input, "Question"); }
      else assert.equal(body.messages[0].content, "Question");
      return Response.json(scenario.response);
    };
    const config = withCloudModels(base, { [scenario.key]: "test-secret" }, request);
    const model = await config.loadModel(scenario.id);
    assert.deepEqual(await model.invoke("Question", { signal }), { content: "answer" });
    assert.equal(calls, 1);
  });
}

test("cloud failures are sanitized and never silently invoke the local model", async () => {
  let localCalls = 0;
  const config = withCloudModels({ ...base, loadModel: async () => { localCalls++; throw new Error("wrong provider"); } },
    { GOOGLE_API_KEY: "test-secret" }, async () => new Response("secret provider response", { status: 401 }));
  const model = await config.loadModel("google/gemini-3.8-flash");
  await assert.rejects(model.invoke("Hello"), /^Error: The model provider rejected the request\.$/);
  assert.equal(localCalls, 0);
});

test("selector groups providers, explains setup, disables sending, and lets users switch back", async () => {
  const state = emptyChat();
  state.options = await withCloudModels(base, {}).modelOptions!();
  state.models = [base.model]; state.selectedModel = "anthropic/claude-sonnet-5";
  state.draft = "Keep my draft";
  const html = chatView({ configured: true, provider: base.provider, model: base.model }, state);
  assert.match(html, /<optgroup label="OpenAI">/); assert.match(html, /Google · Gemini/);
  assert.match(html, /Set ANTHROPIC_API_KEY/); assert.match(html, /Keep my draft/);
  assert.match(html, /id="chat-input"[^>]*disabled/); assert.doesNotMatch(html, /id="chat-model"[^>]*disabled/);
  state.selectedModel = base.model;
  assert.doesNotMatch(chatView({ configured: true, provider: base.provider, model: base.model }, state), /id="chat-input"[^>]*disabled/);
});

test("HTTP refuses disconnected and invented models before any provider call", async (t) => {
  let calls = 0;
  const config = withCloudModels({ ...base, loadModel: async () => { calls++; throw new Error("must not run"); } }, {});
  const server = createWorkbenchServer({ assets: new Map(), chat: config,
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "writer", roles: ["author"] }]) },
    authenticate: async () => ({ workspaceId: "one", actor: "writer" }),
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const catalog = await (await fetch(url + "/api/chat/models")).json();
  assert.ok(catalog.options.some((model: { provider: string }) => model.provider === "OpenAI"));
  for (const [model, status] of [["anthropic/claude-sonnet-5", 503], ["openai/invented", 400]] as const) {
    const response = await fetch(url + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }) });
    assert.equal(response.status, status);
  }
  assert.equal(calls, 0);
});
