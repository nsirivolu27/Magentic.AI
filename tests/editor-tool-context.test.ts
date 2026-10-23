import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEditorRequest } from "../workbench/editor-session.js";

test("model observations contain file text directly instead of nested MCP envelopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "magentic-tool-context-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "answer.txt"), "The build command is pnpm build.\n");
  execFileSync("git", ["add", "answer.txt"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  let calls = 0;
  const model = { async invoke(prompt: string) {
    if (++calls === 1) return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "answer.txt" } }) };
    const observations = JSON.parse(prompt.split("\n").find(line => line.startsWith("OBSERVATIONS: "))!.slice("OBSERVATIONS: ".length));
    assert.deepEqual(observations[0].result, { path: "answer.txt", content: "The build command is pnpm build.\n" });
    return { content: JSON.stringify({ type: "result", summary: "Changed command", changes: [{ path: "answer.txt", content: observations[0].result.content.replace("pnpm build", "pnpm test") }] }) };
  } };
  const proposal = await runEditorRequest(root, { mode: "edit", prompt: "Change the command" }, model, "fixture", new AbortController().signal);
  assert.equal(proposal.changes[0]?.after, "The build command is pnpm test.\n");
});
