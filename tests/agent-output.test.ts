import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createScheduler, draftText } from "../workbench/scheduler.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function fixture() {
  const workspace = randomUUID();
  const assistant = randomUUID();
  const pipelines = memoryPipelines({ assistant: () => undefined });
  const initial = pipelines.snapshot(workspace);
  const config = structuredClone(initial.config);
  config.stages[0]!.assistantId = assistant;
  config.stages[0]!.approval = true;
  pipelines.execute(workspace, "operator", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = pipelines.execute(workspace, "operator", ["author"], { action: "start", requestId: randomUUID(), title: "Prepare a runbook", brief: "Document the supported recovery process." }, 2).runs[0]!;
  const current = () => pipelines.snapshot(workspace).runs[0]!;
  const command = (action: string, actor = "operator", note?: string) => pipelines.execute(workspace, actor, actor === "operator" ? ["author"] : ["approver"], {
    action, runId: run.id, expectedRevision: current().revision, ...(note ? { note } : {}),
  }, 2);
  const binding = { id: assistant, name: "Runbook assistant", model: "fixture", instructions: "Use the supplied evidence.", release: "v1" };
  const draft = (text: string) => pipelines.draft(workspace, { runId: run.id, stageId: run.config.stages[0]!.id, expectedRevision: current().revision, text, by: binding.name, jobId: randomUUID() });
  return { workspace, pipelines, run, current, command, binding, draft };
}

test("draft decoding supports text blocks and fenced JSON without treating tool requests as output", () => {
  assert.equal(draftText([{ type: "text", text: '```json\n{"type":"draft","text":"Check the source."}\n```' }]), "Check the source.");
  assert.equal(draftText({ type: "draft", text: " Safe plain text. " }), "Safe plain text.");
  assert.equal(draftText("Ordinary prose."), "Ordinary prose.");
  for (const invalid of ['{"type":"tool","text":"Delete a ticket"}', '{"text":', '[{"text":"unexpected"}]', [{ type: "tool_use", text: "claim" }]]) assert.equal(draftText(invalid), "");
  assert.throws(() => draftText("x".repeat(4001)), /exceeds 4000/);
  assert.throws(() => draftText({ type: "draft", text: "x".repeat(4001) }), /exceeds 4000/);
});

test("oversized drafts leave the workflow unchanged instead of saving a clipped result", () => {
  const f = fixture();
  const before = f.current();
  assert.throws(() => f.draft("x".repeat(4001)), /not exceed 4000/);
  assert.deepEqual(f.current(), before);
  f.draft("x".repeat(4000));
  assert.equal(f.current().stages[0]!.draft!.text.length, 4000);
});

test("a reference change during generation cancels the stale result and a retry uses current material", async () => {
  const f = fixture();
  let first = true;
  const prompts: string[] = [];
  const scheduler = createScheduler({ pipelines: f.pipelines, assistants: () => f.binding, loadModel: async () => ({ async invoke(prompt) {
    prompts.push(prompt);
    if (first) {
      first = false;
      f.pipelines.execute(f.workspace, "operator", ["author"], { action: "materials", runId: f.run.id, expectedRevision: f.current().revision,
        materials: [{ id: randomUUID(), title: "Updated procedure", content: "An independent review is required." }] }, 2);
    }
    return { content: '{"type":"draft","text":"Request an independent review."}' };
  } }) });
  try {
    await scheduler.tick(f.workspace);
    const job = scheduler.snapshot(f.workspace).jobs[0]!;
    assert.equal(job.status, "cancelled");
    assert.match(job.error, /context changed/);
    assert.equal(f.current().stages[0]!.draft, undefined);
    scheduler.retry(f.workspace, job.id);
    await scheduler.tick(f.workspace);
    assert.equal(scheduler.snapshot(f.workspace).jobs[0]!.status, "ready");
    assert.match(prompts[1]!, /Updated procedure/);
    assert.equal(f.current().stages[0]!.status, "active");
  } finally { await scheduler.close(); }
});

test("edited output retains the original draft and requires two independent approvals before handoff", () => {
  const f = fixture(); f.draft("Original recommendation.");
  f.command("complete", "operator", "Reviewed recommendation with source evidence.");
  assert.equal(f.current().stages[0]!.draft!.text, "Original recommendation.");
  assert.equal(f.current().stages[0]!.output, "Reviewed recommendation with source evidence.");
  assert.equal(f.current().stages[0]!.status, "awaiting_review");
  assert.throws(() => f.command("approve"), /reviewer|cannot approve/);
  f.command("approve", "reviewer-one");
  assert.equal(f.current().current, 0);
  f.command("approve", "reviewer-two");
  assert.equal(f.current().current, 1);
});

test("output review preserves edits and the reviewed revision while keeping another member read only", () => {
  const f = fixture(); f.draft("Original <script>draft</script>");
  const run = f.current();
  const snapshot: WorkbenchSnapshot = { workspaceId: f.workspace, actor: "operator", roles: ["author"], workflow: DEFAULT_WORKFLOW,
    canAuthor: true, records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false }, pipelines: f.pipelines.snapshot(f.workspace) };
  const ui = emptyStudioUi();
  const key = `output:${run.id}:${run.stages[0]!.draft!.hash}`;
  ui.drafts[key] = { note: "Reviewed </textarea> evidence", expectedRevision: String(run.revision - 1) };
  const body = workflowPage(snapshot, undefined, ui).body;
  assert.match(body, /Reviewed &lt;\/textarea&gt; evidence/);
  assert.match(body, /Reload saved draft/);
  assert.match(body, /Submit for review/);
  assert.ok(body.includes(`class="flow-name" href="#/desk/${run.id}"`));
  assert.doesNotMatch(body, /<script>|data-run-draft/);
  assert.throws(() => f.pipelines.execute(f.workspace, "operator", ["author"], { action: "complete", runId: run.id, expectedRevision: run.revision - 1, note: "Stale edit" }, 2), /changed/);
  const readOnly = workflowPage({ ...snapshot, actor: "other" }, undefined).body;
  assert.doesNotMatch(readOnly, /data-output-review/);
  assert.match(readOnly, /Original agent draft/);
});
