import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileWorkspaceStore, StorageError } from "../workbench/storage.js";
import { filePipelines } from "../workbench/pipeline.js";
import type { Role } from "../registry/roles.js";

const AUTHOR: readonly Role[] = ["author"];

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "magentic-integrity-"));
}

function seeded(dir: string, workspace: string, requestId: string) {
  const store = fileWorkspaceStore(dir);
  const engine = filePipelines(store);
  engine.execute(workspace, "a.rivera", AUTHOR, {
    action: "start", requestId, title: "A run", brief: "Something to persist.",
  }, 1);
  return { store, engine };
}

/** Read a workspace's document, mutate it on disk, and reopen. */
function tamper(dir: string, workspace: string, change: (document: any) => void): void {
  const probe = fileWorkspaceStore(dir);
  const path = probe.pathFor(workspace);
  probe.close();
  const document = JSON.parse(readFileSync(path, "utf8"));
  change(document);
  writeFileSync(path, JSON.stringify(document), "utf8");
}

test("a commit will not overwrite a document belonging to another workspace", () => {
  const dir = scratch();
  const first = seeded(dir, "alpha", "11111111-1111-4111-8111-111111111111");
  const alphaPath = first.store.pathFor("alpha");
  first.store.close();

  // Put alpha's document where beta would write. A hash collision is what
  // this simulates; the guard must not depend on collisions being rare.
  const second = fileWorkspaceStore(dir);
  const betaPath = second.pathFor("beta");
  writeFileSync(betaPath, readFileSync(alphaPath, "utf8"), "utf8");
  const engine = filePipelines(second);

  assert.throws(
    () => engine.execute("beta", "a.rivera", AUTHOR, {
      action: "start", requestId: "22222222-2222-4222-8222-222222222222",
      title: "Beta run", brief: "Must not clobber alpha.",
    }, 1),
    (error: unknown) => error instanceof StorageError && /belongs to workspace|labelled alpha/i.test(error.message),
  );
  second.close();

  // Alpha's data is intact where it was planted.
  const planted = JSON.parse(readFileSync(betaPath, "utf8")) as { workspaceId: string };
  assert.equal(planted.workspaceId, "alpha");
});

test("commit itself refuses a file that names a different workspace", () => {
  // The read path guards the same collision, so this exercises the write
  // guard directly: a store that never read the file still must not
  // overwrite it.
  const dir = scratch();
  const first = seeded(dir, "alpha", "77777777-7777-4777-8777-777777777777");
  const alphaDocument = readFileSync(first.store.pathFor("alpha"), "utf8");
  const state = first.engine.snapshot("alpha");
  first.store.close();

  const store = fileWorkspaceStore(dir);
  const betaPath = store.pathFor("beta");
  writeFileSync(betaPath, alphaDocument, "utf8");
  assert.throws(
    () => store.commit("beta", { config: state.config, version: state.version, runs: [] }),
    (error: unknown) => error instanceof StorageError && /belongs to workspace alpha/i.test(error.message),
  );
  store.close();

  const untouched = JSON.parse(readFileSync(betaPath, "utf8")) as { workspaceId: string };
  assert.equal(untouched.workspaceId, "alpha", "the other workspace's document is left exactly as it was");
});

test("workspace names that sanitize alike still get separate files", () => {
  const dir = scratch();
  const store = fileWorkspaceStore(dir);
  const paths = new Set(["a b", "a_b", "a-b", "A_B"].map((name) => store.pathFor(name)));
  assert.equal(paths.size, 4, "sanitizing must not merge distinct workspace ids");
  store.close();
});

test("the file name carries enough hash to make collision implausible", () => {
  const dir = scratch();
  const store = fileWorkspaceStore(dir);
  const name = store.pathFor("dos-consular").split(/[\\/]/).pop()!;
  const hash = name.replace(/\.json$/, "").split("-").pop()!;
  assert.ok(hash.length >= 32, `expected at least 128 bits of hash, got ${hash.length} hex chars`);
  store.close();
});

test("a stage marked complete after the current one is refused", () => {
  const dir = scratch();
  const first = seeded(dir, "gamma", "33333333-3333-4333-8333-333333333333");
  first.store.close();
  tamper(dir, "gamma", (document) => { document.runs[0].stages[3].status = "complete"; });

  const store = fileWorkspaceStore(dir);
  const engine = filePipelines(store);
  assert.throws(() => engine.snapshot("gamma"), (error: unknown) => error instanceof StorageError);
  store.close();
});

test("a stage before the current one that is not complete is refused", () => {
  const dir = scratch();
  const first = seeded(dir, "delta", "44444444-4444-4444-8444-444444444444");
  first.store.close();
  tamper(dir, "delta", (document) => {
    const run = document.runs[0];
    run.current = 2;
    run.stages[2].status = "active";
    // stages 0 and 1 are left "pending", which the engine could never produce
  });

  const store = fileWorkspaceStore(dir);
  const engine = filePipelines(store);
  assert.throws(() => engine.snapshot("delta"), (error: unknown) => error instanceof StorageError);
  store.close();
});

test("a gated stage completed without enough approvals is refused", () => {
  const dir = scratch();
  const first = seeded(dir, "epsilon", "55555555-5555-4555-8555-555555555555");
  first.store.close();
  tamper(dir, "epsilon", (document) => {
    const run = document.runs[0];
    run.requiredApprovals = 2;
    // "design" is a gated stage in the default pipeline. Mark it complete
    // with a single signature, which the engine would never advance past.
    const gated = run.config.stages.findIndex((stage: { approval: boolean }) => stage.approval);
    run.current = gated + 1;
    for (let i = 0; i <= gated; i++) {
      run.stages[i].status = "complete";
      run.stages[i].output = "done";
      // A correct hash, so this test exercises the approval gate rather than
      // tripping the hash check on the way in.
      run.stages[i].outputHash = createHash("sha256").update("done").digest("hex");
      run.stages[i].outputBy = "a.rivera";
    }
    run.stages[gated].approvals = ["m.okafor"];
    run.stages[gated + 1].status = "active";
  });

  const store = fileWorkspaceStore(dir);
  const engine = filePipelines(store);
  assert.throws(
    () => engine.snapshot("epsilon"),
    (error: unknown) => error instanceof StorageError,
    "a gate cannot be passed by editing the file",
  );
  store.close();
});

test("a run whose config version is ahead of the workspace is refused", () => {
  const dir = scratch();
  const first = seeded(dir, "zeta", "66666666-6666-4666-8666-666666666666");
  first.store.close();
  tamper(dir, "zeta", (document) => { document.runs[0].version = document.version + 5; });

  const store = fileWorkspaceStore(dir);
  const engine = filePipelines(store);
  assert.throws(() => engine.snapshot("zeta"), (error: unknown) => error instanceof StorageError);
  store.close();
});
