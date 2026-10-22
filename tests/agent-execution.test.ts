import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attemptSchema } from "../workbench/bot-schema.js";
import { botResponseFormat } from "../workbench/bot-response.js";
import { runBotWorker } from "../workbench/bot-worker.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "magentic-execution-"));
  writeFileSync(join(directory, "SOP.md"), "Reviews require independent approval.");
  const bot = { kind: "planner" as const, maxSteps: 4, timeoutSeconds: 30, allowedTools: ["read_project_file" as const], maxToolCalls: 1, requireSourceRead: true };
  const engine = memoryPipelines();
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0]!, approval: true, bot }] } }, 1);
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Document review", brief: "Read SOP.md." }, 1).runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: "intake", revision: 1,
    actor: "owner", bot, model: "fixture", checkout: directory, baseCommit: "fixture", startedAt: new Date().toISOString(), status: "running",
    summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
  return { directory, bot, engine, run, attempt };
}

test("a malformed response can recover through a real source read without advancing a gated run", async () => {
  const f = fixture();
  const events: string[] = [];
  try {
    let calls = 0;
    const result = await runBotWorker(f.attempt, f.run, { async invoke(prompt, options) {
      calls++;
      if (calls < 3) assert.equal(JSON.stringify(options?.format).includes('"result"'), false);
      if (calls === 1) return { content: "{unfinished" };
      if (calls === 2) {
        assert.match(prompt, /not valid JSON/);
        return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "SOP.md" } }) };
      }
      assert.match(prompt, /Reviews require independent approval/);
      assert.equal(JSON.stringify(options?.format).includes('"tool"'), false, "spent tool budget is not offered again");
      return { content: JSON.stringify({ type: "result", summary: "SOP.md requires independent approval.", changes: [] }) };
    } }, new AbortController().signal, message => events.push(message));
    assert.equal(result.summary, "SOP.md requires independent approval.");
    assert.equal(calls, 3);
    assert.ok(events.some(event => event.startsWith("Source read: SOP.md")));
    assert.equal(f.engine.snapshot("one").runs[0]!.revision, 1);
    assert.equal(f.engine.snapshot("one").runs[0]!.stages[0]!.approvals.length, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a model ignoring the response schema still cannot answer without evidence", async () => {
  const f = fixture();
  try {
    await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke() {
      return { content: JSON.stringify({ type: "result", summary: "Invented approval", changes: [] }) };
    } }, new AbortController().signal, () => {}), /Required source read missing/);
    assert.ok(f.attempt.calls <= f.bot.maxSteps);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("format retries stop at the existing model-call budget", async () => {
  const f = fixture();
  try {
    await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke() { return { content: "bad json" }; } },
      new AbortController().signal, () => {}), /Required source read missing|model-call budget/);
    assert.ok(f.attempt.calls <= f.bot.maxSteps);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("response formats offer only granted tools and no edits to read-only agents", () => {
  const f = fixture();
  try {
    const before = botResponseFormat(f.bot, f.bot.allowedTools, false);
    assert.equal(JSON.stringify(before).includes("list_project_files"), false);
    assert.equal(JSON.stringify(before).includes('"result"'), false);
    const after = botResponseFormat(f.bot, [], true) as { properties: { changes: { maxItems: number } } };
    assert.equal(after.properties.changes.maxItems, 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
