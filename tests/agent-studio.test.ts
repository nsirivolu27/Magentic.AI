import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { importAgentDefinition, exportAgentDefinition } from "../workbench/agent-studio.js";
import { agentStudioPage } from "../workbench/agent-studio-view.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable } from "../workbench/agent-configurables.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function definition() {
  return agentConfigurableSchema.parse({ id: randomUUID(), name: "Code reviewer", purpose: "Review changes against the brief.",
    model: "local-test-model", instructions: "Read the diff and report findings with file references.",
    bot: { kind: "reviewer", maxSteps: 4, timeoutSeconds: 60, maxToolCalls: 3, allowedTools: ["project_diff"] } });
}
function fixture(admin = true) {
  const agent = definition();
  const engine = memoryPipelines();
  const pipelines = engine.execute("workspace", "operator", ["admin"], { action: "configure", expectedVersion: 1, config: saveConfigurable(DEFAULT_PIPELINE, agent) }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "workspace", actor: "operator", roles: admin ? ["admin"] : ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, pipelines, records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  return { agent, engine, snapshot, pipelines };
}

test("portable definitions retain explicit permissions and import under a new identity", () => {
  const original = definition();
  const copied = importAgentDefinition(exportAgentDefinition(original), randomUUID());
  assert.notEqual(copied.id, original.id);
  assert.deepEqual(copied.bot, original.bot);
  assert.equal(copied.instructions, original.instructions);
  assert.deepEqual(saveConfigurable(saveConfigurable(DEFAULT_PIPELINE, original), copied).configurables?.map(agent => agent.id), [original.id, copied.id]);
});

test("imports refuse executable tools, unknown fields, excessive input and implicit access", () => {
  const agent = definition();
  for (const raw of [{ ...agent, approved: true }, { ...agent, bot: { ...agent.bot, allowedTools: ["shell"] } },
    { ...agent, bot: { ...agent.bot, allowedTools: undefined } }]) assert.throws(() => importAgentDefinition(JSON.stringify(raw), randomUUID()), /Check agent fields/);
  assert.throws(() => importAgentDefinition("x".repeat(20_001), randomUUID()), /20,000/);
  assert.throws(() => importAgentDefinition("invalid private content", randomUUID()), /valid agent JSON/);
});

test("agent studio keeps role enforcement and stale-write protection on the server", () => {
  const { engine, pipelines } = fixture();
  const config = saveConfigurable(pipelines.config, definition());
  assert.throws(() => engine.execute("workspace", "writer", ["author"], { action: "configure", expectedVersion: pipelines.version, config }, 2), /admin/i);
  engine.execute("workspace", "operator", ["admin"], { action: "configure", expectedVersion: pipelines.version, config }, 2);
  assert.throws(() => engine.execute("workspace", "operator", ["admin"], { action: "configure", expectedVersion: pipelines.version, config: pipelines.config }, 2), /changed/i);
  assert.equal(engine.snapshot("another-workspace").config.configurables, undefined);
});

test("assignment preserves a running workflow and independent review gates", () => {
  const { agent, engine, pipelines } = fixture();
  const started = engine.execute("workspace", "writer", ["author"], { action: "start", requestId: randomUUID(), title: "Review a change", brief: "Inspect the implementation and evidence." }, 2);
  const before = structuredClone(started.runs[0]);
  const config = applyConfigurable(pipelines.config, agent.id, pipelines.config.stages[0]!.id);
  const after = engine.execute("workspace", "operator", ["admin"], { action: "configure", expectedVersion: pipelines.version, config }, 2);
  assert.deepEqual(after.runs[0], before);
  assert.equal(config.stages[0]!.approval, pipelines.config.stages[0]!.approval);
  assert.equal(config.stages[0]!.context, pipelines.config.stages[0]!.context);
});

test("the creation page escapes content and preserves unsaved access choices and version", () => {
  const { snapshot, agent } = fixture();
  const ui = emptyStudioUi();
  ui.drafts[`agent-studio:${agent.id}`] = { name: '<script>alert("x")</script>', tools: "", expectedVersion: "1" };
  const html = agentStudioPage(snapshot, agent.id, null, [], ui).body;
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-version="1"/);
  assert.doesNotMatch(html, /name="tools"[^>]*checked/);
  assert.match(html, /not connected/);
  assert.match(html, /Execution limits/);
  assert.match(html, /not an approved model release/);
  assert.match(html, /Additional external servers are not connected/);
});

test("read-only viewers cannot edit or assign and missing agents never open a new draft", () => {
  const { snapshot, agent } = fixture(false);
  const html = agentStudioPage(snapshot, agent.id, null, [], emptyStudioUi()).body;
  assert.match(html, /<fieldset disabled>/);
  assert.match(html, /disabled>Assign saved agent/);
  const library = agentStudioPage(snapshot, undefined, null, [], emptyStudioUi());
  assert.doesNotMatch(library.body, /agent-studio-import/);
  assert.equal(library.actions, "");
  const missing = agentStudioPage(snapshot, randomUUID(), null, [], emptyStudioUi()).body;
  assert.match(missing, /not in this workspace/);
  assert.doesNotMatch(missing, /agent-studio-editor/);
});

test("the studio links workflow staffing and models to pages in the operations workspace", () => {
  const { snapshot, agent } = fixture();
  const library = agentStudioPage(snapshot, undefined, null, [], emptyStudioUi());
  assert.match(library.body, /Your workflow/);
  for (const stage of snapshot.pipelines!.config.stages) {
    assert.ok(library.body.includes(`href="#/workflows/${stage.id}"`));
  }
  const editor = agentStudioPage(snapshot, agent.id, null, [], emptyStudioUi());
  assert.equal(editor.title, agent.name);
  assert.match(editor.body, /href="#\/chat"/);
  assert.match(editor.body, /href="#\/desk"/);
  assert.doesNotMatch(editor.body, /href="#\/connections"/);
  assert.equal(agentStudioPage(snapshot, "new", "docs", [], emptyStudioUi()).title, "New agent");
});

test("approved-assistant stages cannot be overwritten from the assignment picker", () => {
  const { snapshot, agent } = fixture();
  const config = snapshot.pipelines!.config;
  for (const stage of config.stages) stage.assistantId = randomUUID();
  const html = agentStudioPage(snapshot, agent.id, null, [], emptyStudioUi()).body;
  assert.match(html, /name="stage" required disabled/);
  assert.match(html, /disabled>Assign saved agent/);
  assert.throws(() => applyConfigurable(config, agent.id, config.stages[0]!.id), /approved assistant/);
});
