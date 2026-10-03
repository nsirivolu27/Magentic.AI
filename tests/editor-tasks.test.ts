import assert from "node:assert/strict";
import test from "node:test";
import { EditorTaskHistory } from "../workbench/editor-tasks.js";

function fixture() {
  let time = 1000, updates = 0;
  const execution = {};
  const processes = new Set<(event: { execution: object; exitCode: number | undefined }) => void>();
  const ends = new Set<(event: { execution: object }) => void>();
  const api = {
    onDidEndTaskProcess(listener: (event: { execution: object; exitCode: number | undefined }) => void) { processes.add(listener); return { dispose() { processes.delete(listener); } }; },
    onDidEndTask(listener: (event: { execution: object }) => void) { ends.add(listener); return { dispose() { ends.delete(listener); } }; },
    async executeTask(_task: unknown) { return execution; },
  };
  const history = new EditorTaskHistory(api, () => updates++, () => time);
  return { history, api, execution, processes, ends, tick() { time += 500; }, updates: () => updates,
    exit(code: number | undefined, target = execution) { for (const listener of processes) listener({ execution: target, exitCode: code }); },
    end(target = execution) { for (const listener of ends) listener({ execution: target }); } };
}

test("task outcomes record success and failure only from the matching process", async () => {
  const f = fixture();
  await f.history.start("a", "tests", {});
  f.exit(0, {});
  assert.equal(f.history.snapshot("a")[0]?.status, "running");
  assert.equal(f.history.snapshot("b").length, 0);
  f.tick(); f.exit(1);
  const failed = f.history.snapshot("a")[0]!;
  assert.equal(failed.exitCode, 1); assert.equal(failed.status, "exited"); assert.equal(failed.durationMs, 500);
  assert.equal(f.history.busy, false); assert.equal(f.processes.size, 0); assert.equal(f.ends.size, 0);
  await f.history.start("a", "build", {}); f.exit(0);
  assert.equal(f.history.snapshot("a")[0]?.exitCode, 0);
});

test("a fast exit before executeTask resolves is retained without capturing another task", async () => {
  const f = fixture();
  f.api.executeTask = async () => { f.exit(0, {}); f.exit(2); f.end(); return f.execution; };
  await f.history.start("a", "fast", {});
  assert.equal(f.history.snapshot("a")[0]?.exitCode, 2);
});

test("terminated processes and tasks without a process result remain unknown", async () => {
  const f = fixture(); await f.history.start("a", "cancelled", {}); f.exit(undefined);
  assert.equal(f.history.snapshot("a")[0]?.status, "unknown"); assert.equal(f.history.snapshot("a")[0]?.exitCode, null);
  await f.history.start("a", "custom", {}); f.end();
  assert.equal(f.history.snapshot("a")[0]?.status, "unknown");
});

test("launch failures and disposal release listeners and never report success", async () => {
  const f = fixture(); f.api.executeTask = async () => { throw new Error("launch denied"); };
  await assert.rejects(f.history.start("a", "bad", {}), /launch denied/);
  assert.equal(f.history.snapshot("a")[0]?.status, "launch-error"); assert.equal(f.history.busy, false);
  f.api.executeTask = async () => f.execution;
  await f.history.start("a", "long", {});
  await assert.rejects(f.history.start("a", "duplicate", {}), /Wait/);
  f.history.dispose(); assert.equal(f.history.snapshot("a")[0]?.status, "unknown");
  assert.equal(f.processes.size, 0); assert.equal(f.ends.size, 0);
});

test("history is bounded, snapshots cannot change records, and folders remain separate", async () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) { await f.history.start("a", String(i), {}); f.exit(i); }
  await f.history.start("b", "other folder", {}); f.exit(0);
  assert.equal(f.history.snapshot("a").length, 5);
  const results = f.history.snapshot("a"); results[0]!.exitCode = 0;
  assert.equal(f.history.snapshot("a")[0]?.exitCode, 6);
  assert.equal(f.history.snapshot("b")[0]?.label, "other folder");
});
