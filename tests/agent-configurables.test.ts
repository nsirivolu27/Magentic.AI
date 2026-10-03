import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable } from "../workbench/agent-configurables.js";
import { agentTeamPage } from "../workbench/agent-team-view.js";
import { DEFAULT_PIPELINE, filePipelines, memoryPipelines, pipelineSchema } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function configurable() {
  return agentConfigurableSchema.parse({ id: randomUUID(), name: "IDPro evidence reviewer", purpose: "Review capture evidence.",
    model: "local-test-model", instructions: "Separate upload evidence from audio and physical-device claims.",
    bot: { kind: "validator", maxSteps: 3, timeoutSeconds: 30, allowedTools: [], maxToolCalls: 0 } });
}

test("configurables reject unknown keys, implicit tools and invalid execution policies", () => {
  const agent = configurable();
  for (const value of [{ ...agent, autoApprove: true }, { ...agent, bot: { ...agent.bot, allowedTools: undefined } },
    { ...agent, bot: { ...agent.bot, allowedTools: ["shell"] } }, { ...agent, bot: { ...agent.bot, kind: "manual" } },
    { ...agent, bot: { ...agent.bot, maxSteps: 0 } }]) assert.equal(agentConfigurableSchema.safeParse(value).success, false);
  const duplicate = pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, configurables: [agent, agent] });
  assert.equal(duplicate.success, false);
  if (!duplicate.success) assert.equal(duplicate.error.issues[0]!.path.join("."), "configurables.1.id");
});

test("applying an agent preserves gates, context and Jira and never replaces an approved assistant", () => {
  const agent = configurable();
  const config = saveConfigurable(DEFAULT_PIPELINE, agent);
  const original = structuredClone(config);
  const applied = applyConfigurable(config, agent.id, config.stages[0]!.id);
  const stage = applied.stages[0]!;
  assert.equal(stage.model, agent.model);
  assert.equal(stage.instructions, agent.instructions);
  assert.deepEqual(stage.bot?.allowedTools, []);
  assert.equal(stage.approval, original.stages[0]!.approval);
  assert.equal(stage.context, original.stages[0]!.context);
  assert.equal(stage.jiraStatus, original.stages[0]!.jiraStatus);
  assert.deepEqual(applied.jira, original.jira);
  assert.deepEqual(config, original);
  assert.throws(() => applyConfigurable(config, randomUUID(), stage.id), /existing agent/);
  config.stages[0]!.assistantId = randomUUID();
  assert.throws(() => applyConfigurable(config, agent.id, stage.id), /approved assistant/);
});

test("agent edits are versioned, admin-only, workspace scoped and cannot rewrite open runs", () => {
  const engine = memoryPipelines(); const agent = configurable();
  const config = applyConfigurable(saveConfigurable(DEFAULT_PIPELINE, agent), agent.id, "intake");
  const command = { action: "configure", expectedVersion: 1, config };
  assert.throws(() => engine.execute("one", "writer", ["author"], command, 2), /admin/);
  engine.execute("one", "admin", ["admin"], command, 2);
  const run = engine.execute("one", "writer", ["author"], { action: "start", requestId: randomUUID(), title: "IDPro evidence", brief: "Verify narration." }, 2).runs[0]!;
  const changed = saveConfigurable(config, { ...agent, model: "different-model" });
  engine.execute("one", "admin", ["admin"], { ...command, expectedVersion: 2, config: applyConfigurable(changed, agent.id, "intake") }, 2);
  assert.equal(engine.snapshot("one").runs[0]!.config.stages[0]!.model, agent.model);
  assert.equal(engine.snapshot("one").runs[0]!.requiredApprovals, 2);
  assert.equal(engine.snapshot("one").runs[0]!.id, run.id);
  assert.equal(engine.snapshot("two").config.configurables, undefined);
  assert.throws(() => engine.execute("one", "admin", ["admin"], command, 2), /Configuration changed/);
});

test("saved agent configurations survive reopening local workspace storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-team-"));
  const agent = configurable();
  const first = fileWorkspaceStore(directory);
  filePipelines(first).execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  first.close();
  const second = fileWorkspaceStore(directory);
  try { assert.deepEqual(filePipelines(second).snapshot("one").config.configurables, [agent]); }
  finally { second.close(); }
});

test("standalone MCP exposes configurations as supervised templates and isolates workspaces", async t => {
  const engine = memoryPipelines(); const agent = configurable();
  engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  const server = createWorkbenchServer({ assets: new Map(), pipelines: engine,
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([
      { workspaceId: "one", actor: "reader", roles: ["author"] }, { workspaceId: "two", actor: "outsider", roles: ["author"] }]) },
    authenticate: async req => req.headers.authorization === "Bearer reader" ? { workspaceId: "one", actor: "reader" }
      : req.headers.authorization === "Bearer outsider" ? { workspaceId: "two", actor: "outsider" } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  for (const actor of ["reader", "outsider"]) {
    const client = new Client({ name: "team-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/pipeline-mcp`), { requestInit: { headers: { Authorization: `Bearer ${actor}` } } }) as unknown as Parameters<typeof client.connect>[0]);
      const result = await client.callTool({ name: "get_pipeline", arguments: {} });
      const content = result.content as { type: string; text: string }[];
      const data = JSON.parse(content[0]!.text);
      assert.equal(data.agentConfigurations.length, actor === "reader" ? 1 : 0);
      if (actor === "reader") {
        assert.equal(data.agentConfigurations[0].approvedRelease, false);
        assert.equal(data.agentConfigurations[0].execution, "supervised");
        assert.deepEqual(data.agentConfigurations[0].tools.allowedTools, []);
      }
      assert.equal((await client.callTool({ name: "get_pipeline", arguments: { workspaceId: "one" } })).isError, true);
    } finally { await client.close(); }
  }
});

test("team UI escapes agent content and keeps deep settings behind a disclosure", () => {
  const agent = { ...configurable(), name: '<img src=x onerror="bad()">' };
  const engine = memoryPipelines();
  const pipelines = engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "one", actor: "reader", roles: ["author"], canAuthor: true, workflow: DEFAULT_WORKFLOW,
    pipelines, records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  const page = agentTeamPage(snapshot, agent.id, null, [], emptyStudioUi());
  assert.doesNotMatch(page.body, /<img/);
  assert.match(page.body, /&lt;img/);
  assert.match(page.body, /Tools and execution limits/);
  assert.match(page.body, /disabled>Save agent/);
  assert.match(page.body, /not connected/);
  assert.match(page.body, /not trained models/);
});
