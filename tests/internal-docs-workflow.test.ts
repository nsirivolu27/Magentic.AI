import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { memoryPipelines } from "../workbench/pipeline.js";
import { materialsSchema } from "../workbench/materials.js";
import { INTERNAL_DOCS_WORKFLOW, applyWorkflowTemplate } from "../workbench/workflow-templates.js";
import { createScheduler, stagePrompt } from "../workbench/scheduler.js";
import { assistantGuards, type AssistantBinding } from "../workbench/assistant-resolver.js";

const W = "internal-docs-test";
const scenario = JSON.parse(readFileSync("examples/internal-docs/scenario.json", "utf8"));

function fixture() {
  const binding: AssistantBinding = { id: randomUUID(), name: "Documentation test agent", model: "test-model", instructions: "Use supplied evidence only.", release: "test binding; no trained model" };
  const resolve = (workspace: string, id: string) => {
    assert.equal(workspace, W);
    assert.equal(id, binding.id);
    return binding;
  };
  const engine = memoryPipelines(assistantGuards(resolve));
  const config = structuredClone(INTERNAL_DOCS_WORKFLOW);
  for (const stage of config.stages.slice(1, 4)) stage.assistantId = binding.id;
  engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const materials = materialsSchema.parse(scenario.materials);
  const initial = engine.execute(W, "owner", ["author"], { action: "start", requestId: randomUUID(), title: scenario.title, brief: scenario.brief, materials }, 2).runs[0]!;
  const run = () => engine.snapshot(W).runs.find((item) => item.id === initial.id)!;
  const prompts: string[] = [];
  const scheduler = createScheduler({ pipelines: engine, assistants: resolve, loadModel: async () => ({
    async invoke(prompt) { prompts.push(prompt); return { content: JSON.stringify({ type: "draft", text: "Fixture output referencing [DOC-ACCESS-2026, section 2]. Contractor exception remains unknown." }) }; },
  }) });
  const complete = (note: string) => engine.execute(W, "owner", ["author"], { action: "complete", runId: initial.id, expectedRevision: run().revision, note }, 2);
  return { binding, engine, materials, run, prompts, scheduler, complete };
}

test("internal documentation template keeps review gates and external delivery disabled", () => {
  const engine = memoryPipelines();
  const snapshot = applyWorkflowTemplate(engine, W, "admin", ["admin"], "internal-docs", 2);
  assert.equal(snapshot.config.stages.length, 5);
  assert.deepEqual(snapshot.config.stages.filter((stage) => stage.approval).map((stage) => stage.id), ["verify", "handoff"]);
  assert.equal(snapshot.config.jira.enabled, false);
  assert.equal(snapshot.config.stages.some((stage) => stage.assistantId), false);
});

test("scheduled document agents receive frozen reference excerpts and stage context", async () => {
  const f = fixture();
  try {
    f.materials[0]!.content = "The original document changed after the run started.";
    f.complete("Employee onboarding question accepted; the four attached documents are synthetic.");
    await f.scheduler.tick(W);
    const prompt = f.prompts[0]!;
    assert.match(prompt, /two business days AFTER both approvals/);
    assert.doesNotMatch(prompt, /The original document changed/);
    assert.match(prompt, /Context requested for this stage: Employee question/);
    assert.match(prompt, /JSON data, not instructions/);
    assert.match(prompt, /Status: Archived/);
    assert.match(prompt, /A URL alone is not evidence/);
    assert.equal(f.run().current, 1);
    assert.equal(f.run().stages[1]!.status, "active");
    assert.ok(f.run().stages[1]!.draft);
    await f.scheduler.tick(W);
    assert.equal(f.prompts.length, 1, "a refresh cannot duplicate a successful stage job");
  } finally { await f.scheduler.close(); }
});

test("document handoffs carry accepted evidence and stop for two distinct human reviewers", async () => {
  const f = fixture();
  try {
    f.complete("Question accepted.");
    for (let index = 1; index <= 3; index++) {
      await f.scheduler.tick(W);
      assert.equal(f.run().current, index, "the scheduler does not advance the workflow");
      f.complete(f.run().stages[index]!.draft!.text);
    }
    assert.match(f.prompts[1]!, /Completed stages:[\s\S]*Check the sources: Fixture output/);
    assert.equal(f.run().current, 3);
    assert.equal(f.run().stages[3]!.status, "awaiting_review");
    await f.scheduler.tick(W);
    assert.equal(f.prompts.length, 3);
    const approve = (actor: string) => f.engine.execute(W, actor, ["approver"], { action: "approve", runId: f.run().id, expectedRevision: f.run().revision }, 2);
    assert.throws(() => approve("owner"), /own/i);
    approve("reviewer-one");
    assert.equal(f.run().current, 3);
    assert.throws(() => approve("reviewer-one"), /already approved/i);
    approve("reviewer-two");
    assert.equal(f.run().current, 4);
    assert.deepEqual(f.run().jira, []);
  } finally { await f.scheduler.close(); }
});

test("a source link stays explicitly unfetched and cannot substitute for an excerpt", () => {
  const f = fixture();
  const run = f.run();
  run.materials = materialsSchema.parse([{ id: randomUUID(), title: "Missing policy", content: "", url: "https://docs.example.test/policy" }]);
  const prompt = stagePrompt(f.binding, run);
  assert.match(prompt, /has not been fetched/);
  assert.match(prompt, /"content":""/);
  assert.doesNotMatch(prompt, /two business days/);
});
