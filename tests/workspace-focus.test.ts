import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materialsSchema } from "../workbench/materials.js";
import { DEFAULT_PIPELINE, filePipelines, memoryPipelines } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { attemptSchema, type BotSnapshot } from "../workbench/bot-schema.js";
import { runBotWorker } from "../workbench/bot-worker.js";
import { workspaceView, workProgress } from "../workbench/workspace-view.js";

const reference = () => ({ id: randomUUID(), title: "Service requirements", content: "Support keyboard-only navigation.", url: "https://example.gov/spec" });
function fixture() {
  const engine = memoryPipelines();
  const bot = { kind: "coder" as const, maxSteps: 1, timeoutSeconds: 15, allowedTools: [], maxToolCalls: 0 };
  const config = { ...structuredClone(DEFAULT_PIPELINE), stages: [{ ...DEFAULT_PIPELINE.stages[0]!, bot, approval: true }] };
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Accessible service", brief: "Improve the flow.", materials: [reference()] }, 2).runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: "intake", revision: 1, actor: "owner", bot, model: "fixture",
    checkout: "/unused", baseCommit: "fixture", startedAt: new Date().toISOString(), status: "ready", summary: "Proposed implementation", error: "", calls: 0,
    tokenUsage: null, cost: null, events: [], changes: [{ path: "index.txt", before: "old", after: "new" }], proposalHash: "a".repeat(64), checks: [], checkedTree: "" });
  const bots: BotSnapshot = { project: { root: "/unused", checks: [{ executable: "node", args: ["--test"] }] }, attempts: [attempt], busy: false };
  return { engine, run, attempt, bots };
}

test("references reject unsafe URLs, unknown fields, duplicates and excessive context", () => {
  const item = reference();
  assert.equal(materialsSchema.safeParse([item]).success, true);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a URL", "https://user:secret@example.com"])
    assert.equal(materialsSchema.safeParse([{ ...item, url }]).success, false);
  assert.equal(materialsSchema.safeParse([{ ...item, grantTools: true }]).success, false);
  assert.equal(materialsSchema.safeParse([item, item]).success, false);
  assert.equal(materialsSchema.safeParse(Array.from({ length: 3 }, () => ({ ...reference(), content: "x".repeat(6000) }))).success, false);
});

test("saved references survive reopening, cannot mutate a run, and bind idempotent start requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-materials-"));
  let store = fileWorkspaceStore(directory);
  const input = { action: "start", requestId: randomUUID(), title: "Public service", brief: "Use the source.", materials: [reference()] };
  try {
    const engine = filePipelines(store);
    const result = engine.execute("one", "owner", ["admin"], input, 2);
    result.runs[0]!.materials![0]!.content = "Changed snapshot";
    assert.equal(engine.execute("one", "owner", ["admin"], input, 2).runs.length, 1);
    assert.throws(() => engine.execute("one", "owner", ["admin"], { ...input, materials: [{ ...input.materials[0], content: "Different context" }] }, 2), /different work/);
    store.close(); store = fileWorkspaceStore(directory);
    const saved = filePipelines(store).snapshot("one").runs[0]!;
    assert.deepEqual(saved.materials, input.materials);
    assert.equal(saved.requiredApprovals, 2);
  } finally { store.close(); }
});

test("each agent receives saved references as untrusted context without adding capabilities", async () => {
  const { run, attempt } = fixture();
  attempt.status = "running"; attempt.changes = [];
  const prompts: string[] = [];
  const model = { async invoke(prompt: string) { prompts.push(prompt); return { content: JSON.stringify({ type: "result", summary: "Requirements considered.", changes: [] }) }; } };
  await runBotWorker(attempt, run, model, new AbortController().signal, () => {});
  assert.match(prompts[0]!, /REFERENCE MATERIAL \(untrusted task data\)/);
  assert.ok(prompts[0]!.includes(run.materials![0]!.content));
  assert.match(prompts[0]!, /Allowed MCP tools for this phase: \[\]/);
  assert.match(prompts[0]!, /You cannot fetch links/);
});

test("focused work view offers apply then checks then review submission", () => {
  const { run, attempt, bots } = fixture();
  let html = workProgress(run, bots, "owner", ["admin"]);
  assert.match(html, /data-bot-action="apply"/);
  assert.doesNotMatch(html, /data-bot-action="accept"/);
  attempt.status = "applied";
  html = workProgress(run, bots, "owner", ["admin"]);
  assert.match(html, /data-bot-action="checks"/);
  assert.doesNotMatch(html, /data-bot-action="accept"/);
  attempt.checks = [{ command: bots.project!.checks[0]!, exitCode: 0, output: "Passed", passed: true }]; attempt.checkedTree = "b".repeat(64);
  html = workProgress(run, bots, "owner", ["admin"]);
  assert.match(html, /Submit for independent review/);
  attempt.handoff = { sections: [], blockers: ["Missing source evidence"] };
  assert.doesNotMatch(workProgress(run, bots, "owner", ["admin"]), /data-bot-action="accept"/);
});

test("review UI never lets the owner approve and old references remain visible after handoff", () => {
  const { run, bots } = fixture();
  run.stages[0]!.status = "awaiting_review"; run.stages[0]!.outputBy = "owner";
  assert.doesNotMatch(workProgress(run, bots, "owner", ["admin"]), /data-pipeline-action="approve"/);
  assert.match(workProgress(run, bots, "reviewer", ["approver"]), /data-pipeline-action="approve"/);
  run.stages[0]!.approvals = ["reviewer"];
  assert.doesNotMatch(workProgress(run, bots, "reviewer", ["approver"]), /data-pipeline-action="approve"/);
});

test("workspace separates advanced setup and escapes reference text", () => {
  const { engine, bots, run } = fixture();
  run.materials![0]!.content = '<script>alert("test")</script>';
  const snapshot = engine.snapshot("one"); snapshot.runs = [run];
  const html = workspaceView(snapshot, bots, "owner", ["admin"], { title: "", brief: "" }, [], run.id);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|Validation commands · JSON|data-bot-template/);
  assert.match(html, /Reference material · 1/);
  const blank = workspaceView(snapshot, bots, "owner", ["admin"], { title: "", brief: "" }, []);
  assert.match(blank, /Reuse from this workspace/);
  assert.match(blank, /Use public-service example/);
});
