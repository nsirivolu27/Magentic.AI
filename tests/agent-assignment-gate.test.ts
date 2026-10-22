import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "../workbench/agent-demo-fixture.js";
import { applyConfigurable, newlyAssigned } from "../workbench/agent-configurables.js";
import { passedCurrentTest } from "../workbench/agent-tests-model.js";
import { agentStudioPage } from "../workbench/agent-studio-view.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

/**
 * An agent version that has not passed a saved test cannot be assigned to a
 * workflow stage. The studio disables the control and the server refuses the
 * configure command, so the rule holds for any client.
 */

const operator = DEMO_MEMBERS[0]!.actor;
const roles = DEMO_MEMBERS[0]!.roles;

test("assignment waits for a passing test on the current version, in the page and on the server", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-assign-gate-"));
  const d = await createAgentDemo(directory, scriptedDemoChat());
  const server = createWorkbenchServer({ ...d, assets: new Map(), demo: true,
    authenticate: async request => {
      const actor = request.headers.authorization?.replace(/^Bearer /, "");
      return actor && DEMO_MEMBERS.some(member => member.actor === actor) ? { workspaceId: DEMO_WORKSPACE, actor } : undefined;
    } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const configure = (config: unknown, expectedVersion: number) => fetch(`${base}/api/pipeline`, { method: "POST",
    headers: { Authorization: `Bearer ${operator}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "configure", expectedVersion, config }) });
  try {
    const pipelines = d.pipelines.snapshot(DEMO_WORKSPACE);
    const tests = d.agentTests.snapshot(DEMO_WORKSPACE);
    // The second seeded agent has a case but no run yet.
    const agent = pipelines.config.configurables!.find(item => !tests.runs.some(run => run.agentId === item.id))!;
    const stage = pipelines.config.stages.find(item => !item.assistantId && item.agent !== agent.name)!;
    assert.equal(passedCurrentTest(agent, tests), false);

    const snapshot: WorkbenchSnapshot = { workspaceId: DEMO_WORKSPACE, actor: operator, roles, canAuthor: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true,
      pipelines, chat: { configured: true, model: agent.model } } as unknown as WorkbenchSnapshot;
    const models = [{ id: agent.model, label: agent.model, provider: "Scripted", available: true, local: true, detail: "", outputLimit: false }];
    const page = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "workflow", tests).body;
    assert.match(page, /Run a passing test on this version before assigning/);
    assert.match(page, /disabled>Assign saved agent/);

    const proposed = applyConfigurable(pipelines.config, agent.id, stage.id);
    assert.deepEqual(newlyAssigned(pipelines.config, proposed).map(item => item.id), [agent.id]);
    const refused = await configure(proposed, pipelines.version);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /passing test/);

    // Run the seeded case for this agent; once it passes, the same assignment goes through.
    const testCase = tests.cases.find(item => item.agentId === agent.id)!;
    await d.agentTests.execute(DEMO_WORKSPACE, operator, roles, { action: "run", caseId: testCase.id, expectedVersion: pipelines.version });
    await d.agentTests.settled(DEMO_WORKSPACE);
    const after = d.agentTests.snapshot(DEMO_WORKSPACE);
    assert.equal(after.runs.find(run => run.agentId === agent.id)?.status, "succeeded");
    assert.equal(passedCurrentTest(agent, after), true);
    const enabled = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "workflow", after).body;
    assert.doesNotMatch(enabled, /disabled>Assign saved agent/);
    const accepted = await configure(proposed, d.pipelines.snapshot(DEMO_WORKSPACE).version);
    assert.equal(accepted.status, 200, await accepted.text());
    // Re-saving the same assignment is not a new assignment and is not gated.
    const again = await configure(proposed, d.pipelines.snapshot(DEMO_WORKSPACE).version);
    assert.equal(again.status, 200);
  } finally {
    server.close(); server.closeAllConnections();
    await d.agentTests.close(); await d.bots.close(); rmSync(directory, { recursive: true, force: true });
  }
});
