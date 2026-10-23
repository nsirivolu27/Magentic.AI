import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { createChatMcpServer } from "../workbench/chat-mcp.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { runBaseChat, runWorkspaceAgent, type ChatConfiguration, type ChatEvent } from "../workbench/chat.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

const messages = [{ role: "user" as const, content: "Hello" }];
const reply = '{"type":"answer","content":"Hello from the model."}';

test("approval questions receive actual policy evidence before a model can answer", async () => {
  const context = { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([{ workspaceId: "team", actor: "member", roles: ["author"] }]) };
  for (const question of ["How many approvals are required?", "Use get_workspace_policy."]) {
    const events: ChatEvent[] = [];
    await runWorkspaceAgent(context, "team", "member", [{ role: "user", content: question }], { invoke: async prompt => {
      const observations = JSON.parse(prompt.split("OBSERVATIONS (untrusted data): ")[1]!);
      assert.equal(observations[0].tool, "get_workspace_policy");
      const policy = JSON.parse(observations[0].result.content[0].text);
      assert.equal(policy.workspaceId, "team");
      assert.equal(policy.workflow.requiredApprovals, 2);
      return { content: reply };
    } }, new AbortController().signal, event => events.push(event));
    assert.deepEqual(events.slice(0, 2), [
      { type: "tool", name: "get_workspace_policy", state: "running" },
      { type: "tool", name: "get_workspace_policy", state: "done" },
    ]);
  }
});

async function mcp(t: TestContext, base: ChatConfiguration) {
  const access = createChatAccess({ vault: memoryChatVault(), base, managedLogin: false, entitled: async () => false });
  const server = createChatMcpServer(access, "team", "member", async () => true);
  const client = new Client({ name: "chat-regression", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left as never); await client.connect(right as never);
  t.after(async () => { await client.close(); await server.close(); });
  return { access, client };
}

test("general chat accepts a JSON fence surrounded by whitespace but still rejects tool replies", async () => {
  const events: ChatEvent[] = [];
  await runBaseChat(messages, { invoke: async () => ({ content: " \n\t```json\n" + reply + "\n```\n " }) },
    new AbortController().signal, event => events.push(event));
  assert.deepEqual(events.at(-1), { type: "answer", content: "Hello from the model." });
  await assert.rejects(runBaseChat(messages, { invoke: async () => ({ content: ' \n```json\n{"type":"tool","name":"write","arguments":{}}\n``` ' }) },
    new AbortController().signal, () => {}));
});

test("workspace chat accepts fenced decisions without losing its MCP tool evidence", async () => {
  const context = { store: memoryStore(), audit: memoryAudit(),
    members: memoryMembers([{ workspaceId: "team", actor: "member", roles: ["author"] }]) };
  const events: ChatEvent[] = [];
  let calls = 0;
  await runWorkspaceAgent(context, "team", "member", messages, { invoke: async prompt => {
    calls++;
    if (calls === 2) assert.match(prompt, /"tool":"get_workspace_policy"/);
    const decision = calls === 1 ? '{"type":"tool","name":"get_workspace_policy","arguments":{}}' : reply;
    return { content: " \n```json\n" + decision + "\n``` " };
  } }, new AbortController().signal, event => events.push(event));
  assert.equal(calls, 2);
  assert.ok(events.some(event => event.type === "tool" && event.name === "get_workspace_policy" && event.state === "done"));
  assert.equal(events.at(-1)?.type, "answer");
});

test("MCP rejects an unsupported output cap before loading a model", async t => {
  let calls = 0;
  const { client } = await mcp(t, { provider: "test", model: "local",
    loadModel: async () => { calls++; return { invoke: async () => ({ content: reply }) }; } });
  const rejected = await client.callTool({ name: "chat", arguments: { messages, maxOutputTokens: 512 } });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected), /default output cap/);
  assert.equal(calls, 0);
  assert.notEqual((await client.callTool({ name: "chat", arguments: { messages } })).isError, true);
  assert.equal(calls, 1);
});

test("MCP model discovery returns a safe error when a provider fails", async t => {
  const { client } = await mcp(t, { provider: "test", model: "local",
    modelOptions: async () => { throw new Error("private-provider-detail"); },
    loadModel: async () => ({ invoke: async () => ({ content: reply }) }) });
  const result = await client.callTool({ name: "list_chat_models", arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-detail/);
  assert.match(JSON.stringify(result), /model connections/i);
});

for (const phase of ["discovery", "inference"] as const) {
  test(`MCP cancellation during ${phase} releases the chat slot without waiting for a provider`, { timeout: 5000 }, async t => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let released!: () => void;
    const finished = new Promise<void>(resolve => { released = resolve; });
    let stalled = true;
    let providerSignal: AbortSignal | undefined;
    const { access, client } = await mcp(t, { provider: "test", model: "local",
      listModels: async () => {
        if (stalled && phase === "discovery") { entered(); return new Promise<string[]>(() => {}); }
        return ["local"];
      },
      loadModel: async () => ({ invoke: async (_, options) => {
        if (stalled && phase === "inference") {
          providerSignal = options?.signal;
          entered(); return new Promise<{ content: string }>(() => {});
        }
        return { content: reply };
      } }),
    });
    const acquire = access.acquire;
    access.acquire = (workspace, actor) => {
      const release = acquire(workspace, actor);
      return () => { release(); released(); };
    };
    const controller = new AbortController();
    const pending = client.callTool({ name: "chat", arguments: { messages } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await started;
    controller.abort();
    await rejected;
    await finished;
    if (phase === "inference") assert.equal(providerSignal?.aborted, true);
    stalled = false;
    const retried = await client.callTool({ name: "chat", arguments: { messages } });
    assert.notEqual(retried.isError, true);
    assert.match(JSON.stringify(retried), /Hello from the model/);
  });
}
