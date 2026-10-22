import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault, fileChatVault } from "../workbench/chat-vault.js";
import { createChatConnections } from "../workbench/chat-connections.js";
import { chatPlanSchema, decideChatRoute } from "../workbench/chat-routing.js";
import { chatRequestSchema, type ChatConfiguration } from "../workbench/chat.js";
import { createChatMcpServer } from "../workbench/chat-mcp.js";
import { createBilling } from "../workbench/billing.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";

const messages = [{ role: "user" as const, content: "Hello" }];
const plan = chatPlanSchema.parse({ dailyTokens: 50000, models: [
  { id: "gateway/small", tasks: ["quick", "general", "code", "analysis"], strength: "efficient", priority: 0, maxOutputTokens: 2048 },
  { id: "gateway/large", tasks: ["general", "code", "analysis"], strength: "capable", priority: 1, maxOutputTokens: 4096 },
] });
function fixture(paid = true, report = true) {
  const calls: { id: string; cap: number | undefined; prompt: string }[] = [];
  const vault = memoryChatVault();
  let enabled = paid;
  const base: ChatConfiguration = { provider: "ollama", model: "local", outputLimit: true,
    modelOptions: async () => ["local", "gateway/small", "gateway/large"].map(id => ({ id, label: id, provider: id === "local" ? "Ollama" : "Gateway", local: id === "local", available: true, detail: "", outputLimit: true })),
    loadModel: async (id = "local", limits) => ({ invoke: async prompt => {
      calls.push({ id, cap: limits?.maxOutputTokens, prompt });
      return { content: '{"type":"answer","content":"Response"}', ...(report ? { usage: { promptTokens: 10, completionTokens: 5 } } : {}) };
    } }),
  };
  const access = createChatAccess({ vault, base, managedLogin: true, plan, entitled: async () => enabled });
  return { access, calls, base, vault, disable: () => { enabled = false; } };
}

test("Auto respects task roles, preference and output ceilings without inventing accuracy", () => {
  const choices = plan.models.map(model => ({ ...model, label: model.id, provider: "Gateway", local: false, available: true, outputLimit: true, detail: "" }));
  const code = [{ role: "user" as const, content: "Debug this TypeScript function." }];
  const economy = decideChatRoute(code, choices, plan.models, "economy");
  const quality = decideChatRoute(code, choices, plan.models, "quality");
  assert.equal(economy.model, "gateway/small"); assert.equal(economy.maxOutputTokens, 1024);
  assert.equal(quality.model, "gateway/large"); assert.equal(quality.maxOutputTokens, 4096);
  assert.match(quality.reason, /not measured accuracy/);
  assert.equal(decideChatRoute(messages, choices, plan.models).maxOutputTokens, 512);
  assert.throws(() => decideChatRoute(code, [], plan.models), /No connected/);
  assert.equal(chatPlanSchema.safeParse({ ...plan, extra: true }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages, routing: "auto", tier: "paid" }).success, false);
});

test("unpaid members cannot forge Auto or use server-funded models", async () => {
  const f = fixture(false);
  await assert.rejects(f.access.prepare("w", "a", { messages, routing: "auto" }), /paid access/);
  const config = await f.access.configuration("w", "a");
  await assert.rejects(config.loadModel("gateway/small"), /not available/);
  assert.equal((await config.modelOptions!()).find(model => model.id === "local")?.available, true);
  assert.equal(f.calls.length, 0);
});

test("paid status is rechecked after preparation and manual caps cannot exceed the plan", async () => {
  const f = fixture();
  const prepared = await f.access.prepare("w", "a", { messages, model: "gateway/small", maxOutputTokens: 8192 });
  assert.equal(prepared.maxOutputTokens, 2048);
  f.disable();
  await assert.rejects(prepared.config.loadModel(prepared.model, { maxOutputTokens: prepared.maxOutputTokens }), /could not be verified/);
  assert.equal(f.calls.length, 0);
});

test("managed usage is shared across members and persists through service recreation", async () => {
  const f = fixture();
  const prepared = await f.access.prepare("w", "a", { messages, routing: "auto" });
  const model = await prepared.config.loadModel(prepared.model, prepared.maxOutputTokens === undefined ? undefined : { maxOutputTokens: prepared.maxOutputTokens });
  await model.invoke("hello");
  assert.equal((await f.access.summary("w", "b")).accountedTokens, 15);
  const restored = createChatAccess({ vault: f.vault, base: f.base, managedLogin: true, plan, entitled: async () => true });
  assert.equal((await restored.summary("w", "a")).accountedTokens, 15);
  assert.equal((await restored.summary("other", "a")).accountedTokens, 0);
});

test("unknown usage retains a reservation and an exhausted allowance blocks before inference", async () => {
  const f = fixture(true, false);
  const limited = createChatAccess({ vault: f.vault, base: f.base, managedLogin: true, plan: { ...plan, dailyTokens: 1024 }, entitled: async () => true });
  const config = await limited.configuration("w", "a");
  const model = await config.loadModel("gateway/small", { maxOutputTokens: 512 });
  await model.invoke("hello");
  await assert.rejects(model.invoke("hello"), /allowance/);
  assert.equal(f.calls.length, 1);
  assert.equal((await limited.summary("w", "a")).accountedTokens, 773);
});

test("provider keys and connections are isolated by both workspace and member", async () => {
  const requests: string[] = [];
  const request = (async (url, init) => {
    requests.push(String(url)); assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ data: [{ id: "text-model" }] }));
  }) as typeof fetch;
  const vault = memoryChatVault();
  const connections = createChatConnections(vault, request);
  await connections.execute("w", "a", { action: "connect", provider: "openai", apiKey: "private-test-key", models: ["text-model"] });
  assert.equal(connections.list("w", "a").length, 1);
  assert.equal(connections.list("w", "b").length, 0);
  assert.equal(connections.list("other", "a").length, 0);
  assert.doesNotMatch(JSON.stringify(connections.list("w", "a")), /private-test-key|apiKey/);
  await assert.rejects(connections.execute("w", "a", { action: "connect", provider: "openai", apiKey: "other-key", models: ["missing"] }), /not listed/);
  assert.deepEqual(connections.list("w", "a")[0]!.models, ["text-model"]);
  await connections.execute("w", "a", { action: "disconnect", provider: "openai" });
  assert.equal(connections.list("w", "a").length, 0);
  assert.ok(requests.every(url => url === "https://api.openai.com/v1/models"));
});

test("personal models use only their owner's credential and remain available on Free", async () => {
  const f = fixture(false);
  const request = (async (url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer private-test-key");
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "text-model" }] }));
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(JSON.parse(String(init!.body)).max_output_tokens, 512);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"type":"answer","content":"ok"}' }] }] }));
  }) as typeof fetch;
  const access = createChatAccess({ vault: f.vault, base: f.base, managedLogin: true, plan, entitled: async () => false, request });
  await access.connect("w", "a", { action: "connect", provider: "openai", apiKey: "private-test-key", models: ["text-model"] });
  const config = await access.configuration("w", "a");
  const model = await config.loadModel("personal/openai/text-model", { maxOutputTokens: 512 });
  await model.invoke("JSON answer please");
  await assert.rejects((await access.configuration("w", "b")).loadModel("personal/openai/text-model"), /not available/);
  await access.connect("w", "a", { action: "disconnect", provider: "openai" });
  await assert.rejects(config.loadModel("personal/openai/text-model"), /removed/);
});

test("the file vault encrypts secrets and refuses a moved record", t => {
  const directory = mkdtempSync(join(tmpdir(), "chat-vault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const vault = fileChatVault(directory);
  vault.write("one", { apiKey: "secret-not-on-disk" });
  const first = readdirSync(directory).find(name => name.endsWith(".json"))!;
  assert.doesNotMatch(readFileSync(join(directory, first), "utf8"), /secret-not-on-disk/);
  assert.deepEqual(fileChatVault(directory).read("one"), { apiKey: "secret-not-on-disk" });
  vault.write("two", {});
  const second = readdirSync(directory).find(name => name.endsWith(".json") && name !== first)!;
  copyFileSync(join(directory, first), join(directory, second));
  assert.throws(() => vault.read("two"), /could not be read/);
});

test("chat credentials expire, rotate, revoke and do not reveal provider secrets", async () => {
  let now = 1000;
  const f = fixture();
  const access = createChatAccess({ vault: f.vault, base: f.base, managedLogin: false, entitled: async () => false, now: () => now });
  const first = access.issueToken("w", "a");
  assert.deepEqual(access.authenticateToken(first.token), { workspaceId: "w", actor: "a" });
  const second = access.issueToken("w", "a");
  assert.equal(access.authenticateToken(first.token), undefined);
  assert.doesNotMatch(JSON.stringify(await access.summary("w", "a")), /mchat_|apiKey/);
  now += 8 * 86_400_000;
  assert.equal(access.authenticateToken(second.token), undefined);
  const third = access.issueToken("w", "a"); access.revokeToken("w", "a");
  assert.equal(access.authenticateToken(third.token), undefined);
});

test("Chat MCP discovers models, answers through the same router and rechecks membership", async t => {
  const f = fixture(); let member = true;
  const server = createChatMcpServer(f.access, "w", "a", async () => member);
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left as never); await client.connect(right as never);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["list_chat_models", "chat"]);
  const result = await client.callTool({ name: "chat", arguments: { messages, routing: "auto" } });
  assert.match(JSON.stringify(result), /gateway\/small/); assert.equal(f.calls.length, 1);
  member = false;
  assert.equal((await client.callTool({ name: "chat", arguments: { messages } })).isError, true);
  assert.equal(f.calls.length, 1);
});

test("subscription access requires the configured price, exact customer and active status", async () => {
  for (const [status, price, customer, expected] of [["active", "price_plan", "cus_w", true], ["past_due", "price_plan", "cus_w", false], ["active", "price_other", "cus_w", false], ["active", "price_plan", undefined, false]] as const) {
    const billing = createBilling({ priceId: "price_plan", customers: [{ workspaceId: "w", customerId: "cus_w" }] }, "sk_test_fixture", (async () => new Response(JSON.stringify({ has_more: false, data: [{ status, customer, livemode: false, items: { data: [{ price: { id: price } }] } }] }))) as typeof fetch);
    assert.equal(await billing.entitled("w"), expected);
  }
});

test("HTTP refuses forged plans, private connections and unauthenticated access", async t => {
  const f = fixture(false);
  const server = createWorkbenchServer({ assets: new Map(), chat: f.base, chatAccess: f.access,
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "w", actor: "a", roles: ["author"] }]) },
    authenticate: async request => request.headers.authorization ? { workspaceId: "w", actor: request.headers.authorization } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, body?: unknown, actor = "a") => fetch(`http://127.0.0.1:${address.port}${path}`, { method: body ? "POST" : "GET", headers: { ...(actor ? { Authorization: actor } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("/api/chat/access", undefined, "")).status, 401);
  assert.equal((await request("/api/chat/access", undefined, "b")).status, 403);
  assert.equal((await request("/api/base-chat", { messages, tier: "paid" })).status, 400);
  assert.equal((await request("/api/base-chat", { messages, routing: "auto" })).status, 403);
  assert.equal((await request("/api/base-chat", { messages, model: "gateway/small" })).status, 503);
  const result = await request("/api/base-chat", { messages, model: "local" });
  assert.equal(result.status, 200); assert.match(await result.text(), /Response/);
  assert.equal(f.calls.length, 1);
});

test("connections view presents setup honestly and escapes model metadata", async () => {
  const f = fixture(false);
  const summary = await f.access.summary("w", "a");
  summary.connections = [{ provider: "openai", models: ["<script>"], connectedAt: "today" }];
  const html = chatConnectionsPage(summary).body;
  assert.match(html, /Free · Your connections/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /type="password"/); assert.match(html, /seven days/);
});
