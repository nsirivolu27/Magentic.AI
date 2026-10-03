import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryPipelines } from "../workbench/pipeline.js";
import { deskView, deskSessions, sessionNeedsReview } from "../workbench/desk-view.js";
import { attemptSchema, type BotSnapshot } from "../workbench/bot-schema.js";

function fixture() {
  const engine = memoryPipelines();
  const snapshot = engine.execute("one", "author", ["author"], { action: "start", requestId: randomUUID(),
    title: '<img src=x onerror="alert(1)">', brief: "Fix ticket ENG-42" }, 2);
  const run = snapshot.runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id,
    stageId: run.config.stages[run.current]!.id, revision: run.revision, actor: "author",
    bot: { kind: "coder", maxSteps: 3, timeoutSeconds: 30 }, model: "local-model", checkout: "/tmp/project",
    baseCommit: "abc", startedAt: new Date().toISOString(), status: "ready", summary: "Review the proposal",
    error: "", calls: 2, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "hash", checks: [], checkedTree: "" });
  const bots: BotSnapshot = { project: null, attempts: [attempt], busy: false };
  return { snapshot, run, bots, attempt };
}

test("desk review queue excludes stale revisions, other phases and closed sessions", () => {
  const { run, bots, attempt } = fixture();
  assert.equal(sessionNeedsReview(run, bots), true);
  attempt.revision++;
  assert.equal(sessionNeedsReview(run, bots), false);
  attempt.revision = run.revision;
  attempt.stageId = "another-phase";
  assert.equal(sessionNeedsReview(run, bots), false);
  run.stages[run.current]!.status = "awaiting_review";
  assert.equal(sessionNeedsReview(run, bots), true);
  run.status = "cancelled";
  assert.equal(sessionNeedsReview(run, bots), false);
});

test("desk safely renders task text and filters sessions without changing their state", () => {
  const { snapshot, bots } = fixture();
  const before = JSON.stringify(snapshot);
  const matching = deskSessions(snapshot, bots, "review", "eng-42");
  assert.match(matching, /&lt;img/);
  assert.doesNotMatch(matching, /<img/);
  assert.match(deskSessions(snapshot, bots, "complete", ""), /No sessions match/);
  assert.match(deskSessions(snapshot, bots, "all", "missing"), /No sessions match/);
  assert.doesNotMatch(deskView(snapshot, bots, ["approver"], "all", ""), /id="desk-start"/);
  assert.equal(JSON.stringify(snapshot), before);
});
