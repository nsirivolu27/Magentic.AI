import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { automationConfigSchema, type AutomationUnit, type AutomationRecord } from "../workbench/automation-schema.js";
import { createAutomationRuntime, loadAutomationUnits, type AutomationInvoker } from "../workbench/automation-runtime.js";
import { lambdaInvoker } from "../workbench/automation-lambda.js";
import { registerAutomationInspection } from "../workbench/automation-mcp.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { filePipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "magentic-unit-test-"));
  const store = fileWorkspaceStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = randomUUID(); const pipelines = filePipelines(store);
  const stage = { ...DEFAULT_PIPELINE.stages[0]!, approval: true };
  const config = { ...DEFAULT_PIPELINE, stages: [stage] };
  pipelines.execute(workspaceId, "writer", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  let run = pipelines.execute(workspaceId, "writer", ["admin"], {
    action: "start", requestId: randomUUID(), title: "Process reviewed output", brief: "Prepare a report.",
  }, 2).runs[0]!;
  const command = (action: "complete" | "approve", actor: string, note?: string) => {
    run = pipelines.execute(workspaceId, actor, ["admin"], { action, runId: run.id, expectedRevision: run.revision, ...(note ? { note } : {}) }, 2).runs[0]!;
  };
  command("complete", "writer", "Reviewed requirements for the report.");
  const unit: AutomationUnit = { id: "report-builder", workspaceId, name: "Report builder", kind: "lambda",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:report-builder:3", stages: [stage.id], enabled: true, timeoutSeconds: 10 };
  const identity = { workspaceId, actor: "operator", roles: ["admin"] as const };
  const reference = { unitId: unit.id, runId: run.id, stageId: stage.id };
  const approve = () => { command("approve", "reviewer-one"); command("approve", "reviewer-two"); };
  return { directory, store, workspaceId, pipelines, unit, identity, reference, command, approve };
}

test("automation configuration rejects unknown fields, moving aliases, invalid regions and duplicate units", () => {
  const unit = { id: "report-builder", workspaceId: randomUUID(), name: "Reports", kind: "lambda",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:reports:2", stages: ["review"] };
  assert.equal(automationConfigSchema.parse({ units: [unit] }).units[0]!.enabled, false);
  for (const extra of [{ command: "aws" }, { timeoutSeconds: 0 }, { timeoutSeconds: 61 }, { profile: "--debug" },
    { functionArn: unit.functionArn.replace(":2", ":live") }, { functionArn: unit.functionArn.replace("us-east-1", "cn-north-1") }, { stages: ["review", "review"] }]) {
    assert.equal(automationConfigSchema.safeParse({ units: [{ ...unit, ...extra }] }).success, false);
  }
  assert.equal(automationConfigSchema.safeParse({ units: [unit, unit] }).success, false);
  assert.equal(automationConfigSchema.safeParse({ units: [], secrets: {} }).success, false);
});

test("startup names invalid automation fields and leaves an unset catalogue empty", async t => {
  const old = process.env.MAGENTIC_AUTOMATION_UNITS_FILE;
  t.after(() => { if (old === undefined) delete process.env.MAGENTIC_AUTOMATION_UNITS_FILE; else process.env.MAGENTIC_AUTOMATION_UNITS_FILE = old; });
  delete process.env.MAGENTIC_AUTOMATION_UNITS_FILE;
  assert.deepEqual(loadAutomationUnits(), []);
  const { directory } = fixture(t); const path = join(directory, "invalid.json");
  await writeFile(path, JSON.stringify({ units: [], unknown: true }));
  process.env.MAGENTIC_AUTOMATION_UNITS_FILE = path;
  assert.throws(loadAutomationUnits, /MAGENTIC_AUTOMATION_UNITS_FILE.*unknown/);
});

test("units require a completed independent review, tenant ownership and admin authority", async t => {
  const f = fixture(t); let calls = 0;
  const runtime = createAutomationRuntime(f.pipelines, f.store, [f.unit], async () => { calls++; return { status: "succeeded" }; });
  const preview = { action: "preview", ...f.reference };
  await assert.rejects(runtime.execute(f.identity, preview), /independently reviewed/);
  f.command("approve", "reviewer-one");
  await assert.rejects(runtime.execute(f.identity, preview), /independently reviewed/);
  f.command("approve", "reviewer-two");
  await assert.rejects(runtime.execute({ ...f.identity, roles: [] }, preview), /admin/);
  await assert.rejects(runtime.execute({ ...f.identity, workspaceId: randomUUID() }, preview), /not found/);
  await assert.rejects(runtime.execute(f.identity, { ...preview, stageId: "other" }), /not allowed/);
  await assert.rejects(runtime.execute(f.identity, { ...preview, payload: { output: "forged" } }));
  const result = await runtime.execute(f.identity, preview);
  assert.ok("payload" in result); assert.equal(result.payload.output, "Reviewed requirements for the report.");
  assert.equal(calls, 0);
  const corrupt = { ...f.pipelines, snapshot: () => {
    const snapshot = f.pipelines.snapshot(f.workspaceId); snapshot.runs[0]!.stages[0]!.output = "Edited after approval"; return snapshot;
  } };
  await assert.rejects(createAutomationRuntime(corrupt, f.store, [f.unit], async () => ({ status: "succeeded" })).execute(f.identity, preview), /approval policy/);
});

test("reviewed intent binds the function and payload; concurrent requests dispatch only once", async t => {
  const f = fixture(t); f.approve(); let calls = 0;
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const runtime = createAutomationRuntime(f.pipelines, f.store, [f.unit], async (_unit, payload) => {
    calls++; assert.equal(payload.outputHash, f.pipelines.snapshot(f.workspaceId).runs[0]!.stages[0]!.outputHash);
    await wait; return { status: "succeeded", executedVersion: "3" };
  });
  const preview = await runtime.execute(f.identity, { action: "preview", ...f.reference });
  assert.ok("expectedIntentHash" in preview);
  const input = { action: "invoke", ...f.reference, expectedIntentHash: preview.expectedIntentHash };
  await assert.rejects(runtime.execute(f.identity, { ...input, expectedIntentHash: "0".repeat(64) }), /changed/);
  const changed = createAutomationRuntime(f.pipelines, f.store, [{ ...f.unit, functionArn: f.unit.functionArn.replace(":3", ":4") }], async () => ({ status: "succeeded" }));
  await assert.rejects(changed.execute(f.identity, input), /changed/);
  const first = runtime.execute(f.identity, input);
  const duplicate = await runtime.execute(f.identity, input);
  assert.ok("action" in duplicate); assert.equal(duplicate.action.status, "running"); assert.equal(duplicate.dispatched, false);
  finish(); const result = await first; assert.ok("action" in result); assert.equal(result.action.status, "succeeded");
  assert.equal(calls, 1); assert.equal((await runtime.execute(f.identity, input) as { dispatched: boolean }).dispatched, false);
  assert.doesNotMatch(JSON.stringify(f.store.read(f.workspaceId)!.automationActions), /Reviewed requirements/);
});

test("failed persistence prevents dispatch; ambiguous outcomes survive restart without retry", async t => {
  const f = fixture(t); f.approve(); let calls = 0;
  const invoke: AutomationInvoker = async () => { calls++; throw new Error("secret transport detail"); };
  let runtime = createAutomationRuntime(f.pipelines, f.store, [f.unit], invoke);
  const preview = await runtime.execute(f.identity, { action: "preview", ...f.reference }); assert.ok("expectedIntentHash" in preview);
  const input = { action: "invoke", ...f.reference, expectedIntentHash: preview.expectedIntentHash };
  f.store.failNextCommit(new Error("Disk full"));
  await assert.rejects(runtime.execute(f.identity, input), /Disk full/); assert.equal(calls, 0);
  const result = await runtime.execute(f.identity, input); assert.ok("action" in result); assert.equal(result.action.status, "uncertain");
  const state = f.store.read(f.workspaceId)!;
  const running = { ...result.action, status: "running" } as AutomationRecord;
  delete running.finishedAt; delete running.elapsedMs;
  f.store.commit(f.workspaceId, { ...state, automationActions: [running] });
  runtime = createAutomationRuntime(filePipelines(f.store), f.store, [f.unit], invoke);
  runtime.recover(f.workspaceId);
  assert.equal(runtime.inspect(f.workspaceId).actions[0]!.status, "uncertain");
  await runtime.execute(f.identity, input); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(runtime.inspect(f.workspaceId)), /secret transport detail/);
  // A later pipeline write must preserve independently recorded execution history.
  f.pipelines.execute(f.workspaceId, "writer", ["admin"], { action: "configure", expectedVersion: 2, config: f.pipelines.snapshot(f.workspaceId).config }, 2);
  assert.equal(f.store.read(f.workspaceId)!.automationActions!.length, 1);
  await runtime.close(); await assert.rejects(runtime.execute(f.identity, input), /shutting down/);
});

test("Lambda adapter uses fixed CLI arguments, suppresses retries and retains no response body", async t => {
  const f = fixture(t); let calls = 0; let temporary = "";
  const payload = { requestId: "x", workspaceId: f.workspaceId, runId: f.reference.runId, stageId: f.reference.stageId, outputHash: "0".repeat(64), output: "Sensitive business text" };
  const invoke = lambdaInvoker(async ({ args, env, timeout }) => {
    calls++; assert.equal(env.AWS_MAX_ATTEMPTS, "1"); assert.equal(timeout, 10000);
    assert.equal(args[args.indexOf("--invocation-type") + 1], "RequestResponse");
    assert.equal(args[args.indexOf("--log-type") + 1], "None");
    assert.equal(args[args.indexOf("--endpoint-url") + 1], "https://lambda.us-east-1.amazonaws.com");
    assert.equal(args[args.indexOf("--profile") + 1], "company-dev");
    assert.ok(!args.join(" ").includes(payload.output));
    const input = args[args.indexOf("--payload") + 1]!.slice("fileb://".length); temporary = dirname(input);
    assert.deepEqual(JSON.parse(await readFile(input, "utf8")), payload);
    await writeFile(args.at(-1)!, "secret function output");
    return JSON.stringify({ StatusCode: 200, ExecutedVersion: "3", ...(calls === 2 ? { FunctionError: "Unhandled" } : {}) });
  });
  const result = await invoke({ ...f.unit, profile: "company-dev" }, payload);
  assert.equal(result.status, "succeeded"); assert.equal(result.responseBytes, 22); assert.match(result.responseHash!, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /secret function output/); await assert.rejects(access(temporary));
  assert.equal((await invoke({ ...f.unit, profile: "company-dev" }, payload)).status, "failed");
  const failed = lambdaInvoker(async () => { throw new Error("private credentials"); });
  assert.deepEqual(await failed(f.unit, payload), { status: "uncertain" });
  await assert.rejects(invoke({ ...f.unit, enabled: false }, payload), /disabled/);
});

test("automation HTTP boundary rechecks company membership and requires a trusted execution capability", async t => {
  const f = fixture(t); f.approve(); let admin = true; let calls = 0;
  const runtime = createAutomationRuntime(f.pipelines, f.store, [f.unit], async () => { calls++; return { status: "succeeded" }; });
  const server = createWorkbenchServer({ context: { store: memoryStore(), audit: memoryAudit(), members: { rolesFor: async () => admin ? ["admin"] : ["author"] } },
    assets: new Map(), pipelines: f.pipelines, automations: runtime,
    authenticate: async request => request.headers.authorization ? { workspaceId: f.workspaceId, actor: "operator",
      canRunAutomations: request.headers.authorization === "company-session" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/automation-units`;
  const request = (body: unknown, token = "company-session") => fetch(url, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  const input = { action: "preview", ...f.reference };
  assert.equal((await request(input, "mcp-credential")).status, 403);
  assert.equal((await request({ ...input, workspaceId: randomUUID() })).status, 400);
  const preview = await (await request(input)).json(); assert.ok(preview.expectedIntentHash);
  admin = false; assert.equal((await request({ ...input, action: "invoke", expectedIntentHash: preview.expectedIntentHash })).status, 403);
  admin = true; assert.equal((await request({ ...input, action: "invoke", expectedIntentHash: preview.expectedIntentHash })).status, 200);
  assert.equal(calls, 1);
});

test("MCP advertises inspection only and cannot cross company boundaries", async t => {
  const f = fixture(t); const runtime = createAutomationRuntime(f.pipelines, f.store, [f.unit], async () => ({ status: "succeeded" }));
  const server = new McpServer({ name: "automation-test", version: "1" });
  registerAutomationInspection(server, runtime, f.workspaceId);
  const client = new Client({ name: "automation-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["get_automation_units"]);
  assert.equal((await client.callTool({ name: "get_automation_units", arguments: { runId: randomUUID() } })).isError, true);
  assert.equal((await client.callTool({ name: "get_automation_units", arguments: { workspaceId: randomUUID() } })).isError, true);
  assert.equal((await client.callTool({ name: "invoke_automation_unit", arguments: {} })).isError, true);
  assert.deepEqual(runtime.inspect(randomUUID()).units, []);
});
