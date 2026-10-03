import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EDITOR_AGENTS, editorAgentSchema } from "../workbench/editor-agents.js";
import { editorRequestSchema, runEditorRequest } from "../workbench/editor-session.js";

function project() {
  const root = mkdtempSync(join(tmpdir(), "magentic-agent-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "example.js"), "export const answer = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  return root;
}
const reply = (value: unknown) => ({ content: JSON.stringify(value) });

test("editor phases select real worker roles and preserve labeled cross-agent context", async () => {
  const root = project();
  for (const agent of editorAgentSchema.options) {
    const definition = EDITOR_AGENTS[agent];
    let captured = "";
    const model = { async invoke(prompt: string) { captured = prompt; return reply({ type: "result", summary: "Observed result; checks not run", changes: [] }); } };
    await runEditorRequest(root, { agent, mode: definition.mode, prompt: "Help with this phase", history: [{ role: "assistant", content: "Previous plan", agent: "plan" }] }, model, "fixture", new AbortController().signal);
    assert.match(captured, new RegExp(`You are the ${definition.kind} bot for phase ${definition.label}`));
    assert.ok(captured.includes(definition.instructions));
    assert.match(captured, /"agent":"plan"/);
    assert.match(captured, /Previous plan/);
    if (agent === "test") assert.match(captured, /no verified command results/);
  }
});

test("read-only editor agents refuse edits even if a model ignores the phase instructions", async () => {
  const root = project();
  for (const agent of ["understand", "plan", "review", "test"] as const) {
    let calls = 0;
    const model = { async invoke() { return ++calls === 1
      ? reply({ type: "tool", name: "read_project_file", arguments: { path: "example.js" } })
      : reply({ type: "result", summary: "Attempted edit", changes: [{ path: "example.js", content: "bad" }] }); } };
    await assert.rejects(runEditorRequest(root, { agent, mode: "ask", prompt: "Inspect" }, model, "fixture", new AbortController().signal), /cannot propose edits/);
  }
  assert.equal(readFileSync(join(root, "example.js"), "utf8"), "export const answer = 1;\n");
});

test("Build agent creates a reviewable proposal without modifying the workspace", async () => {
  const root = project(); let calls = 0;
  const model = { async invoke() { return ++calls === 1
    ? reply({ type: "tool", name: "read_project_file", arguments: { path: "example.js" } })
    : reply({ type: "result", summary: "Proposed correction", changes: [{ path: "example.js", content: "export const answer = 2;\n" }] }); } };
  const result = await runEditorRequest(root, { agent: "build", mode: "edit", prompt: "Correct the answer" }, model, "fixture", new AbortController().signal);
  assert.equal(result.changes[0]?.after, "export const answer = 2;\n");
  assert.equal(readFileSync(join(root, "example.js"), "utf8"), "export const answer = 1;\n");
});

test("unknown or mismatched editor agents fail before repository or model access", async () => {
  const model = { async invoke() { assert.fail("Model must not be called"); } };
  for (const request of [{ agent: "deploy", mode: "edit" }, { agent: "review", mode: "edit" }, { agent: "build", mode: "ask" }]) {
    await assert.rejects(runEditorRequest("does-not-exist", { ...request, prompt: "Work" }, model, "fixture", new AbortController().signal));
  }
  assert.equal(editorRequestSchema.safeParse({ prompt: "Legacy ask", mode: "ask" }).success, true);
  assert.equal(editorRequestSchema.safeParse({ prompt: "Legacy edit", mode: "edit" }).success, true);
});
