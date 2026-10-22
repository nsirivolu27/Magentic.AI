import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { agentHash, createAgentTests, toolCallsFrom, type AgentTestsEngine } from "../workbench/agent-tests.js";
import { saveConfigurable } from "../workbench/agent-configurables.js";
import { createWorkbenchServer } from "../workbench/server.js";
import type { ChatConfiguration } from "../workbench/chat.js";

/**
 * Agent tests execute the real worker against the attached repository and
 * record execution, evidence and review as three separate facts. The
 * scripted demo model is used throughout: it makes real MCP reads and
 * reports no token usage, so nothing here is a claim about live accuracy.
 */

const operator = DEMO_MEMBERS[0]!.actor;
const reviewer = DEMO_MEMBERS[1]!.actor;
const roles = { operator: DEMO_MEMBERS[0]!.roles, reviewer: DEMO_MEMBERS[1]!.roles };

async function demo(chat = scriptedDemoChat()) {
  const directory = mkdtempSync(join(tmpdir(), "magentic-agent-tests-"));
  const fixture = await createAgentDemo(directory, chat);
  return { ...fixture, directory, cleanup: async () => { await fixture.agentTests.close(); await fixture.bots.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const finished = async (tests: AgentTestsEngine) => { await tests.settled(DEMO_WORKSPACE); return tests.snapshot(DEMO_WORKSPACE).runs.at(-1)!; };

test("a saved test runs the worker, records the real source read, usage and tool calls, and stays bound to the agent version", { timeout: 90_000 }, async () => {
  const d = await demo();
  try {
    const tests = d.agentTests;
    const before = tests.snapshot(DEMO_WORKSPACE);
    assert.equal(before.cases.length, 2, "the demo seeds one case per agent");
    const testCase = before.cases[0]!;
    const version = d.pipelines.snapshot(DEMO_WORKSPACE).version;
    const started = await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version });
    assert.equal(started.busy, true);
    assert.equal(started.runs[0]!.status, "running");
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version }), /already running/);
    const run = await finished(tests);
    assert.equal(run.status, "succeeded", run.error);
    assert.equal(run.sourceRead, true);
    assert.deepEqual(run.toolCalls, [{ name: "read_project_file", path: "SOP.md", outcome: "read" }]);
    assert.equal(run.calls, 2);
    assert.equal(run.tokenUsage, null, "the scripted model reports no usage and none is invented");
    assert.match(run.summary, /team owner's approval/);
    assert.equal(run.model, "demo-scripted");
    assert.equal(run.agentHash, agentHash(d.agents[0]!));
    assert.ok(run.finishedAt && run.finishedAt >= run.startedAt);
    assert.equal(run.review, undefined, "finishing is not a quality verdict");
    // Editing the agent changes its version; the run keeps the version it tested.
    const edited = { ...d.agents[0]!, instructions: d.agents[0]!.instructions + " Keep the answer under five sentences." };
    const pipeline = d.pipelines.snapshot(DEMO_WORKSPACE);
    d.pipelines.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "configure", expectedVersion: pipeline.version, config: saveConfigurable(pipeline.config, edited) }, 2);
    assert.notEqual(agentHash(edited), run.agentHash);
    assert.equal(tests.snapshot(DEMO_WORKSPACE).runs[0]!.agentHash, run.agentHash);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version }), /changed since this page loaded/);
  } finally { await d.cleanup(); }
});

test("a quality review is recorded by an approver, once, separately from execution success", { timeout: 90_000 }, async () => {
  const d = await demo();
  try {
    const tests = d.agentTests;
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: d.pipelines.snapshot(DEMO_WORKSPACE).version });
    const run = await finished(tests);
    assert.equal(run.status, "succeeded");
    await assert.rejects(tests.execute(DEMO_WORKSPACE, "demo.guest", ["author"], { action: "review", runId: run.id, verdict: "pass" }), /approver or admin/);
    const reviewed = await tests.execute(DEMO_WORKSPACE, reviewer, roles.reviewer, { action: "review", runId: run.id, verdict: "fail", note: "Response target was stated without the approval precondition." });
    assert.deepEqual({ ...reviewed.runs[0]!.review, at: "" }, { verdict: "fail", note: "Response target was stated without the approval precondition.", by: reviewer, at: "" });
    assert.equal(reviewed.runs[0]!.status, "succeeded", "a failed review does not rewrite the execution outcome");
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "review", runId: run.id, verdict: "pass" }), /already reviewed/);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, reviewer, roles.reviewer, { action: "review", runId: randomUUID(), verdict: "pass" }), /not in this workspace/);
  } finally { await d.cleanup(); }
});

test("a model that answers without reading fails the required-read rule, and a missing or empty source is refused before any model call", { timeout: 90_000 }, async () => {
  const scripted = scriptedDemoChat();
  const unread: ChatConfiguration = { ...scripted, loadModel: async () => ({ async invoke() { return { content: JSON.stringify({ type: "result", changes: [], summary: "The SOP says approval is automatic." }) }; } }) };
  const d = await demo(unread);
  try {
    const tests = d.agentTests;
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    const version = d.pipelines.snapshot(DEMO_WORKSPACE).version;
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version });
    const run = await finished(tests);
    assert.equal(run.status, "failed");
    assert.match(run.error, /Required source read missing/);
    assert.equal(run.sourceRead, false);
    assert.equal(run.summary, "", "an unverified answer is never recorded as the result");
    assert.ok(run.events.includes("Result blocked: no successful source read."));
    // Source problems are caught before a model is loaded, with the fix named.
    const missing = await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "save_case", id: testCase.id, agentId: testCase.agentId, title: testCase.title, prompt: testCase.prompt, expected: "", source: "nope.md" });
    assert.equal(missing.cases[0]!.source, "nope.md");
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version }), /"nope.md" is not in the attached repository/);
    writeFileSync(join(d.root, "empty.md"), "  \n");
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "save_case", id: testCase.id, agentId: testCase.agentId, title: testCase.title, prompt: testCase.prompt, expected: "", source: "empty.md" });
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: version }), /"empty.md" is empty/);
    assert.equal(tests.snapshot(DEMO_WORKSPACE).runs.length, 1, "refused runs leave no record");
  } finally { await d.cleanup(); }
});

test("an exhausted call budget and a model that never answers both end as explained failures", { timeout: 90_000 }, async () => {
  const scripted = scriptedDemoChat();
  const greedy: ChatConfiguration = { ...scripted, loadModel: async () => ({ async invoke() { return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }) }; } }) };
  const d = await demo(greedy);
  try {
    const tests = d.agentTests;
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: d.pipelines.snapshot(DEMO_WORKSPACE).version });
    const run = await finished(tests);
    assert.equal(run.status, "failed");
    assert.match(run.error, /tool-call limit/);
    assert.equal(run.toolCalls.length, 2, "the budget of two reads was spent before the refusal");
    assert.equal(run.sourceRead, true, "a read happened even though no answer was produced");
  } finally { await d.cleanup(); }
  const hanging: ChatConfiguration = { ...scripted, loadModel: async () => ({ invoke: (_prompt, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }) }) };
  const h = await demo(hanging);
  try {
    const tests = h.agentTests;
    const pipeline = h.pipelines.snapshot(DEMO_WORKSPACE);
    const quick = { ...h.agents[0]!, bot: { ...h.agents[0]!.bot, timeoutSeconds: 15 } };
    h.pipelines.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "configure", expectedVersion: pipeline.version, config: saveConfigurable(pipeline.config, quick) }, 2);
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: pipeline.version + 1 });
    const run = await finished(tests);
    assert.equal(run.status, "cancelled");
    assert.match(run.error, /15 second limit/);
  } finally { await h.cleanup(); }
});

test("tests are workspace scoped, role checked and refuse an unconnected model or an agent with no tools", { timeout: 90_000 }, async () => {
  const d = await demo();
  try {
    const tests = d.agentTests;
    const testCase = tests.snapshot(DEMO_WORKSPACE).cases[0]!;
    assert.deepEqual(tests.snapshot("other-workspace").cases, []);
    await assert.rejects(tests.execute("other-workspace", operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: 1 }), /not in this workspace/);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, [], { action: "save_case", agentId: testCase.agentId, title: "x", prompt: "y" }), /not a member/);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, reviewer, roles.reviewer, { action: "save_case", agentId: testCase.agentId, title: "x", prompt: "y" }), /author or admin/);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "save_case", agentId: randomUUID(), title: "x", prompt: "y" }), /agent is not in this workspace/);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "save_case", agentId: testCase.agentId, title: "x", prompt: "y", extra: true }), /unrecognized|Unrecognized/i);
    // An agent whose model is not connected, and one with no tools at all.
    const pipeline = d.pipelines.snapshot(DEMO_WORKSPACE);
    const offline = { ...d.agents[0]!, model: "not-connected" };
    const toolless = { ...d.agents[1]!, bot: { ...d.agents[1]!.bot, requireSourceRead: false, allowedTools: [] as ("read_project_file")[], maxToolCalls: 0 } };
    const next = d.pipelines.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "configure", expectedVersion: pipeline.version, config: saveConfigurable(saveConfigurable(pipeline.config, offline), toolless) }, 2);
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: testCase.id, expectedVersion: next.version }), /"not-connected" is not connected/);
    const second = tests.snapshot(DEMO_WORKSPACE).cases[1]!;
    await assert.rejects(tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: second.id, expectedVersion: next.version }), /names a source but the agent may not read files/);
    const noSource = await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "save_case", id: second.id, agentId: second.agentId, title: second.title, prompt: second.prompt, expected: "", source: "" });
    assert.equal(noSource.cases[1]!.source, "");
    await tests.execute(DEMO_WORKSPACE, operator, roles.operator, { action: "run", caseId: second.id, expectedVersion: next.version });
    const run = await finished(tests);
    assert.equal(run.status, "failed");
    assert.match(run.error, /does not allow read_project_file/, "the scripted model asks for a read the agent was not granted");
    assert.deepEqual(run.toolCalls, []);
  } finally { await d.cleanup(); }
});

test("the HTTP route enforces membership and returns the same snapshot the engine holds", { timeout: 90_000 }, async () => {
  const d = await demo();
  const server = createWorkbenchServer({ ...d, assets: new Map(), demo: true,
    authenticate: async request => {
      const actor = request.headers.authorization?.replace(/^Bearer /, "");
      return actor && DEMO_MEMBERS.some(member => member.actor === actor) ? { workspaceId: DEMO_WORKSPACE, actor } : undefined;
    } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const anonymous = await fetch(`${base}/api/agent-tests`);
    assert.equal(anonymous.status, 401);
    const listed = await fetch(`${base}/api/agent-tests`, { headers: { Authorization: `Bearer ${operator}` } });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { cases: unknown[]; runs: unknown[]; busy: boolean };
    assert.equal(body.cases.length, 2);
    const forbidden = await fetch(`${base}/api/agent-tests`, { method: "POST", headers: { Authorization: `Bearer ${reviewer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", caseId: (body.cases[0] as { id: string }).id, expectedVersion: 2 }) });
    assert.equal(forbidden.status, 403);
  } finally { server.close(); server.closeAllConnections(); await d.cleanup(); }
});

test("tool calls are rebuilt from the worker log without inventing reads", () => {
  assert.deepEqual(toolCallsFrom(["Model call 1 of 4", "MCP tool: read_project_file", "Source read: SOP.md (120 characters)", "MCP tool: list_project_files", "MCP tool: read_project_file", "Source missing: gone.md"]),
    [{ name: "read_project_file", path: "SOP.md", outcome: "read" }, { name: "list_project_files", outcome: "called" }, { name: "read_project_file", path: "gone.md", outcome: "missing" }]);
  assert.deepEqual(toolCallsFrom(["Result blocked: no successful source read."]), []);
});
