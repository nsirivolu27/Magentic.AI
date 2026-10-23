import assert from "node:assert/strict";
import test from "node:test";
import { STAGE_GROUPS, STUDIO_STAGES, stageStateSentence, studioGuide } from "../workbench/guided-stages.js";
import type { PhaseReport } from "../workbench/studio-model.js";

const report = (overrides: Partial<PhaseReport> = {}): PhaseReport => ({
  current: "train",
  states: { define: "complete", data: "complete", train: "current", evaluate: "not-started", approve: "not-started", use: "not-started" },
  reasons: {}, ...overrides,
});

test("stage rail groups the six stages into development, live tests and release", () => {
  assert.deepEqual(STAGE_GROUPS.flatMap(group => group.stages), STUDIO_STAGES.map(stage => stage.id));
  const html = studioGuide("p1", "train", report());
  assert.match(html, /aria-label="Development"/); assert.match(html, /aria-label="Live tests"/); assert.match(html, /aria-label="Release"/);
  assert.match(html, /train" aria-current="step"/);
  assert.match(html, /Build a candidate<\/strong><small>Next step/);
  assert.match(html, /Get approval<\/strong><small>Not started/);
  assert.equal((html.match(/class="stage-card /g) ?? []).length, 6);
  assert.match(html, /class="stage-card current selected"/);
});

test("stage state sentence explains blocked, failed, waiting, complete and not started", () => {
  assert.equal(stageStateSentence("train", report()), "Next step. Nothing earlier is blocking it.");
  assert.match(stageStateSentence("evaluate", report()), /^Not started: finish build a candidate first\./);
  assert.match(stageStateSentence("define", report()), /^Complete\. A purpose/);
  const blocked = report({ current: "evaluate", states: { ...report().states, train: "complete", evaluate: "blocked" }, blocking: "live test 3 has not run" });
  assert.equal(stageStateSentence("evaluate", blocked), "Blocked: live test 3 has not run");
  const failed = report({ current: "train", states: { ...report().states, train: "failed" }, blocking: "training stopped at step 4" });
  assert.equal(stageStateSentence("train", failed), "Needs changes: training stopped at step 4");
  const waiting = report({ current: "approve", states: { ...report().states, train: "complete", evaluate: "complete", approve: "current" } });
  assert.match(stageStateSentence("approve", waiting, { approvals: 1, required: 2 }), /^Awaiting approval: 1 of 2 reviewer signatures\./);
  assert.match(stageStateSentence("approve", waiting, { approvals: 1, required: 2 }), /author cannot sign/);
});
