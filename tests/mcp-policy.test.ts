import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { BOT_REPOSITORY_TOOLS, attemptSchema, botPolicySchema, effectiveToolPolicy, type BotPolicy } from "../workbench/bot-schema.js";
import { BotToolPolicyError, runBotWorker } from "../workbench/bot-worker.js";
import { filePipelines, memoryPipelines, DEFAULT_PIPELINE, pipelineSchema } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { pipelineView } from "../workbench/pipeline-view.js";

const policy: BotPolicy = { kind: "coder", maxSteps: 4, timeoutSeconds: 30, allowedTools: ["read_project_file"], maxToolCalls: 1 };
function fixture(bot = policy, checkout = "/unused") {
  const engine = memoryPipelines();
  const config = { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[3]!, bot, approval: false }] };
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Inspect scoped work", brief: "Use only the configured tools." }, 2).runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: "build", revision: 1,
    actor: "owner", bot, model: "fixture-model", checkout, baseCommit: "fixture", startedAt: new Date().toISOString(),
    status: "running", summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
  return { engine, config, run, attempt };
}

test("tool policies retain legacy defaults and distinguish an empty allowlist from an omitted one", () => {
  const legacy = { kind: "coder" as const, maxSteps: 6, timeoutSeconds: 120 };
  assert.deepEqual(botPolicySchema.parse(legacy), legacy);
  assert.deepEqual(effectiveToolPolicy(legacy), { allowedTools: [...BOT_REPOSITORY_TOOLS], maxToolCalls: 5 });
  assert.deepEqual(effectiveToolPolicy({ ...legacy, allowedTools: [] }), { allowedTools: [], maxToolCalls: 0 });
  assert.equal(effectiveToolPolicy({ ...policy, maxSteps: 1, maxToolCalls: 11 }).maxToolCalls, 0);
  for (const extra of [{ allowedTools: ["shell"] }, { allowedTools: ["project_diff", "project_diff"] },
    { maxToolCalls: -1 }, { maxToolCalls: 12 }, { allowShell: true }]) {
    const parsed = pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], bot: { ...legacy, ...extra } }] });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.slice(0, 3).join(".") === "stages.0.bot"));
  }
});

test("denied tools stop before MCP dispatch even when the model requests them", async () => {
  const f = fixture({ ...policy, allowedTools: ["project_diff"] });
  const events: string[] = [];
  await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke(prompt) {
    assert.match(prompt, /Allowed MCP tools for this phase: \["project_diff"\]/);
    return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "answer.ts" } }) };
  } }, new AbortController().signal, event => events.push(event)), error => error instanceof BotToolPolicyError && /does not allow read_project_file/.test(error.message));
  assert.equal(events.filter(event => event.startsWith("MCP tool:")).length, 0);
  assert.ok(events.includes("Blocked MCP tool: read_project_file"));
  assert.deepEqual(f.attempt.changes, []);
});

test("allowed MCP reads return repository evidence and a second call exceeds the saved limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-tool-policy-"));
  try {
    writeFileSync(join(directory, "answer.ts"), "export const answer = 42;");
    const f = fixture(policy, directory);
    const events: string[] = [];
    let calls = 0;
    await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke(prompt) {
      if (++calls === 2) {
        assert.match(prompt, /export const answer = 42/);
        assert.match(prompt, /Remaining tool calls: 0/);
      }
      return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "answer.ts" } }) };
    } }, new AbortController().signal, event => events.push(event)), /MCP tool-call limit/);
    assert.equal(calls, 2);
    assert.equal(events.filter(event => event.startsWith("MCP tool:")).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("context-only phases can return a result and cannot turn zero tools into a file proposal", async () => {
  const f = fixture({ ...policy, allowedTools: [], maxToolCalls: 0 });
  const result = await runBotWorker(f.attempt, f.run, { async invoke(prompt) {
    assert.match(prompt, /Allowed MCP tools for this phase: \[\]/);
    return { content: JSON.stringify({ type: "result", summary: "Plan based on the supplied work item.", changes: [] }) };
  } }, new AbortController().signal, () => {});
  assert.deepEqual(result.changes, []);
  await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke() {
    return { content: JSON.stringify({ type: "result", summary: "Attempted edit without a read", changes: [{ path: "answer.ts", content: "modified" }] }) };
  } }, new AbortController().signal, () => {}), /did not read/);
});

test("saved run policies survive restart and later configuration cannot widen them", () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-policy-storage-"));
  const f = fixture();
  let store = fileWorkspaceStore(directory);
  try {
    let engine = filePipelines(store);
    engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config: f.config }, 2);
    const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Keep this policy", brief: "Read only." }, 2).runs[0]!;
    const widened = structuredClone(f.config);
    widened.stages[0]!.bot = { ...policy, allowedTools: [...BOT_REPOSITORY_TOOLS], maxToolCalls: 3 };
    engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 2, config: widened }, 2);
    store.close(); store = fileWorkspaceStore(directory); engine = filePipelines(store);
    const reopened = engine.snapshot("one");
    assert.deepEqual(reopened.runs.find(item => item.id === run.id)!.config.stages[0]!.bot, policy);
    assert.deepEqual(reopened.config.stages[0]!.bot, widened.stages[0]!.bot);
    const html = pipelineView(reopened, "owner", ["admin"], undefined, undefined, { project: null, attempts: [], busy: false });
    assert.match(html, /Allowed repository MCP tools/);
    assert.match(html, /name="toolcalls-0"/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("standalone MCP discovers enforced policies and reads only attempts bound to its workspace and run", async t => {
  const f = fixture();
  const source = "private fixture implementation";
  const attempts = [0, 1, 2].map(() => ({ ...structuredClone(f.attempt), id: randomUUID(), status: "ready" as const,
    changes: [{ path: "answer.ts", before: source, after: "proposed fixture implementation" }] }));
  let executions = 0;
  const server = createWorkbenchServer({ assets: new Map(), pipelines: f.engine,
    bots: { snapshot: workspace => ({ project: null, busy: false, attempts: workspace === "one" ? structuredClone(attempts) : [] }),
      busy: () => false, execute: async () => { executions++; throw new Error("Inspection must not execute bots."); }, close: async () => {} },
    context: { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
      members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["author", "admin"] }, { workspaceId: "two", actor: "outsider", roles: ["author"] }]) },
    authenticate: async request => {
      const token = request.headers.authorization;
      if (token === "Bearer fixture-owner") return { workspaceId: "one", actor: "owner" };
      if (token === "Bearer fixture-outsider") return { workspaceId: "two", actor: "outsider" };
      return undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/api/pipeline-mcp`);
  const client = new Client({ name: "policy-test", version: "1" });
  const outsider = new Client({ name: "isolation-test", version: "1" });
  t.after(() => client.close()); t.after(() => outsider.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer fixture-owner" } } }) as unknown as Parameters<typeof client.connect>[0]);
  await outsider.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer fixture-outsider" } } }) as unknown as Parameters<typeof outsider.connect>[0]);
  async function read(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true);
    const content = response.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text);
  }
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, 8);
  for (const name of ["get_pipeline_capabilities", "list_bot_attempts", "get_bot_attempt"]) assert.equal(listed.find(tool => tool.name === name)!.annotations!.readOnlyHint, true);
  const capabilities = await read("get_pipeline_capabilities");
  assert.deepEqual(capabilities.phases[0].allowedTools, ["read_project_file"]);
  assert.equal(capabilities.phases[0].maxToolCalls, 1);
  assert.equal(capabilities.requiredApprovals, 2);
  assert.equal(capabilities.execution.directMcpBotExecution, false);
  const page = await read("list_bot_attempts", { runId: f.run.id, limit: 2 });
  assert.equal(page.total, 3); assert.equal(page.attempts.length, 2); assert.equal(page.nextOffset, 2);
  assert.equal(JSON.stringify(page).includes(source), false);
  const tail = await read("list_bot_attempts", { runId: f.run.id, offset: 2, limit: 2 });
  assert.equal(tail.attempts.length, 1); assert.equal(tail.nextOffset, null);
  assert.equal((await read("get_bot_attempt", { runId: f.run.id, attemptId: attempts[0]!.id })).attempt.changes[0].before, source);
  for (const name of ["list_bot_attempts", "get_bot_attempt"]) {
    const args = { runId: f.run.id, ...(name === "get_bot_attempt" ? { attemptId: attempts[0]!.id } : {}) };
    assert.equal((await outsider.callTool({ name, arguments: args })).isError, true);
    assert.equal((await client.callTool({ name, arguments: { ...args, workspaceId: "two" } })).isError, true);
  }
  assert.equal((await client.callTool({ name: "get_bot_attempt", arguments: { runId: randomUUID(), attemptId: attempts[0]!.id } })).isError, true);
  assert.equal((await client.callTool({ name: "list_bot_attempts", arguments: { runId: f.run.id, limit: 51 } })).isError, true);
  assert.equal((await client.callTool({ name: "start_bot", arguments: { runId: f.run.id } })).isError, true);
  assert.equal(executions, 0);
  assert.equal(f.engine.snapshot("one").runs[0]!.revision, 1);
});
