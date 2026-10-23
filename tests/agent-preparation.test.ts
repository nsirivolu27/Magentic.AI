import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentTests } from "../workbench/agent-tests.js";
import { agentConfigurableSchema, saveConfigurable } from "../workbench/agent-configurables.js";
import { memoryPipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { agentStudioPage } from "../workbench/agent-studio-view.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

async function fixture(maxSteps = 4) {
  const root = mkdtempSync(join(tmpdir(), "magentic-preparation-"));
  writeFileSync(join(root, "SOP.md"), "Review is independent. Opening a work item does not approve it.");
  const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Documentation guide", purpose: "Cite source material", model: "test-model", instructions: "Read SOP.md, then answer with citations.", bot: { kind: "planner", maxSteps, maxToolCalls: 1, timeoutSeconds: 15, allowedTools: ["read_project_file"], requireSourceRead: maxSteps >= 2 } });
  const pipelines = memoryPipelines();
  pipelines.execute("workspace", "owner", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  const bots = { project: { root, checks: [] }, busy: false, attempts: [] };
  const models = [{ id: "test-model", label: "Test model", provider: "Fixture", available: true, local: true, detail: "Scripted" }];
  let signalReady = () => {};
  const waiting = new Promise<void>(resolve => { signalReady = resolve; });
  let calls = 0;
  const engine = createAgentTests({ pipelines, bots: { snapshot: () => bots }, chat: {
    provider: "Fixture", model: "test-model", modelOptions: async () => models,
    loadModel: async () => ({ invoke: async () => {
      calls++;
      if (calls === 1) return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }) };
      signalReady();
      return new Promise<never>(() => {});
    } }),
  } });
  await engine.execute("workspace", "owner", ["author"], { action: "save_case", agentId: agent.id, title: "Read a source", prompt: "Read SOP.md and explain review.", expected: "Cites SOP.md", source: "SOP.md" });
  const snapshot: WorkbenchSnapshot = { workspaceId: "workspace", actor: "owner", roles: ["admin", "author"], canAuthor: true, demo: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: true }, pipelines: pipelines.snapshot("workspace"), bots };
  const start = async () => engine.execute("workspace", "owner", ["author"], { action: "run", caseId: engine.snapshot("workspace").cases[0]!.id, expectedVersion: snapshot.pipelines!.version });
  return { engine, agent, snapshot, models, waiting, start, calls: () => calls, cleanup: async () => { await engine.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("source evidence and model-call progress are visible before generation finishes", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await f.waiting;
    const state = f.engine.snapshot("workspace");
    const run = state.runs[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.calls, 2);
    assert.equal(run.sourceRead, true);
    assert.deepEqual(run.toolCalls, [{ name: "read_project_file", path: "SOP.md", outcome: "read" }]);
    const html = agentStudioPage(f.snapshot, f.agent.id, null, f.models, emptyStudioUi(), "test", state).body;
    assert.match(html, /Read SOP.md/);
    assert.doesNotMatch(html, /SOP.md was not read/);
    assert.match(html, /Waiting for provider usage/);
    assert.match(html, /Stop test/);
    const viewer = { ...f.snapshot, actor: "viewer", roles: [] as WorkbenchSnapshot["roles"], canAuthor: false };
    assert.doesNotMatch(agentStudioPage(viewer, f.agent.id, null, f.models, emptyStudioUi(), "test", state).body, /Stop test/);
  } finally { await f.cleanup(); }
});

test("cancellation is workspace scoped, authorized, and retains the source evidence", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await f.waiting;
    const runId = f.engine.snapshot("workspace").runs[0]!.id;
    await assert.rejects(f.engine.execute("elsewhere", "owner", ["admin"], { action: "cancel", runId }), /not in this workspace/);
    await assert.rejects(f.engine.execute("workspace", "another-author", ["author"], { action: "cancel", runId }), /Only the test author or an admin/);
    const stopped = await f.engine.execute("workspace", "owner", ["author"], { action: "cancel", runId });
    assert.equal(stopped.busy, false);
    assert.equal(stopped.runs[0]!.status, "cancelled");
    assert.match(stopped.runs[0]!.error, /Stopped by a workspace operator/);
    assert.doesNotMatch(stopped.runs[0]!.error, /second limit/);
    assert.equal(stopped.runs[0]!.sourceRead, true);
    assert.equal(stopped.runs[0]!.summary, "");
    await assert.rejects(f.engine.execute("workspace", "owner", ["admin"], { action: "cancel", runId }), /no longer running/);
  } finally { await f.cleanup(); }
});

test("server shutdown is reported as an interruption instead of a timeout", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await f.waiting; await f.engine.close();
    const run = f.engine.snapshot("workspace").runs[0]!;
    assert.equal(run.status, "cancelled");
    assert.match(run.error, /application restarted or stopped/);
    assert.doesNotMatch(run.error, /second limit/);
  } finally { await f.cleanup(); }
});

test("impossible source-read budgets fail before a model call and disable the run control", async () => {
  const f = await fixture(1);
  try {
    await assert.rejects(f.start(), /at least 1 tool call and 2 model calls/);
    assert.equal(f.calls(), 0);
    const html = agentStudioPage(f.snapshot, f.agent.id, null, f.models, emptyStudioUi(), "test", f.engine.snapshot("workspace")).body;
    assert.match(html, /Fix tools or limits/);
    assert.match(html, /disabled>Run test/);
  } finally { await f.cleanup(); }
});

test("preparation names missing dependencies and keeps the new test form collapsed", async () => {
  const f = await fixture();
  try {
    const missing = { ...f.snapshot, bots: { ...f.snapshot.bots!, project: null } };
    const html = agentStudioPage(missing, f.agent.id, null, [], emptyStudioUi(), "test", f.engine.snapshot("workspace")).body;
    assert.match(html, /Not connected/);
    assert.match(html, /Connect repository/);
    assert.match(html, /availability is not a performance test/);
    assert.match(html, /class="agent-test-compose" ><summary>Add test case/);
    assert.match(html, /disabled>Run test/);
  } finally { await f.cleanup(); }
});
