import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { addCanvasAgent, canvasAgents, createCanvasDraft, moveCanvasStage, removeCanvasStage, editCanvasStage, canvasSaveCommand } from "../workbench/workflow-canvas.js";
import { workforceTemplates, installWorkforceAgents } from "../workbench/workforce-marketplace.js";
import { DEFAULT_PIPELINE, memoryPipelines, pipelineSchema } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { workflowCanvasPage } from "../workbench/workflow-canvas-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const template = workforceTemplates.find(item => item.slug === "knowledge")!;

test("dropping a marketplace agent copies its policy, connects at the chosen position and adds a review gate", () => {
  const base = structuredClone(DEFAULT_PIPELINE);
  const next = addCanvasAgent(base, template.definition.id, "agent-one", 1);
  assert.equal(next.stages[1]!.agent, template.definition.name);
  assert.equal(next.stages[1]!.approval, true);
  assert.deepEqual(next.stages[1]!.bot, template.definition.bot);
  assert.deepEqual(next.stages.filter(item => item.id !== "agent-one"), base.stages);
  assert.deepEqual(next.jira, base.jira);
  assert.equal(base.configurables, undefined);
  assert.equal(next.configurables?.length, 1);
  assert.doesNotThrow(() => pipelineSchema.parse(next));
  next.stages[1]!.instructions = "Changed stage only";
  assert.notEqual(next.configurables![0]!.instructions, next.stages[1]!.instructions);
});

test("saved company definitions win over catalogue defaults and repeated nodes stay independent", () => {
  const installed = installWorkforceAgents(DEFAULT_PIPELINE, [template.slug]);
  installed.configurables![0]!.model = "company-model";
  const once = addCanvasAgent(installed, template.definition.id, "agent-one", 0);
  const twice = addCanvasAgent(once, template.definition.id, "agent-two", 2);
  assert.equal(twice.stages[0]!.model, "company-model");
  assert.equal(twice.stages[2]!.model, "company-model");
  assert.equal(twice.configurables!.length, 1);
  assert.equal(canvasAgents(twice).filter(item => item.agent.id === template.definition.id).length, 1);
  assert.throws(() => addCanvasAgent(twice, randomUUID(), "agent-three", 0), /Choose an agent/);
});

test("canvas connections form one bounded sequence and never duplicate or lose stages", () => {
  const base = structuredClone(DEFAULT_PIPELINE);
  const moved = moveCanvasStage(base, base.stages[0]!.id, base.stages.length);
  assert.deepEqual(moved.stages.at(-1), base.stages[0]);
  assert.deepEqual(moveCanvasStage(moved, base.stages[0]!.id, 0), base);
  assert.deepEqual(moveCanvasStage(base, base.stages[0]!.id, 1), base);
  for (const position of [-1, 100, 0.5]) {
    assert.throws(() => moveCanvasStage(base, base.stages[0]!.id, position), /connection/);
    assert.throws(() => addCanvasAgent(base, template.definition.id, "agent-one", position), /connection/);
  }
  assert.throws(() => addCanvasAgent(base, template.definition.id, base.stages[0]!.id, 0), /unique/);
  let full = base;
  while (full.stages.length < 12) full = addCanvasAgent(full, template.definition.id, `agent-${full.stages.length}`, 0);
  assert.throws(() => addCanvasAgent(full, template.definition.id, "agent-more", 0), /12 stages/);
});

test("stage edits retain gates and limits, and protected stages cannot be removed or rebound", () => {
  const base = addCanvasAgent(DEFAULT_PIPELINE, template.definition.id, "agent-one", 0);
  const edited = editCanvasStage(base, "agent-one", { name: "Read policy", model: "company-model", instructions: "Read authorized policy.", context: "Attached SOP" });
  assert.equal(edited.stages[0]!.approval, true);
  assert.deepEqual(edited.stages[0]!.bot, base.stages[0]!.bot);
  assert.equal(edited.stages[0]!.jiraStatus, base.stages[0]!.jiraStatus);
  assert.throws(() => removeCanvasStage(edited, "agent-one"), /Review gates/);
  assert.deepEqual(removeCanvasStage(base, "agent-one", DEFAULT_PIPELINE).stages, DEFAULT_PIPELINE.stages);
  const bound = structuredClone(DEFAULT_PIPELINE);
  bound.stages[0]!.assistantId = randomUUID();
  assert.throws(() => editCanvasStage(bound, bound.stages[0]!.id, bound.stages[0]!), /approved assistant/);
  assert.throws(() => removeCanvasStage(bound, bound.stages[0]!.id), /approved assistant/);
  assert.equal(removeCanvasStage(DEFAULT_PIPELINE, DEFAULT_PIPELINE.stages[0]!.id).stages.length, DEFAULT_PIPELINE.stages.length - 1);
});

test("canvas saves are scoped and versioned and leave existing runs and other companies unchanged", () => {
  const engine = memoryPipelines();
  engine.execute("company-a", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Existing work", brief: "Retain this workflow." }, 2);
  const before = engine.snapshot("company-a");
  const draft = createCanvasDraft("company-a", "admin", before);
  draft.config = addCanvasAgent(draft.config, template.definition.id, "agent-one", 0);
  assert.throws(() => canvasSaveCommand(draft, "company-b", "admin", before), /another workspace/);
  assert.throws(() => canvasSaveCommand(draft, "company-a", "other", before), /another workspace/);
  const command = canvasSaveCommand(draft, "company-a", "admin", before);
  assert.throws(() => engine.execute("company-a", "reader", ["author"], command, 2), /admin/i);
  const saved = engine.execute("company-a", "admin", ["admin"], command, 2);
  assert.deepEqual(saved.runs, before.runs);
  assert.deepEqual(engine.snapshot("company-b").config, DEFAULT_PIPELINE);
  assert.throws(() => canvasSaveCommand(draft, "company-a", "admin", saved), /changed elsewhere/);
  assert.throws(() => engine.execute("company-a", "admin", ["admin"], command, 2), /changed/);
});

test("canvas exposes keyboard controls, escapes names and distinguishes design from execution", () => {
  const pipeline = memoryPipelines().snapshot("company");
  const state: WorkbenchSnapshot = { workspaceId: "company", actor: "reader", roles: ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, pipelines: pipeline, records: [], audit: [], demo: false,
    mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  const draft = createCanvasDraft("company", "reader", pipeline);
  draft.config.stages[0]!.name = '<img src=x onerror="bad">';
  const page = workflowCanvasPage(state, draft, "", []);
  assert.doesNotMatch(page.body, /<img/);
  assert.match(page.body, /draggable="false"/);
  assert.match(page.body, /Insert agent at connection/);
  assert.match(page.body, /Move .* up/);
  assert.match(page.body, /data-canvas-save disabled/);
  assert.match(page.body, /isolated worker/);
});
