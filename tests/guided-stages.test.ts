import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { configureStage, exampleRecords } from "../workbench/guided-stages.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { validateJsonl } from "../workbench/studio/dataset.js";
import { emptyStudioUi, studioProjectPage } from "../workbench/studio-view.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const workspace = "guided-workspace";
function fixture(): WorkbenchSnapshot {
  const studio = memoryModelStudio().execute(workspace, "alex", ["author"], {
    action: "create_project", name: "IDPro assistant", recipeId: "coding-assistant", purpose: "Explain the photo upload workflow.",
  }, 2);
  return { workspaceId: workspace, actor: "alex", roles: ["author"], canAuthor: true, studio,
    workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, records: [], audit: [], demo: true,
    mcp: { agents: [], withheld: [] }, chat: { configured: false }, pipelines: memoryPipelines().snapshot(workspace) };
}

test("plain examples preserve multiline text and quotes in both dataset formats", () => {
  const examples = [{ question: 'Why does "upload" fail?\nWhat next?', answer: "Check the response.\nDo not claim a device test passed." }];
  for (const shape of ["messages", "prompt-completion"] as const) {
    const text = exampleRecords(examples, shape);
    assert.equal(text.split("\n").length, 1);
    const report = validateJsonl(text, shape);
    assert.equal(report.passed, true);
    assert.equal(report.records, 1);
    const record = JSON.parse(text);
    assert.equal(shape === "messages" ? record.messages[0].content : record.prompt, examples[0]!.question);
  }
  assert.throws(() => exampleRecords([], "messages"), /at least one/);
  assert.throws(() => exampleRecords([{ question: "Question", answer: "  " }], "messages"), /ideal answer/);
});

test("simple entry still detects credentials and duplicates through the normal validator", () => {
  const example = { question: "Help me", answer: "password=abcdefghijklmnop12345678" };
  const report = validateJsonl(exampleRecords([example, example], "messages"), "messages");
  assert.equal(report.passed, false);
  assert.ok(report.secretFindings > 0);
  const clean = { question: "Help me", answer: "Check the response code." };
  assert.equal(validateJsonl(exampleRecords([clean, clean], "messages"), "messages").duplicates, 1);
});

test("the guide follows actual project state and separates the simple form from imports", () => {
  const snapshot = fixture();
  const id = snapshot.studio!.projects[0]!.id;
  const page = studioProjectPage(snapshot, id, "data", emptyStudioUi());
  assert.match(page.body, /aria-label="Project stages"/);
  assert.match(page.body, /data" aria-current="step"/);
  assert.match(page.body, /Add examples<\/strong><small>Next step/);
  assert.match(page.body, /Get approval<\/strong><small>Not started/);
  assert.match(page.body, /What would someone ask/);
  assert.match(page.body, /expects 50 examples for full coverage/);
  assert.match(page.body, /<summary>Import a dataset \(advanced\)<\/summary>/);
  assert.match(page.body, /<summary>Technical connections<\/summary>/);
  const later = studioProjectPage(snapshot, id, "train", emptyStudioUi());
  assert.match(later.body, /Continue: Add examples/);
  assert.match(later.actions ?? "", /disabled title="Needs a validated dataset"/);
});

test("example drafts survive navigation and escape user text", () => {
  const snapshot = fixture();
  const id = snapshot.studio!.projects[0]!.id;
  const ui = emptyStudioUi();
  ui.drafts[`examples:${id}`] = { question: "</textarea><script>bad</script>", examples: JSON.stringify([{ question: "<img src=x>", answer: "Safe answer" }]) };
  const page = studioProjectPage(snapshot, id, "data", ui);
  assert.match(page.body, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.match(page.body, /&lt;img src=x&gt;/);
  assert.doesNotMatch(page.body, /<script>bad/);
  assert.match(page.body, /Remove example 1/);
});

test("guided stage settings preserve other stages and cannot rewrite an open run", () => {
  const engine = memoryPipelines();
  const before = engine.execute(workspace, "alex", ["author"], { action: "start", requestId: randomUUID(), title: "Upload test", brief: "Check the Android upload contract." }, 2);
  const configured = configureStage(before.config, "intake", { assistantId: "", instructions: "Describe the problem and expected result.", context: "Acceptance criteria", approval: true });
  assert.deepEqual(before.config, DEFAULT_PIPELINE);
  assert.deepEqual(configured.stages.slice(1), before.config.stages.slice(1));
  assert.throws(() => engine.execute(workspace, "alex", ["author"], { action: "configure", expectedVersion: before.version, config: configured }, 2), /admin/i);
  const after = engine.execute(workspace, "taylor", ["admin"], { action: "configure", expectedVersion: before.version, config: configured }, 2);
  assert.equal(after.config.stages[0]!.approval, true);
  assert.equal(after.runs[0]!.config.stages[0]!.approval, false);
  assert.equal(after.runs[0]!.requiredApprovals, 2);
  assert.throws(() => configureStage(before.config, "missing", { assistantId: "", instructions: "Task", context: "", approval: false }), /no longer exists/);
});

test("workflow settings are per stage, retain unchecked drafts, and are admin only", () => {
  const snapshot = fixture();
  assert.doesNotMatch(workflowPage(snapshot, "design").body, /id="workflow-stage"/);
  snapshot.roles = ["admin"];
  const ui = emptyStudioUi();
  ui.drafts["stage:design"] = { approval: "false", instructions: "Check the interface" };
  const page = workflowPage(snapshot, "design", ui);
  assert.match(page.body, /aria-label="Workflow stages"/);
  assert.match(page.body, /Choose a workflow template/);
  assert.match(page.body, /data-draft="stage:design"/);
  assert.match(page.body, /Check the interface/);
  assert.doesNotMatch(page.body, /name="approval" checked/);
});
