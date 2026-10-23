import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentConfigurableSchema, applyConfigurable } from "../workbench/agent-configurables.js";
import { agentHash, blockingTestReviews, passedCurrentTest, testRunSchema, type AgentTestRun } from "../workbench/agent-tests-model.js";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { agentStudioPage, nextAction } from "../workbench/agent-studio-view.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Documentation agent", purpose: "Answer from recorded evidence.",
  model: "test-model", instructions: "Read the source and cite it.",
  bot: { kind: "planner", allowedTools: ["read_project_file"], maxSteps: 4, maxToolCalls: 2, timeoutSeconds: 30 } });
const caseId = randomUUID();
function run(verdict?: "pass" | "fail" | "unsure", overrides: Partial<AgentTestRun> = {}): AgentTestRun {
  return testRunSchema.parse({ id: randomUUID(), workspaceId: "one", caseId, agentId: agent.id,
    agentHash: agentHash(agent), agentName: agent.name, model: agent.model, prompt: "Who approves?", expected: "Cites the source.", source: "SOP.md",
    startedBy: "operator", startedAt: "2026-10-22T10:00:00Z", status: "succeeded", summary: "A draft.", error: "",
    toolCalls: [], sourceRead: false, calls: 1, tokenUsage: null, events: [],
    review: verdict ? { verdict, note: "Check citations.", by: "reviewer", at: "2026-10-22T10:01:00Z" } : undefined, ...overrides });
}

test("a recorded failure or uncertainty blocks assignment even when execution succeeded", () => {
  assert.equal(passedCurrentTest(agent, { runs: [run()] }), true, "unreviewed execution keeps existing behaviour");
  for (const verdict of ["fail", "unsure"] as const) {
    const rejected = run(verdict);
    assert.equal(passedCurrentTest(agent, { runs: [run("pass"), rejected, run()] }), false);
    assert.deepEqual(blockingTestReviews(agent, { runs: [rejected, run()] }).map(item => item.id), [rejected.id]);
  }
});

test("only a later successful, reviewed run of the same case clears a rejection", () => {
  const rejected = run("fail");
  for (const replacement of [run(), run("pass", { caseId: randomUUID() }), run("pass", { prompt: "An easier question" }),
    run("pass", { expected: "" }), run("pass", { source: "" }), run("pass", { status: "failed" })]) {
    assert.equal(passedCurrentTest(agent, { runs: [rejected, replacement] }), false);
  }
  assert.equal(passedCurrentTest(agent, { runs: [rejected, run("pass")] }), true);
  assert.equal(passedCurrentTest(agent, { runs: [run("pass"), rejected] }), false);
});

test("every rejected case must be resolved and evidence stays bound to the agent version", () => {
  const secondCase = randomUUID();
  const first = run("fail");
  const second = run("unsure", { caseId: secondCase });
  assert.equal(passedCurrentTest(agent, { runs: [first, second, run("pass")] }), false);
  assert.equal(passedCurrentTest(agent, { runs: [first, second, run("pass"), run("pass", { caseId: secondCase })] }), true);
  assert.equal(passedCurrentTest(agent, { runs: [run("pass", { agentHash: "000000000000" })] }), false);
  assert.equal(passedCurrentTest(agent, { runs: [run("fail", { agentHash: "000000000000" }), run()] }), true);
  assert.equal(passedCurrentTest(agent, { runs: [run("fail", { agentId: randomUUID() }), run()] }), true);
});

test("the API and Studio refuse a rejected agent until its case passes review, without changing existing runs", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-review-gate-"));
  const demo = await createAgentDemo(directory, scriptedDemoChat());
  const operator = DEMO_MEMBERS[0]!;
  const reviewer = DEMO_MEMBERS[1]!;
  const server = createWorkbenchServer({ ...demo, assets: new Map(), demo: true,
    authenticate: async request => request.headers.authorization === "Bearer operator"
      ? { workspaceId: DEMO_WORKSPACE, actor: operator.actor } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  try {
    const pipeline = demo.pipelines.snapshot(DEMO_WORKSPACE);
    const selected = pipeline.config.configurables![1]!;
    const testCase = demo.agentTests.snapshot(DEMO_WORKSPACE).cases.find(item => item.agentId === selected.id)!;
    const proposed = applyConfigurable(pipeline.config, selected.id, pipeline.config.stages[0]!.id);
    const existing = demo.pipelines.execute(DEMO_WORKSPACE, operator.actor, operator.roles,
      { action: "start", requestId: randomUUID(), title: "Keep the saved workflow", brief: "Review the documentation." }, 2).runs[0]!;
    const execute = async () => {
      await demo.agentTests.execute(DEMO_WORKSPACE, operator.actor, operator.roles,
        { action: "run", caseId: testCase.id, expectedVersion: pipeline.version });
      await demo.agentTests.settled(DEMO_WORKSPACE);
      const result = demo.agentTests.snapshot(DEMO_WORKSPACE).runs.at(-1)!;
      assert.equal(result.status, "succeeded", result.error);
      return result;
    };
    const configure = () => fetch(base + "/api/pipeline", { method: "POST",
      headers: { Authorization: "Bearer operator", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "configure", expectedVersion: pipeline.version, config: proposed }) });
    const rejected = await execute();
    await demo.agentTests.execute(DEMO_WORKSPACE, reviewer.actor, reviewer.roles,
      { action: "review", runId: rejected.id, verdict: "fail", note: "<b>Missing citation</b>" });
    const response = await configure();
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /Quality review blocks assignment/);
    assert.equal(demo.pipelines.snapshot(DEMO_WORKSPACE).version, pipeline.version);

    const snapshot: WorkbenchSnapshot = { workspaceId: DEMO_WORKSPACE, actor: operator.actor, roles: [...operator.roles], canAuthor: true,
      workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, pipelines: pipeline, chat: { configured: true } };
    const models = [{ id: selected.model, label: selected.model, provider: "Scripted", available: true, local: true, detail: "" }];
    const tests = demo.agentTests.snapshot(DEMO_WORKSPACE);
    const html = agentStudioPage(snapshot, selected.id, null, models, emptyStudioUi(), "workflow", tests).body;
    assert.match(html, /disabled>Assign saved agent/);
    assert.match(html, /Quality review blocks assignment/);
    assert.match(html, /&lt;b&gt;Missing citation&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>Missing citation/);
    assert.equal(nextAction(snapshot, selected, models, tests).label, "Resolve review and retest");

    const rerun = await execute();
    assert.equal((await configure()).status, 409, "an unreviewed rerun cannot clear rejection");
    await demo.agentTests.execute(DEMO_WORKSPACE, reviewer.actor, reviewer.roles,
      { action: "review", runId: rerun.id, verdict: "pass", note: "Evidence checked." });
    const accepted = await configure();
    assert.equal(accepted.status, 200, await accepted.text());
    assert.deepEqual(demo.pipelines.snapshot(DEMO_WORKSPACE).runs.find(item => item.id === existing.id), existing);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await demo.agentTests.close(); await demo.bots.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
