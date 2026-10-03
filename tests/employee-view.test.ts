import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryPipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { canReviewTask, tasksPage } from "../workbench/employee-view.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import { attentionItems } from "../workbench/home-view.js";

function fixture() {
  const engine = memoryPipelines();
  const config = structuredClone(DEFAULT_PIPELINE);
  config.stages = [{ ...config.stages[0]!, approval: true }];
  engine.execute("team", "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const pipelines = engine.execute("team", "author", ["author"], { action: "start", requestId: randomUUID(), title: "Onboarding guide", brief: "Explain the first day." }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "team", actor: "author", roles: ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, pipelines, records: [], audit: [], demo: true,
    mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  return { engine, snapshot, run: pipelines.runs[0]! };
}

test("employee review actions follow distinct-reviewer gates through completion", () => {
  const { engine, snapshot, run } = fixture();
  snapshot.pipelines = engine.execute("team", "author", ["author"], { action: "complete", runId: run.id, expectedRevision: 1, note: "First-day checklist" }, 2);
  const current = () => snapshot.pipelines!.runs[0]!;
  const body = () => tasksPage(snapshot, run.id, emptyStudioUi()).body;
  assert.equal(canReviewTask(snapshot, current()), false);
  assert.match(body(), /different reviewer/);
  assert.doesNotMatch(body(), /id="employee-approve"/);
  snapshot.roles = ["admin"];
  assert.equal(canReviewTask(snapshot, current()), false, "an admin cannot review their own task");
  snapshot.actor = "reviewer"; snapshot.roles = ["approver"]; snapshot.canAuthor = false;
  assert.match(body(), /id="employee-approve"/);
  assert.equal(attentionItems(snapshot)[0]?.href, `#/tasks/${run.id}`, "task reviews appear even without Model Studio");
  snapshot.pipelines = engine.execute("team", "reviewer", ["approver"], { action: "approve", runId: run.id, expectedRevision: current().revision }, 2);
  assert.equal(current().status, "running");
  assert.match(body(), /1 of 2 approvals/);
  assert.match(body(), /Your approval is recorded/);
  assert.doesNotMatch(body(), /id="employee-approve"/);
  snapshot.actor = "second-reviewer";
  snapshot.pipelines = engine.execute("team", snapshot.actor, ["approver"], { action: "approve", runId: run.id, expectedRevision: current().revision }, 2);
  assert.match(body(), /All steps are complete/);
  assert.doesNotMatch(body(), /id="employee-approve"|id="employee-complete"/);
});

test("employees cannot complete another person's task and displayed revisions stay explicit", () => {
  const { snapshot, run } = fixture();
  const ownerPage = tasksPage(snapshot, run.id, emptyStudioUi()).body;
  assert.match(ownerPage, /id="employee-complete"/);
  assert.match(ownerPage, /name="revision" value="1"/);
  assert.match(ownerPage, /Send for review/);
  snapshot.actor = "another-author";
  assert.doesNotMatch(tasksPage(snapshot, run.id, emptyStudioUi()).body, /id="employee-complete"/);
});

test("task drafts and references render as text and survive revisiting the form", () => {
  const { snapshot, run } = fixture();
  const ui = emptyStudioUi();
  ui.drafts["employee-task"] = { title: 'A "guide"', notes: "<script>alert(1)</script>" };
  const form = tasksPage(snapshot, "new", ui).body;
  assert.match(form, /A &quot;guide&quot;/);
  assert.match(form, /&lt;script&gt;/);
  assert.doesNotMatch(form, /<script>/);
  ui.drafts[`employee-output:${run.id}:0:1`] = { note: "My saved result" };
  assert.match(tasksPage(snapshot, run.id, ui).body, /My saved result/);
  snapshot.canAuthor = false;
  assert.doesNotMatch(tasksPage(snapshot, "new", ui).body, /id="employee-task"/);
});

test("paused and missing tasks offer useful recovery without completion actions", () => {
  const { engine, snapshot, run } = fixture();
  snapshot.pipelines = engine.execute("team", "author", ["author"], { action: "pause", runId: run.id, expectedRevision: 1 }, 2);
  const paused = tasksPage(snapshot, run.id, emptyStudioUi()).body;
  assert.match(paused, /Resume task/);
  assert.doesNotMatch(paused, /id="employee-complete"/);
  assert.match(tasksPage(snapshot, "missing", emptyStudioUi()).body, /Back to tasks/);
  delete snapshot.pipelines;
  assert.match(tasksPage(snapshot, undefined, emptyStudioUi()).body, /not available/);
});
