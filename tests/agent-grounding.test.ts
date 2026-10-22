import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botPolicySchema, attemptSchema } from "../workbench/bot-schema.js";
import { runBotWorker } from "../workbench/bot-worker.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { readPipelineForm } from "../workbench/pipeline-form.js";

const policy = { kind: "planner" as const, maxSteps: 4, timeoutSeconds: 30, allowedTools: ["read_project_file" as const], maxToolCalls: 1, requireSourceRead: true };
const answer = { type: "result", summary: "Claim about SOP.md", changes: [] };

test("required source reads reject impossible budgets and grants, while legacy policies remain valid", () => {
  for (const change of [{ allowedTools: [] }, { kind: "manual" }, { maxSteps: 1 }, { maxToolCalls: 0 }]) {
    const parsed = botPolicySchema.safeParse({ ...policy, ...change });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.equal(parsed.error.issues[0]!.path[0], "requireSourceRead");
  }
  assert.ok(botPolicySchema.safeParse({ kind: "planner", maxSteps: 1, timeoutSeconds: 30 }).success);
});

async function trial(contents: string | null, decisions: unknown[], succeeds: boolean) {
  const root = mkdtempSync(join(tmpdir(), "magentic-grounding-"));
  if (contents !== null) writeFileSync(join(root, "SOP.md"), contents);
  const engine = memoryPipelines();
  const config = { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0]!, bot: policy }] };
  engine.execute("test", "operator", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = engine.execute("test", "operator", ["author"], { action: "start", requestId: randomUUID(), title: "Read the SOP", brief: "Read SOP.md" }, 2).runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: run.config.stages[0]!.id,
    revision: 1, actor: "operator", bot: policy, model: "fixture", checkout: root, baseCommit: "fixture", startedAt: new Date().toISOString(),
    status: "running", summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
  const events: string[] = [];
  let index = 0;
  try {
    const work = runBotWorker(attempt, run, { invoke: async () => ({ content: JSON.stringify(decisions[index++] ?? answer) }) }, new AbortController().signal, message => events.push(message));
    if (succeeds) assert.equal((await work).summary, answer.summary);
    else await assert.rejects(work, /Required source read missing/);
    assert.ok(attempt.calls <= policy.maxSteps);
    assert.equal(engine.snapshot("test").runs[0]!.current, 0);
    return events;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("an unsupported claim cannot replace a source read", async () => {
  const events = await trial("Actual evidence", [answer], false);
  assert.ok(events.includes("Result blocked: no successful source read."));
  assert.equal(events.some(event => event.startsWith("MCP tool:")), false);
});

test("empty and missing files do not qualify as source evidence", async () => {
  const read = { type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } };
  await trial("   \n", [read, answer], false);
  await trial(null, [read, answer], false);
});

test("a rejected answer can recover by reading evidence within the original budget", async () => {
  const events = await trial("Actual evidence", [answer, { type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }, answer], true);
  assert.ok(events.includes("Result blocked: no successful source read."));
  assert.ok(events.includes("MCP tool: read_project_file"));
});

test("workflow form edits preserve the grounding rule owned by Agent Studio", () => {
  const previous = { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0]!, bot: policy }] };
  assert.equal(readPipelineForm(previous, new FormData(), true).stages[0]!.bot!.requireSourceRead, true);
});
