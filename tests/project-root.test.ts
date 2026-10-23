import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspectProject } from "../workbench/bot-project.js";
import { runEditorRequest } from "../workbench/editor-session.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "magentic-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "example.txt"), "practice");
  execFileSync("git", ["add", "example.txt"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  return root;
}

test("repository inspection accepts the root but still refuses a subdirectory", async t => {
  const root = fixture(t);
  const project = await inspectProject({ root, checks: [] });
  assert.equal(project.root, realpathSync.native(root));
  mkdirSync(join(root, "src"));
  await assert.rejects(inspectProject({ root: join(root, "src"), checks: [] }), /Select the repository root/);
});

test("Windows editor requests accept a lowercase drive letter and reach the model", { skip: process.platform !== "win32" }, async t => {
  const root = fixture(t);
  assert.match(root, /^[A-Za-z]:/);
  const editorPath = root[0]!.toLowerCase() + root.slice(1);
  let calls = 0;
  const result = await runEditorRequest(editorPath, { prompt: "Explain the project", mode: "ask" }, {
    async invoke() {
      calls++;
      return { content: JSON.stringify({ type: "result", summary: "Practice project", changes: [] }) };
    },
  }, "fixture", new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.root, realpathSync.native(root));
  assert.deepEqual(result.changes, []);
});
