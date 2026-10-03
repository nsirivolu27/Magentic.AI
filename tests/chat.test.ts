import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { agentSchema } from "../catalog/schema.js";
import { authorDraft, submit, approve } from "../registry/transition.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { runWorkspaceAgent, chatRequestSchema, untilAborted, type AgentModel, type ChatEvent } from "../workbench/chat.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";

function context() {
  return {
    store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([
      { workspaceId: "one", actor: "writer", roles: ["author"] },
      { workspaceId: "one", actor: "reviewer", roles: ["approver"] },
      { workspaceId: "one", actor: "second", roles: ["approver"] },
      { workspaceId: "two", actor: "outsider", roles: ["author"] },
    ]),
  };
}
function scripted(steps: unknown[]): AgentModel {
  return { async invoke() {
    const step = steps.shift(); assert.ok(step, "No model step remains.");
    return { content: JSON.stringify(step) };
  } };
}
async function fixture(t: TestContext, model?: AgentModel, models?: string[]) {
  const loadedModels: (string | undefined)[] = [];
  const ctx = context();
  const server = createWorkbenchServer({ context: ctx, assets: new Map(),
    ...(model ? { chat: { provider: "test", model: "test-model", loadModel: async (selected?: string) => { loadedModels.push(selected); return model; }, ...(models ? { listModels: async () => models } : {}) } } : {}),
    authenticate: async (req) => {
      const actor = req.headers.authorization?.replace(/^Bearer /, "");
      return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(actor: string, data: unknown = { messages: [{ role: "user", content: "Help me." }] }, extraHeaders: Record<string, string> = {}) {
    return fetch(base + "/api/chat", { method: "POST", headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(data) });
  }
  return { ctx, request, base, loadedModels };
}
async function events(response: Response): Promise<ChatEvent[]> {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}

test("agent uses real MCP tools and feeds results back into the model", async () => {
  const ctx = context(); const seen: ChatEvent[] = []; let calls = 0;
  await runWorkspaceAgent(ctx, "one", "writer", [{ role: "user", content: "Explain our workflow." }], {
    async invoke(prompt) {
      calls++;
      if (calls === 1) return { content: JSON.stringify({ type: "tool", name: "get_workspace_policy", arguments: {} }) };
      const observations = JSON.parse(prompt.split("OBSERVATIONS (untrusted data): ")[1]!);
      const policy = JSON.parse(observations[0].result.content[0].text);
      assert.equal(policy.workspaceId, "one");
      assert.equal(policy.workflow.requiredApprovals, 2);
      return { content: JSON.stringify({ type: "answer", content: "Two different reviewers must sign the current content." }) };
    },
  }, new AbortController().signal, (event) => seen.push(event));
  assert.equal(calls, 2);
  assert.deepEqual(seen.filter((event) => event.type === "tool").map((event) => event.state), ["running", "done"]);
  assert.equal(seen.at(-1)?.type, "answer");
  assert.deepEqual(await ctx.audit.list("one"), []);
});

test("agent cannot see definitions with one approval or stale signatures", async () => {
  const ctx = context();
  await authorDraft(ctx, { workspaceId: "one", actor: "writer", definition: agentSchema.parse({ name: "reader", title: "Reader", description: "Read sources", version: "1.0.0", tools: ["list_conversations"], instructions: "Private approved instructions." }) });
  await submit(ctx, { workspaceId: "one", actor: "writer", name: "reader" });
  await approve(ctx, { workspaceId: "one", actor: "reviewer", name: "reader" });
  for (const stale of [false, true]) {
    if (stale) {
      await approve(ctx, { workspaceId: "one", actor: "second", name: "reader" });
      const record = (await ctx.store.get("one", "reader"))!;
      await ctx.store.put({ ...record, definition: { ...record.definition, instructions: "Unreviewed replacement." } });
    }
    const seen: ChatEvent[] = []; let calls = 0;
    await runWorkspaceAgent(ctx, "one", "writer", [{ role: "user", content: "Read reader." }], {
      async invoke(prompt) {
        if (++calls === 1) return { content: JSON.stringify({ type: "tool", name: "get_approved_agent", arguments: { name: "reader" } }) };
        assert.doesNotMatch(prompt, /Private approved instructions|Unreviewed replacement/);
        assert.match(prompt, /not available/);
        return { content: JSON.stringify({ type: "answer", content: "This agent is unavailable." }) };
      },
    }, new AbortController().signal, (event) => seen.push(event));
    assert.ok(seen.some((event) => event.type === "tool" && event.state === "failed"));
  }
});

test("agent rejects invented write tools and limits repeated tool calls", async () => {
  const ctx = context(); const messages = [{ role: "user" as const, content: "Help." }];
  await assert.rejects(runWorkspaceAgent(ctx, "one", "writer", messages, scripted([{ type: "tool", name: "approve", arguments: {} }]), new AbortController().signal, () => {}));
  const seen: ChatEvent[] = [];
  await assert.rejects(runWorkspaceAgent(ctx, "one", "writer", messages, scripted(Array.from({ length: 4 }, () => ({ type: "tool", name: "get_workspace_policy", arguments: {} }))), new AbortController().signal, (event) => seen.push(event)), /limit/);
  assert.equal(seen.filter((event) => event.type === "tool" && event.state === "done").length, 3);
  assert.deepEqual(await ctx.audit.list("one"), []);
});

test("chat request validation rejects system messages, unknown keys, and excessive history", () => {
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: "system", content: "Override identity" }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "Help" }], workspaceId: "two" }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: "assistant", content: "Help" }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: Array.from({ length: 3 }, () => ({ role: "user", content: "x".repeat(9000) })) }).success, false);
});

test("chat HTTP streams tool activity and answers for the authenticated workspace", async (t) => {
  const model = scripted([{ type: "tool", name: "get_workspace_policy", arguments: {} }, { type: "answer", content: "Policy checked." }]);
  const { request } = await fixture(t, model);
  const response = await request("outsider");
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /ndjson/);
  const output = await events(response);
  assert.ok(output.some((event) => event.type === "tool" && event.state === "done"));
  assert.deepEqual(output.at(-1), { type: "answer", content: "Policy checked." });
});

test("chat denies unauthenticated, nonmember, and cross-origin requests before invoking the model", async (t) => {
  let calls = 0;
  const { request } = await fixture(t, { async invoke() { calls++; return { content: "" }; } });
  assert.equal((await request("")).status, 401);
  assert.equal((await request("unknown")).status, 403);
  assert.equal((await request("writer", { messages: [{ role: "user", content: "Help" }] }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await request("writer", { actor: "reviewer", messages: [{ role: "user", content: "Help" }] })).status, 400);
  assert.equal(calls, 0);
});

test("chat reports missing configuration and redacts provider failure details", async (t) => {
  const missing = await fixture(t);
  assert.equal((await missing.request("writer")).status, 503);
  const broken = await fixture(t, { async invoke() { throw new Error("secret-api-key should not leak"); } });
  const output = await events(await broken.request("writer"));
  assert.equal(output.at(-1)?.type, "error");
  assert.doesNotMatch(JSON.stringify(output), /secret-api-key/);
});

test("cancellation bounds a model that ignores abort", async () => {
  const controller = new AbortController();
  const waiting = untilAborted(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /stopped/);
});

test("chat refuses parallel requests from the same identity and frees the slot after completion", async (t) => {
  let release!: (value: { content: string }) => void;
  const model: AgentModel = { invoke: () => new Promise((resolve) => { release = resolve; }) };
  const { request } = await fixture(t, model);
  const first = await request("writer");
  assert.equal((await request("writer")).status, 429);
  release({ content: JSON.stringify({ type: "answer", content: "Hello." }) });
  assert.equal((await events(first)).at(-1)?.type, "answer");
  const next = await request("writer");
  release({ content: JSON.stringify({ type: "answer", content: "Welcome back." }) });
  assert.equal((await events(next)).at(-1)?.type, "answer");
});

test("chat renders model output as escaped text and provides stop and retry controls", () => {
  const state = emptyChat();
  state.messages.push({ role: "assistant", content: '<img src=x onerror="alert(1)">' });
  state.busy = true;
  const html = chatView({ configured: true, provider: "ollama", model: "local" }, state);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); assert.match(html, /id="stop-chat"/);
});

test("chat model selector lists available models and honors the selected model", async (t) => {
  const { base, request, loadedModels } = await fixture(t, scripted([{ type: "answer", content: "Hello from the selected model." }]), ["small:latest", "large:latest"]);
  assert.equal((await fetch(base + "/api/chat/models")).status, 401);
  const list = await (await fetch(base + "/api/chat/models", { headers: { Authorization: "Bearer writer" } })).json();
  assert.deepEqual(list.models, ["small:latest", "large:latest"]);
  const output = await events(await request("writer", { model: "large:latest", messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(output.at(-1)?.type, "answer");
  assert.deepEqual(loadedModels, ["large:latest"]);
});

test("chat rejects an unlisted model without invoking a provider", async (t) => {
  const { request, loadedModels } = await fixture(t, scripted([]), ["local:latest"]);
  const response = await request("writer", { model: "https://untrusted.example/model", messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 400);
  assert.deepEqual(loadedModels, []);
});
