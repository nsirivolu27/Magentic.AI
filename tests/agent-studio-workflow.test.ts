import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createAgentDemo, DEMO_MEMBERS, DEMO_TASK, DEMO_SOP, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { agentReadiness } from "../workbench/agent-studio.js";
import { agentStudioPage } from "../workbench/agent-studio-view.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable } from "../workbench/agent-configurables.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { botTimeline } from "../workbench/bot-view.js";
import { workProgress } from "../workbench/workspace-view.js";
import type { ChatAccess } from "../workbench/chat-access.js";

const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Reader", purpose: "Read the SOP", model: "test-model", instructions: "Cite SOP.md.",
  bot: { kind: "planner", maxSteps: 3, timeoutSeconds: 30, allowedTools: ["read_project_file"], maxToolCalls: 1 } });
const models = [{ id: agent.model, label: agent.model, provider: "Test", available: true, local: true, detail: "Fixture" }];
function setup() {
  const engine = memoryPipelines();
  const config = applyConfigurable(saveConfigurable(DEFAULT_PIPELINE, agent), agent.id, DEFAULT_PIPELINE.stages[0]!.id);
  const pipelines = engine.execute("one", "operator", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "one", actor: "operator", roles: ["admin", "author"], canAuthor: true, demo: false,
    workflow: DEFAULT_WORKFLOW, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: true }, pipelines,
    bots: { project: { root: "test-repository", checks: [] }, attempts: [], busy: false } };
  return { engine, snapshot, pipelines };
}

test("studio readiness detects missing models, repository, stale assignments and validation commands", () => {
  const { snapshot } = setup();
  assert.equal(agentReadiness(snapshot, agent, models).ready, true);
  assert.equal(agentReadiness(snapshot, agent, []).ready, false);
  const withoutBots = { ...snapshot }; delete withoutBots.bots;
  assert.equal(agentReadiness(withoutBots, agent, models).ready, false);
  assert.equal(agentReadiness({ ...snapshot, bots: { ...snapshot.bots!, busy: true } }, agent, models).ready, false);
  assert.equal(agentReadiness(snapshot, { ...agent, instructions: "Changed" }, models).ready, false);
  const validator = { ...agent, bot: { ...agent.bot, kind: "validator" as const } };
  snapshot.pipelines!.config = applyConfigurable(saveConfigurable(snapshot.pipelines!.config, validator), validator.id, DEFAULT_PIPELINE.stages[0]!.id);
  assert.equal(agentReadiness(snapshot, validator, models).ready, false);
  snapshot.bots!.project!.checks = [{ executable: "node", args: ["--test"] }];
  assert.equal(agentReadiness(snapshot, validator, models).ready, true);
});

test("studio starts freeze the reviewed configuration and retries cannot switch versions", () => {
  const { engine, pipelines } = setup();
  const input = { action: "start", requestId: randomUUID(), configurableId: agent.id, expectedVersion: pipelines.version, ...DEMO_TASK };
  const started = engine.execute("one", "operator", ["author"], input, 2).runs[0]!;
  engine.execute("one", "operator", ["admin"], { action: "configure", expectedVersion: pipelines.version, config: saveConfigurable(pipelines.config, { ...agent, instructions: "Changed" }) }, 2);
  assert.equal(engine.execute("one", "operator", ["author"], input, 2).runs.length, 1);
  assert.throws(() => engine.execute("one", "operator", ["author"], { ...input, expectedVersion: 3 }, 2), /another workflow version/);
  assert.throws(() => engine.execute("one", "operator", ["author"], { ...input, requestId: randomUUID() }, 2), /Workflow changed/);
  assert.throws(() => engine.execute("one", "operator", ["author"], { ...input, requestId: randomUUID(), expectedVersion: 3 }, 2), /Assign the saved agent/);
  assert.throws(() => engine.execute("two", "operator", ["admin"], { ...input, expectedVersion: 1 }, 2), /Assign the saved agent/);
  assert.throws(() => engine.execute("one", "reviewer", ["approver"], input, 2), /author or admin/);
  assert.equal(started.config.stages[0]!.instructions, agent.instructions);
  assert.equal(started.requiredApprovals, 2);
});

test("studio offers an actionable task form and keeps historical runs tied to saved definitions", () => {
  const { snapshot, engine, pipelines } = setup();
  snapshot.pipelines = engine.execute("one", "operator", ["author"], { action: "start", requestId: randomUUID(), expectedVersion: pipelines.version, configurableId: agent.id, ...DEMO_TASK }, 2);
  const ui = emptyStudioUi();
  ui.drafts[`agent-trial:${agent.id}`] = { title: '<script>unsafe</script>', brief: "Check a known source." };
  const html = agentStudioPage(snapshot, agent.id, null, models, ui).body;
  assert.match(html, /id="agent-studio-start"/);
  assert.match(html, /Recent runs/);
  assert.match(html, /href="#\/desk\//);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /single local owner cannot approve/);
  const withoutBots = { ...snapshot }; delete withoutBots.bots;
  assert.match(agentStudioPage(withoutBots, agent.id, null, models, ui).body, /disabled>Start workflow/);
});

test("scripted demo reads through MCP, records checks and completes only after two independent approvals", { timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-agent-demo-test-"));
  const demo = await createAgentDemo(directory);
  const server = createWorkbenchServer({ ...demo, assets: new Map(), demo: true,
    chatAccess: { configuration: async () => { throw new Error("Personal chat credentials must not be consulted by Agent Studio."); } } as unknown as ChatAccess,
    authenticate: async request => {
      const actor = request.headers.authorization?.replace(/^Bearer /, "");
      return actor && DEMO_MEMBERS.some(member => member.actor === actor) ? { workspaceId: DEMO_WORKSPACE, actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const actor = DEMO_MEMBERS[0]!.actor;
  async function post(path: string, body: unknown, as = actor, expected = 200) {
    const response = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as { error?: string };
    assert.equal(response.status, expected, result.error);
    return result;
  }
  const run = () => demo.pipelines.snapshot(DEMO_WORKSPACE).runs[0]!;
  try {
    const catalog = await fetch(base + "/api/agent-studio/models", { headers: { Authorization: `Bearer ${actor}` } });
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json() as { models: string[] }).models, [demo.chat.model]);
    assert.equal((await fetch(base + "/api/agent-studio/models")).status, 401);
    await post("/api/pipeline", { action: "start", expectedVersion: 2, configurableId: demo.agents[0]!.id, requestId: randomUUID(), ...DEMO_TASK });
    for (let stage = 0; stage < 2; stage++) {
      await post("/api/bots", { action: "start", runId: run().id, expectedRevision: run().revision, requestId: randomUUID() });
      const until = Date.now() + 20_000;
      while (demo.bots.busy(DEMO_WORKSPACE) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(demo.bots.busy(DEMO_WORKSPACE), false);
      const attempt = demo.bots.snapshot(DEMO_WORKSPACE).attempts.at(-1)!;
      assert.equal(attempt.status, "ready", attempt.error);
      assert.equal(attempt.calls, 2);
      assert.equal(attempt.tokenUsage, null, "scripted responses must not invent token counts");
      assert.ok(attempt.events.some(event => event.message === "MCP tool: read_project_file"));
      assert.match(attempt.summary, /two business days/);
      assert.equal(attempt.changes.length, 0);
      assert.match(workProgress(run(), demo.bots.snapshot(DEMO_WORKSPACE), actor, DEMO_MEMBERS[0]!.roles), /Run validation checks/);
      const target = { attemptId: attempt.id, expectedHash: attempt.proposalHash };
      await post("/api/bots", { action: "accept", ...target, expectedHash: "changed" }, actor, 409);
      await post("/api/bots", { action: "checks", ...target });
      assert.ok(demo.bots.snapshot(DEMO_WORKSPACE).attempts.at(-1)!.checks[0]!.passed);
      await post("/api/bots", { action: "accept", ...target });
    }
    assert.equal(run().status, "running");
    assert.equal(run().stages[1]!.status, "awaiting_review");
    const approve = () => ({ action: "approve", runId: run().id, expectedRevision: run().revision });
    await post("/api/pipeline", approve(), actor, 403);
    await post("/api/pipeline", approve(), DEMO_MEMBERS[1]!.actor);
    assert.equal(run().status, "running");
    await post("/api/pipeline", approve(), DEMO_MEMBERS[1]!.actor, 409);
    await post("/api/pipeline", approve(), DEMO_MEMBERS[2]!.actor);
    assert.equal(run().status, "complete");
    assert.equal(run().stages[1]!.approvals.length, 2);
    assert.equal(readFileSync(join(demo.root, "SOP.md"), "utf8"), DEMO_SOP);
    assert.equal(demo.pipelines.snapshot("another-workspace").runs.length, 0);
    const snapshot = demo.bots.snapshot(DEMO_WORKSPACE);
    snapshot.attempts.at(-1)!.tokenUsage = { promptTokens: 120, completionTokens: 45 };
    assert.match(botTimeline(snapshot, run()), /120 input · 45 output tokens \(reported\)/);
    assert.match(botTimeline(snapshot, run()), /Cost unavailable/);
    assert.match(workProgress(run(), snapshot, actor, DEMO_MEMBERS[0]!.roles), /120 input · 45 output tokens \(reported\)/);
  } finally {
    await demo.bots.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scripted fixture refuses other model IDs and does not fabricate usage", async () => {
  const chat = scriptedDemoChat();
  await assert.rejects(chat.loadModel("other-model"), /scripted demo model/);
  const model = await chat.loadModel();
  const response = await model.invoke("OBSERVATIONS: []");
  assert.equal(response.usage, undefined);
  assert.equal(JSON.parse(String(response.content)).name, "read_project_file");
});
