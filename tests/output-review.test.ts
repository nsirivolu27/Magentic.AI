import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { evidenceTrail, outputReview, runNow } from "../workbench/output-review.js";
import { workProgress } from "../workbench/workspace-view.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { DEFAULT_PIPELINE, memoryPipelines, type PipelineRun } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { emptyStudioUi } from "../workbench/studio-view.js";

/**
 * One review block for every page: evidence, the agent's original output,
 * the handoff being recorded, and the approval state. The state words are
 * fixed, and the person who may act is decided by the same rules the
 * engine enforces.
 */

function fixture() {
  const engine = memoryPipelines();
  const config = structuredClone(DEFAULT_PIPELINE);
  config.stages[0]!.approval = true;
  engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const pipelines = engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Routing <b>fix</b>", brief: "Fix the routing.",
    materials: [{ id: randomUUID(), title: "Routing SOP", content: "Mountain region goes to GI-Mountain." }, { id: randomUUID(), title: "Ticket", content: "", url: "https://example.invalid/ticket/1" }] }, 2);
  const run = () => engine.snapshot("one").runs[0]!;
  return { engine, pipelines, run };
}
const snapshotFor = (pipelines: ReturnType<typeof fixture>["pipelines"], actor: string, roles: ("author" | "approver" | "admin")[]): WorkbenchSnapshot => ({
  workspaceId: "one", actor, roles, canAuthor: roles.includes("author") || roles.includes("admin"), workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true,
  mcp: { agents: [], withheld: [] }, chat: { configured: false }, pipelines });

test("the now line names the stage, who is responsible, the output state and the next action for each run state", () => {
  const { engine, run } = fixture();
  let current = run();
  assert.deepEqual({ ...runNow(current, { actor: "owner", roles: ["author"] }) }, { stageName: "Intake", href: `#/desk/${current.id}`, who: "You · Requirements agent", state: { tone: "neutral", label: "By hand" }, action: "Record the output" });
  assert.equal(runNow(current, { actor: "someone", roles: ["author"] }).action, "Waiting on owner");
  const withAssistant: PipelineRun = { ...current, config: { ...current.config, stages: current.config.stages.map((stage, index) => index ? stage : { ...stage, assistantId: randomUUID() }) } };
  assert.deepEqual(runNow(withAssistant, { actor: "owner", roles: ["author"], assistantUsable: false }).state, { tone: "bad", label: "Not connected" });
  engine.draft("one", { runId: current.id, stageId: current.config.stages[0]!.id, expectedRevision: current.revision, text: "Draft text", by: "Helper", jobId: randomUUID() });
  current = run();
  assert.deepEqual(runNow(current, { actor: "owner", roles: ["author"] }).state, { tone: "info", label: "Draft ready" });
  engine.execute("one", "owner", ["author"], { action: "complete", runId: current.id, expectedRevision: current.revision, note: "Recorded by hand." }, 2);
  current = run();
  const owner = runNow(current, { actor: "owner", roles: ["author"] });
  assert.deepEqual(owner.state, { tone: "warn", label: "Awaiting approval" });
  assert.equal(owner.action, "Waiting for approvals · 0 of 2");
  assert.equal(runNow(current, { actor: "reviewer", roles: ["approver"] }).action, "Review and approve");
  assert.deepEqual(runNow({ ...current, status: "blocked" }, { actor: "owner", roles: ["author"] }), { stageName: "Intake", href: `#/desk/${current.id}`, who: "You", state: { tone: "bad", label: "Blocked" }, action: "Resolve the block" });
  assert.deepEqual(runNow({ ...current, status: "complete" }, { actor: "owner", roles: ["author"] }).state, { tone: "ok", label: "Done" });
});

test("the owner edits the draft beside the original, the evidence and the gate, on the work item and on the workflow page alike", () => {
  const { engine, run } = fixture();
  const first = run();
  engine.draft("one", { runId: first.id, stageId: first.config.stages[0]!.id, expectedRevision: first.revision, text: "Draft <script>x</script>", by: "Helper", jobId: randomUUID() });
  const current = run();
  const desk = outputReview({ run: current, phase: 0, actor: "owner", roles: ["author"], where: "desk" });
  assert.match(desk, /aria-label="Evidence"[\s\S]*Routing SOP[\s\S]*36 characters/);
  assert.match(desk, /Ticket ↗[\s\S]*link only, not fetched/);
  assert.match(desk, /Original agent draft/);
  assert.match(desk, /Draft &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(desk, /<script>/);
  assert.match(desk, /data-output-review data-draft="output:[^"]+" data-run="[^"]+" data-revision="2"/);
  assert.match(desk, /Submit for review/);
  assert.match(desk, /Review gate[\s\S]*2 independent approvals after the handoff is submitted/);
  const reader = outputReview({ run: current, phase: 0, actor: "someone", roles: ["author"], where: "desk" });
  assert.doesNotMatch(reader, /data-output-review/);
  assert.match(reader, /owner records the handoff/);
  // A stale edit is called out with the reload control instead of a silent overwrite.
  const ui = emptyStudioUi();
  ui.drafts[`output:${current.id}:${current.stages[0]!.draft!.hash}`] = { note: "My edit", expectedRevision: "1" };
  const stale = outputReview({ run: current, phase: 0, actor: "owner", roles: ["author"], where: "workflows", ui });
  assert.match(stale, /This workflow changed/);
  assert.match(stale, /data-output-reset=/);
  assert.match(stale, /My edit/);
  assert.match(stale, /href="#\/desk\/[^"]+">Open work item/);
  // The work item page renders the same block for the current stage.
  const progress = workProgress(current, undefined, "owner", ["author"]);
  assert.match(progress, /Draft ready/);
  assert.match(progress, /data-output-review/);
  assert.doesNotMatch(progress, /id="pipeline-output"/, "the manual form yields to the draft form");
});

test("approval sits beside the recorded handoff: eligible reviewers get the button, everyone else gets the reason", () => {
  const { engine, run } = fixture();
  const first = run();
  engine.execute("one", "owner", ["author"], { action: "complete", runId: first.id, expectedRevision: first.revision, note: "Recorded output" }, 2);
  const current = run();
  const reviewer = outputReview({ run: current, phase: 0, actor: "reviewer", roles: ["approver"], where: "desk" });
  assert.match(reviewer, /Recorded by owner/);
  assert.match(reviewer, /Awaiting approval[\s\S]*0 of 2 approvals/);
  assert.match(reviewer, /data-pipeline-action="approve"/);
  const owner = outputReview({ run: current, phase: 0, actor: "owner", roles: ["author", "approver"], where: "desk" });
  assert.doesNotMatch(owner, /data-pipeline-action="approve"/);
  assert.match(owner, /owner and the author of the output cannot approve/);
  const elsewhere = outputReview({ run: current, phase: 0, actor: "reviewer", roles: ["approver"], where: "workflows" });
  assert.doesNotMatch(elsewhere, /data-pipeline-action/);
  assert.match(elsewhere, /Review on the work item/);
  engine.execute("one", "reviewer", ["approver"], { action: "approve", runId: current.id, expectedRevision: current.revision }, 2);
  const signed = outputReview({ run: run(), phase: 0, actor: "reviewer", roles: ["approver"], where: "desk" });
  assert.match(signed, /1 of 2 approvals · reviewer/);
  assert.match(signed, /Your approval is recorded/);
  assert.doesNotMatch(signed, /data-pipeline-action="approve"/);
  const busy = workProgress(run(), { project: null, attempts: [], busy: true }, "second", ["approver"]);
  assert.match(busy, /data-pipeline-action="approve" disabled/);
});

test("a manual stage offers the handoff form only to the owner on the work item, and a completed stage reads back as approved", () => {
  const { engine, pipelines, run } = fixture();
  const current = run();
  const owner = workProgress(current, undefined, "owner", ["author"]);
  assert.match(owner, /By hand/);
  assert.match(owner, /id="pipeline-output"/);
  assert.match(owner, /Record and submit for review/);
  assert.match(owner, /there is no agent output/);
  assert.doesNotMatch(workProgress(current, undefined, "someone", ["author"]), /id="pipeline-output"/);
  engine.execute("one", "owner", ["author"], { action: "complete", runId: current.id, expectedRevision: current.revision, note: "Done" }, 2);
  for (const who of ["reviewer", "second"]) { const now = run(); engine.execute("one", who, ["approver"], { action: "approve", runId: now.id, expectedRevision: now.revision }, 2); }
  const done = run();
  assert.equal(done.current, 1);
  const earlier = outputReview({ run: done, phase: 0, actor: "owner", roles: ["author"], where: "desk" });
  assert.match(earlier, /Approved by reviewer, second/);
  assert.match(earlier, /Recorded by owner/);
  const page = workflowPage(snapshotFor(engine.snapshot("one"), "owner", ["author"]), undefined).body;
  assert.match(page, /class="run-now"/);
  assert.match(page, /Stage<\/span>2 of 7 · Planning/);
  assert.doesNotMatch(page, /review-grid/, "nothing waits on a person, so the workflow page stays compact");
  void pipelines;
});

test("evidence trail lists recorded source reads and tool calls, and says when nothing was recorded", () => {
  const attempt = { events: [
    { at: "2026-10-20T10:00:00.000Z", message: "Source read: docs/sop.md (1240 characters)" },
    { at: "2026-10-20T10:00:01.000Z", message: "Source empty: docs/notes.md" },
    { at: "2026-10-20T10:00:02.000Z", message: "Source missing: docs/gone.md" },
    { at: "2026-10-20T10:00:03.000Z", message: "MCP tool: read_project_file" },
    { at: "2026-10-20T10:00:04.000Z", message: "Blocked MCP tool: project_diff" },
    { at: "2026-10-20T10:00:05.000Z", message: "Model call 1 of 4" },
  ] };
  const trail = evidenceTrail(attempt);
  assert.deepEqual(trail.reads.map(read => [read.path, read.outcome, read.detail]), [["docs/sop.md", "read", "1,240 characters"], ["docs/notes.md", "empty", "empty"], ["docs/gone.md", "missing", "missing"]]);
  assert.deepEqual(trail.tools, [{ name: "read_project_file", blocked: false }, { name: "project_diff", blocked: true }]);
  assert.deepEqual(evidenceTrail(undefined), { reads: [], tools: [] });
  assert.deepEqual(evidenceTrail({ events: [] }), { reads: [], tools: [] });
});

test("evidence block renders the trail with its outcomes and an honest empty state", () => {
  const { run } = fixture();
  const current = run();
  const base = { id: randomUUID(), requestId: randomUUID(), runId: current.id, stageId: current.config.stages[0]!.id, revision: 1, actor: "owner",
    bot: { kind: "coder" as const }, model: "scripted", checkout: "", baseCommit: "", startedAt: new Date().toISOString(), status: "ready" as const,
    summary: "Draft text", error: "", calls: 1, tokenUsage: null, cost: null, changes: [], proposalHash: "", checks: [], checkedTree: "" };
  const withTrail = { ...base, events: [{ at: base.startedAt, message: "Source read: docs/sop.md (1240 characters)" }, { at: base.startedAt, message: "MCP tool: read_project_file" }, { at: base.startedAt, message: "Blocked MCP tool: project_diff" }] };
  const html = outputReview({ run: current, phase: 0, actor: "owner", roles: ["author"], where: "desk", attempt: withTrail as never });
  assert.match(html, /1 source read · 1 tool call/);
  assert.match(html, /<code>docs\/sop\.md<\/code><small class="text-3"> · 1,240 characters/);
  assert.match(html, /Blocked<\/span> <code>project_diff<\/code>/);
  const empty = outputReview({ run: current, phase: 0, actor: "owner", roles: ["author"], where: "desk", attempt: { ...base, events: [] } as never });
  assert.match(empty, /No source reads recorded/); assert.match(empty, /No tool calls recorded/); assert.match(empty, /0 source reads · 0 tool calls/);
});

test("a failed output contract stays visible with retry and write my own, never hidden by a retry", () => {
  const { engine, run } = fixture();
  const current = run();
  const stage = current.config.stages[0]!;
  const job = { id: randomUUID(), workspaceId: "one", runId: current.id, stageId: stage.id, stage: stage.name, title: current.title,
    assistantId: randomUUID(), assistant: "Evidence reviewer", model: "scripted", status: "failed" as const, queuedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), error: "The assistant did not meet the output contract: missing the evidence section.", draftHash: "" };
  const snapshot = { ...snapshotFor(engine.snapshot("one"), "owner", ["author"]), schedule: { jobs: [job], busy: false } };
  const body = workflowPage(snapshot, undefined).body;
  assert.match(body, /Draft failed/);
  assert.match(body, /The assistant could not draft/);
  assert.match(body, /did not meet the output contract: missing the evidence section/);
  assert.match(body, new RegExp(`data-job-retry="${job.id}"[^>]*>Try again`));
  assert.match(body, /Write my own/);
  // The viewer who is not the owner sees the failure too, without the retry control.
  const viewer = workflowPage({ ...snapshot, actor: "someone" }, undefined).body;
  assert.match(viewer, /Draft failed/); assert.match(viewer, /output contract/); assert.doesNotMatch(viewer, /data-job-retry/);
});
