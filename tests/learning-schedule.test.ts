import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileModelStudio, memoryModelStudio, type ModelStudio } from "../workbench/studio/engine.js";
import { createLearningSchedule, folderImports, type LearningPersistence, type LearningRun, type LearningState } from "../workbench/learning-schedule.js";

/**
 * The learning schedule keeps an assistant learning from new personal
 * content on a rhythm. A due schedule runs one cycle: import new files,
 * validate, train, evaluate, request a release. Each step goes through the
 * ordinary studio commands as the schedule's owner, stops where a person
 * has to look, and never approves or assigns anything.
 */

const W = "learning-workspace";
type Roles = ("author" | "approver" | "admin")[];
const T0 = "2026-09-28T09:00:00.000Z";
const note = (index: number, tag = "queue") => JSON.stringify({ messages: [
  { role: "user", content: `Client: Acme. Ask ${index}: leads land in the wrong ${tag}.` },
  { role: "assistant", content: `What we did: rebuilt the assignment rule ${index}. Next step: confirm with the client.` },
] });
const notes = (count: number, tag = "queue") => Array.from({ length: count }, (_, index) => note(index, tag)).join("\n");

function clock(start = T0) {
  let at = new Date(start).getTime();
  return { now: () => new Date(at).toISOString(), advance(hours: number) { at += hours * 3_600_000; } };
}

function project(studio: ModelStudio, owner = "priya") {
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  const s = exec(owner, ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery", purpose: "Answer delivery questions." });
  return { exec, project: s.projects[0]! };
}

test("a due schedule runs one learning cycle from registered content up to a release request, and no further", () => {
  const time = clock();
  const studio = memoryModelStudio({ now: time.now });
  const { exec, project: p } = project(studio);
  exec("priya", ["author"], { action: "register_dataset", projectId: p.id, name: "Case notes, Q3", source: { kind: "inline", text: notes(80) } });
  const learning = createLearningSchedule({ studio, now: time.now });
  // Nothing runs without a schedule.
  assert.deepEqual(learning.tick(W), []);
  const schedule = learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "weekly" });
  assert.equal(schedule.owner, "priya");
  assert.equal(schedule.nextRunAt, T0, "a new schedule is due at once");
  const [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.trigger, "schedule");
  assert.equal(run.status, "complete");
  assert.deepEqual(run.steps.map((step) => `${step.step}:${step.outcome}`), ["import:skipped", "validate:done", "train:done", "evaluate:done", "release:done"]);
  const after = studio.snapshot(W);
  assert.equal(after.datasets[0]!.status, "valid");
  assert.equal(after.jobs[0]!.status, "succeeded");
  assert.equal(after.evaluations[0]!.passed, true);
  assert.equal(after.releases[0]!.status, "pending_approval", "a person approves; the schedule only asks");
  assert.equal(after.releases[0]!.requestedBy, "priya", "the cycle acts as the schedule's owner");
  assert.equal(after.profiles.length, 0, "nothing is assigned by a schedule");
  assert.match(run.summary, /release v1 requested/i);
  // Weekly means a week, and nothing repeats before then.
  const next = learning.snapshot(W).schedules[0]!;
  assert.equal(next.lastRunAt, T0);
  assert.equal(new Date(next.nextRunAt!).getTime() - new Date(T0).getTime(), 7 * 24 * 3_600_000);
  assert.deepEqual(learning.tick(W), []);
  time.advance(24 * 7);
  // Due again, but there is nothing new: the cycle says so and stops without touching the studio.
  const [again] = learning.tick(W) as [LearningRun];
  assert.equal(again.status, "stopped");
  assert.match(again.summary, /nothing new/i);
  assert.equal(studio.snapshot(W).jobs.length, 1);
});

test("a cycle stops where a person has to look: rejected content, a failed evaluation, a pending release", () => {
  const time = clock();
  const studio = memoryModelStudio({ now: time.now });
  const { exec, project: p } = project(studio);
  const learning = createLearningSchedule({ studio, now: time.now });
  learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "daily" });
  // Rejected content: the leaked token stops the cycle at validation, with the count and never the content.
  const leaked = notes(20) + "\n" + JSON.stringify({ messages: [{ role: "user", content: "Reset the integration user." }, { role: "assistant", content: "Done. token: 8kLm2QpX9vRt4Yw7Zb1Nc3Hd" }] });
  exec("priya", ["author"], { action: "register_dataset", projectId: p.id, name: "Draft notes", source: { kind: "inline", text: leaked } });
  let [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.status, "stopped");
  assert.equal(run.steps.at(-1)!.step, "validate");
  assert.match(run.summary, /rejected/);
  assert.doesNotMatch(JSON.stringify(run), /8kLm2QpX9vRt4Yw7Zb1Nc3Hd/);
  // Too little content: valid, trained, but the evaluation fails coverage; the cycle stops there.
  time.advance(24);
  exec("priya", ["author"], { action: "register_dataset", projectId: p.id, name: "Ten notes", source: { kind: "inline", text: notes(10, "ten") } });
  [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.status, "stopped");
  assert.equal(run.steps.at(-1)!.step, "evaluate");
  assert.match(run.summary, /coverage/);
  assert.equal(studio.snapshot(W).releases.length, 0);
  // Enough content: a release is requested. While it waits for reviewers, later cycles do not stack more releases.
  time.advance(24);
  exec("priya", ["author"], { action: "register_dataset", projectId: p.id, name: "Full notes", source: { kind: "inline", text: notes(80, "full") } });
  [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.status, "complete");
  time.advance(24);
  exec("priya", ["author"], { action: "register_dataset", projectId: p.id, name: "More notes", source: { kind: "inline", text: notes(80, "more") } });
  [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.status, "stopped");
  assert.match(run.summary, /waiting for approval/i);
  assert.equal(studio.snapshot(W).releases.length, 1, "one pending release at a time");
});

test("the local import folder is watched by pattern, files are picked up once, and the cycle runs as a manual request too", () => {
  const time = clock();
  const dir = mkdtempSync(join(tmpdir(), "magentic-learning-"));
  const imports = join(dir, "import");
  const studio = fileModelStudio(join(dir, "studio"), imports, { now: time.now });
  const { project: p } = project(studio);
  const learning = createLearningSchedule({ studio, now: time.now, imports: folderImports(imports) });
  learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "manual", pattern: "case-notes-*.jsonl" });
  assert.equal(learning.snapshot(W).schedules[0]!.nextRunAt, null, "manual schedules never come due on their own");
  assert.deepEqual(learning.tick(W), []);
  writeFileSync(join(imports, "case-notes-2026-09.jsonl"), notes(80, "september"));
  writeFileSync(join(imports, "unrelated.jsonl"), notes(5, "other"));
  writeFileSync(join(imports, "case-notes-readme.txt"), "not data");
  const run = learning.runNow(W, "priya", ["author"], p.id);
  assert.equal(run.trigger, "manual");
  assert.equal(run.status, "complete");
  assert.match(run.steps[0]!.detail, /case-notes-2026-09\.jsonl/);
  assert.doesNotMatch(run.steps[0]!.detail, /unrelated/);
  const after = studio.snapshot(W);
  assert.deepEqual(after.datasets.map((dataset) => dataset.name), ["case-notes-2026-09.jsonl"]);
  assert.equal(after.releases.length, 1);
  // The same file again is not registered twice; a new file is.
  const second = learning.runNow(W, "priya", ["author"], p.id);
  assert.equal(second.steps[0]!.outcome, "skipped");
  writeFileSync(join(imports, "case-notes-2026-10.jsonl"), notes(80, "october"));
  const third = learning.runNow(W, "priya", ["author"], p.id);
  assert.match(third.steps[0]!.detail, /case-notes-2026-10\.jsonl/);
  assert.equal(studio.snapshot(W).datasets.length, 2);
  assert.match(third.summary, /waiting for approval/i, "the October notes are validated but the September release is still pending");
});

test("schedules belong to authors, follow the project, and persist", () => {
  const time = clock();
  const stored = new Map<string, LearningState>();
  const persistence: LearningPersistence = { read: (workspace) => stored.get(workspace), commit: (workspace, state) => { stored.set(workspace, structuredClone(state)); } };
  const studio = memoryModelStudio({ now: time.now });
  const { exec, project: p } = project(studio);
  const learning = createLearningSchedule({ studio, now: time.now, persistence });
  assert.throws(() => learning.set(W, "sam", ["approver"], { projectId: p.id, cadence: "daily" }), /author/i);
  assert.throws(() => learning.set(W, "priya", ["author"], { projectId: "00000000-0000-4000-8000-000000000000", cadence: "daily" }), /project/i);
  learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "daily" });
  assert.equal(stored.get(W)!.schedules.length, 1);
  // Pausing keeps the schedule but stops the clock; resuming makes it due again.
  learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "daily", paused: true });
  assert.deepEqual(learning.tick(W), []);
  learning.set(W, "priya", ["author"], { projectId: p.id, cadence: "daily", paused: false });
  assert.equal(learning.tick(W).length, 1);
  // An archived project ends its schedule with the reason on the last run.
  exec("priya", ["author"], { action: "archive_project", projectId: p.id });
  time.advance(24);
  const [run] = learning.tick(W) as [LearningRun];
  assert.equal(run.status, "stopped");
  assert.match(run.summary, /archived/);
  assert.equal(learning.snapshot(W).schedules[0]!.paused, true, "an archived project's schedule is paused, not deleted");
  // A fresh engine reads the same state back.
  const again = createLearningSchedule({ studio, now: time.now, persistence });
  assert.equal(again.snapshot(W).runs.length, 2);
  assert.equal(again.snapshot(W).schedules[0]!.paused, true);
});
