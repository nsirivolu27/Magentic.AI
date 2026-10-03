import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileWorkspaceStore, STORAGE_VERSION, StorageError, workspacesDirectory } from "../workbench/storage.js";
import { DEFAULT_PIPELINE, filePipelines, memoryPipelines, PipelineError } from "../workbench/pipeline.js";
import type { Role } from "../registry/roles.js";

const ADMIN: readonly Role[] = ["admin"];
const AUTHOR: readonly Role[] = ["author"];
const APPROVER: readonly Role[] = ["approver"];
const WS = "dos-consular";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "magentic-store-"));
}

/** A store plus an engine over it, as the application composes them. */
function open(directory: string) {
  const store = fileWorkspaceStore(directory);
  return { store, engine: filePipelines(store) };
}

function startRun(engine: ReturnType<typeof filePipelines>, requestId: string, title = "Ship the intake flow") {
  return engine.execute(WS, "a.rivera", AUTHOR, {
    action: "start", requestId, title, brief: "Capture the problem and acceptance criteria.",
  }, 1);
}

test("work saved in one process is there when the workspace is reopened", () => {
  const dir = scratch();
  const first = open(dir);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const before = startRun(first.engine, requestId);
  assert.equal(before.runs.length, 1);
  first.store.close();

  const second = open(dir);
  const after = second.engine.snapshot(WS);
  assert.equal(after.runs.length, 1, "the run survives a reopen");
  assert.equal(after.runs[0]?.id, before.runs[0]?.id);
  assert.equal(after.runs[0]?.title, "Ship the intake flow");
  assert.equal(after.storage, "file");
  second.store.close();
});

test("a run keeps the configuration and approval threshold it started with", () => {
  const dir = scratch();
  const first = open(dir);
  first.engine.execute(WS, "s.patel", ADMIN, {
    action: "start", requestId: "22222222-2222-4222-8222-222222222222",
    title: "First run", brief: "Started before the config changed.",
  }, 2);
  const changed = { ...structuredClone(DEFAULT_PIPELINE), name: "Changed afterwards" };
  first.engine.execute(WS, "s.patel", ADMIN, { action: "configure", expectedVersion: 1, config: changed }, 1);
  first.store.close();

  const second = open(dir);
  const snapshot = second.engine.snapshot(WS);
  assert.equal(snapshot.config.name, "Changed afterwards", "the workspace config moved on");
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.runs[0]?.config.name, DEFAULT_PIPELINE.name, "the run keeps its own snapshot");
  assert.equal(snapshot.runs[0]?.version, 1);
  assert.equal(snapshot.runs[0]?.requiredApprovals, 2, "the threshold it started under survives");
  second.store.close();
});

test("the same request id does not start a second run after a restart", () => {
  const dir = scratch();
  const requestId = "33333333-3333-4333-8333-333333333333";
  const first = open(dir);
  startRun(first.engine, requestId);
  first.store.close();

  const second = open(dir);
  const again = startRun(second.engine, requestId);
  assert.equal(again.runs.length, 1, "duplicate protection survives the restart");
  assert.throws(
    () => startRun(second.engine, requestId, "Different work under the same id"),
    (error: unknown) => error instanceof PipelineError && error.status === 409,
  );
  second.store.close();
});

test("a stale revision is refused after a restart", () => {
  const dir = scratch();
  const first = open(dir);
  const started = startRun(first.engine, "44444444-4444-4444-8444-444444444444");
  const runId = started.runs[0]!.id;
  first.engine.execute(WS, "a.rivera", AUTHOR, { action: "complete", runId, expectedRevision: 1, note: "Intake done." }, 1);
  first.store.close();

  const second = open(dir);
  assert.throws(
    () => second.engine.execute(WS, "a.rivera", AUTHOR, { action: "pause", runId, expectedRevision: 1 }, 1),
    (error: unknown) => error instanceof PipelineError && error.status === 409,
  );
  second.store.close();
});

test("one workspace cannot see or act on another's runs", () => {
  const dir = scratch();
  const { store, engine } = open(dir);
  const started = startRun(engine, "55555555-5555-4555-8555-555555555555");
  const runId = started.runs[0]!.id;
  assert.equal(engine.snapshot("other-workspace").runs.length, 0);
  assert.throws(
    () => engine.execute("other-workspace", "a.rivera", AUTHOR, { action: "pause", runId, expectedRevision: 1 }, 1),
    (error: unknown) => error instanceof PipelineError && error.status === 404,
  );
  store.close();
});

test("a malformed document is refused and left on disk", () => {
  const dir = scratch();
  const first = open(dir);
  startRun(first.engine, "66666666-6666-4666-8666-666666666666");
  first.store.close();

  const probe = fileWorkspaceStore(dir);
  const file = probe.pathFor(WS);
  probe.close();
  writeFileSync(file, "{ not json at all", "utf8");
  const second = open(dir);
  assert.throws(() => second.engine.snapshot(WS), (error: unknown) => error instanceof StorageError);
  assert.equal(readFileSync(file, "utf8"), "{ not json at all", "corrupt data is never replaced with an empty workspace");
  second.store.close();
});

test("an unknown storage version is refused with an actionable error", () => {
  const dir = scratch();
  const first = open(dir);
  startRun(first.engine, "77777777-7777-4777-8777-777777777777");
  first.store.close();

  const probe = fileWorkspaceStore(dir);
  const file = probe.pathFor(WS);
  probe.close();
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  document.storageVersion = STORAGE_VERSION + 1;
  writeFileSync(file, JSON.stringify(document), "utf8");

  const second = open(dir);
  assert.throws(
    () => second.engine.snapshot(WS),
    (error: unknown) => error instanceof StorageError && /storage version/i.test(error.message),
  );
  second.store.close();
});

test("a document whose contents contradict themselves is refused", () => {
  const dir = scratch();
  const first = open(dir);
  const started = startRun(first.engine, "88888888-8888-4888-8888-888888888888");
  first.store.close();

  const probe = fileWorkspaceStore(dir);
  const file = probe.pathFor(WS);
  probe.close();
  const document = JSON.parse(readFileSync(file, "utf8")) as { runs: { current: number }[] };
  document.runs[0]!.current = 99;               // past the end of its own stage list
  writeFileSync(file, JSON.stringify(document), "utf8");

  const second = open(dir);
  assert.throws(() => second.engine.snapshot(WS), (error: unknown) => error instanceof StorageError);
  assert.ok(started.runs[0]);
  second.store.close();
});

test("a failed commit leaves the previous state visible and unchanged", () => {
  const dir = scratch();
  const { store, engine } = open(dir);
  startRun(engine, "99999999-9999-4999-8999-999999999999");
  const before = engine.snapshot(WS);

  // The next commit cannot be written. The command must not appear to succeed.
  store.failNextCommit(new Error("disk full"));
  assert.throws(() => startRun(engine, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Second run"), (error: unknown) => error instanceof Error && /disk full/.test(error.message));

  assert.deepEqual(engine.snapshot(WS).runs.map((run: { id: string }) => run.id), before.runs.map((run: { id: string }) => run.id),
    "the in-memory view must not keep a change that was never committed");
  store.close();

  const reopened = open(dir);
  assert.equal(reopened.engine.snapshot(WS).runs.length, 1, "and the durable view must not either");
  reopened.store.close();
});

test("a temporary file left by an interrupted write is cleaned up and ignored", () => {
  const dir = scratch();
  const first = open(dir);
  startRun(first.engine, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  first.store.close();

  // What a crash between writing the temp file and renaming it leaves behind.
  const probe = fileWorkspaceStore(dir);
  writeFileSync(`${probe.pathFor(WS)}.tmp-deadbeef`, "{ half written", "utf8");
  probe.close();

  const second = open(dir);
  assert.equal(second.engine.snapshot(WS).runs.length, 1, "the previous document is still the live one");
  assert.equal(readdirSync(dir).filter((name) => name.includes(".tmp-")).length, 0, "the stray temp file is swept");
  second.store.close();
});

test("a second writer is refused while another holds the lock", () => {
  const dir = scratch();
  const first = open(dir);
  assert.throws(
    () => fileWorkspaceStore(dir),
    (error: unknown) => error instanceof StorageError && /another instance|already/i.test(error.message),
  );
  first.store.close();
  // Once released, a new writer may take it.
  const second = open(dir);
  second.store.close();
});

test("a lock this instance does not own is never removed", () => {
  const dir = scratch();
  const first = open(dir);
  const lock = join(dir, ".writer.lock");
  const mine = readFileSync(lock, "utf8");
  writeFileSync(lock, JSON.stringify({ owner: "someone-else", pid: 999999, at: new Date().toISOString() }), "utf8");
  first.store.close();
  assert.notEqual(readFileSync(lock, "utf8"), mine, "closing must not delete a lock rewritten by someone else");
});

test("approval evidence and content hashes survive a reload", () => {
  const dir = scratch();
  const first = open(dir);
  const started = first.engine.execute(WS, "a.rivera", AUTHOR, {
    action: "start", requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Design the storage boundary", brief: "Write it down.",
  }, 1);
  const runId = started.runs[0]!.id;
  // Walk to the first stage that needs review.
  let revision = 1;
  let snapshot = started;
  for (let guard = 0; guard < 6; guard++) {
    snapshot = first.engine.execute(WS, "a.rivera", AUTHOR, { action: "complete", runId, expectedRevision: revision, note: `Stage ${guard} output.` }, 1);
    revision = snapshot.runs[0]!.revision;
    if (snapshot.runs[0]!.stages[snapshot.runs[0]!.current]!.status === "awaiting_review") break;
  }
  const awaiting = snapshot.runs[0]!;
  const hash = awaiting.stages[awaiting.current]!.outputHash;
  assert.match(hash, /^[0-9a-f]{64}$/);
  first.store.close();

  const second = open(dir);
  const reloaded = second.engine.snapshot(WS).runs[0]!;
  assert.equal(reloaded.stages[reloaded.current]!.outputHash, hash, "the hash is preserved exactly");

  // The author still cannot approve their own output after a reload.
  assert.throws(
    () => second.engine.execute(WS, "a.rivera", APPROVER, { action: "approve", runId, expectedRevision: reloaded.revision }, 1),
    (error: unknown) => error instanceof PipelineError && error.status === 403,
  );
  const approved = second.engine.execute(WS, "m.okafor", APPROVER, { action: "approve", runId, expectedRevision: reloaded.revision }, 1);
  assert.deepEqual(approved.runs[0]!.stages[reloaded.current]!.approvals, ["m.okafor"]);
  second.store.close();
});

test("a workspace name that is not a safe file name is refused", () => {
  const dir = scratch();
  const { store, engine } = open(dir);
  for (const bad of ["../escape", "a/b", "..", ""]) {
    assert.throws(() => engine.snapshot(bad), (error: unknown) => error instanceof StorageError || error instanceof PipelineError);
  }
  store.close();
});

test("two workspace names cannot collide on one file", () => {
  const dir = scratch();
  const { store, engine } = open(dir);
  startRun(engine, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  engine.execute("DOS-CONSULAR", "a.rivera", AUTHOR, {
    action: "start", requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    title: "Different workspace", brief: "Should not overwrite the other one.",
  }, 1);
  assert.equal(engine.snapshot(WS).runs[0]?.title, "Ship the intake flow");
  assert.equal(engine.snapshot("DOS-CONSULAR").runs[0]?.title, "Different workspace");
  store.close();
});

test("the default workspaces directory sits under the desktop application's data folder", () => {
  const win = workspacesDirectory({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32");
  assert.match(win, /MagenticDeveloper[\\/]data[\\/]workspaces$/);
  assert.equal(workspacesDirectory({ MAGENTIC_WORKSPACES_DIR: "/tmp/elsewhere" }, "win32"), "/tmp/elsewhere");
});

test("memoryPipelines is unchanged and still reports memory storage", () => {
  const engine = memoryPipelines();
  const snapshot = engine.execute(WS, "a.rivera", AUTHOR, {
    action: "start", requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    title: "In memory only", brief: "Nothing is written to disk.",
  }, 1);
  assert.equal(snapshot.storage, "memory");
  assert.equal(snapshot.runs.length, 1);
});
