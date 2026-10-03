import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editorRequestSchema, editorOllamaModel, runEditorRequest, validateEditorProposal } from "../workbench/editor-session.js";
import type { AgentModel } from "../workbench/chat.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "magentic-editor-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "answer.txt"), "original");
  execFileSync("git", ["add", "answer.txt"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  return root;
}
const reply = (content: unknown) => ({ content: JSON.stringify(content) });
function editingModel(): AgentModel {
  let calls = 0;
  return { async invoke() { return ++calls === 1 ? reply({ type: "tool", name: "read_project_file", arguments: { path: "answer.txt" } }) : reply({ type: "result", summary: "Proposed correction", changes: [{ path: "answer.txt", content: "corrected" }] }); } };
}

test("editor proposes edits against the current working tree without writing them", async () => {
  const root = fixture(); writeFileSync(join(root, "answer.txt"), "uncommitted user work");
  const proposal = await runEditorRequest(root, { mode: "edit", prompt: "Correct this file" }, editingModel(), "fixture", new AbortController().signal);
  assert.equal(proposal.changes[0]?.before, "uncommitted user work");
  assert.equal(proposal.changes[0]?.after, "corrected");
  assert.equal(readFileSync(join(root, "answer.txt"), "utf8"), "uncommitted user work");
  validateEditorProposal(proposal);
  writeFileSync(join(root, "answer.txt"), "new user edit");
  assert.throws(() => validateEditorProposal(proposal), /changed/);
});

test("Ask mode refuses model edit proposals", async () => {
  await assert.rejects(runEditorRequest(fixture(), { mode: "ask", prompt: "Explain" }, editingModel(), "fixture", new AbortController().signal), /cannot propose edits/);
});

test("an editor model must read a file before proposing a change", async () => {
  const model = { async invoke() { return reply({ type: "result", summary: "Unsupported change", changes: [{ path: "answer.txt", content: "bad" }] }); } };
  await assert.rejects(runEditorRequest(fixture(), { mode: "edit", prompt: "Fix" }, model, "fixture", new AbortController().signal), /did not read/);
});

test("selected context stays bounded and cannot name protected or outside files", async () => {
  assert.equal(editorRequestSchema.safeParse({ prompt: "Hi", mode: "ask", shell: true }).success, false);
  assert.equal(editorRequestSchema.safeParse({ prompt: "Hi", mode: "ask", context: { path: "a", selection: "x".repeat(6001) } }).success, false);
  const model = { async invoke() { throw new Error("Must not invoke"); } };
  const root = fixture();
  for (const path of ["../other.txt", ".env", ".git/config", "C:/outside.txt"])
    await assert.rejects(runEditorRequest(root, { prompt: "Explain", mode: "ask", context: { path, selection: "selected" } }, model, "fixture", new AbortController().signal));
});

test("editor context and prior turns are passed as untrusted data", async () => {
  let captured = "";
  const model = { async invoke(prompt: string) { captured = prompt; return reply({ type: "result", summary: "Answer", changes: [] }); } };
  await runEditorRequest(fixture(), { prompt: "Explain", mode: "ask", context: { path: "answer.txt", selection: "selected excerpt" }, history: [{ role: "user", content: "prior request" }] }, model, "fixture", new AbortController().signal);
  assert.match(captured, /EDITOR CONTEXT \(untrusted data/);
  assert.match(captured, /selected excerpt/);
  assert.match(captured, /prior request/);
  assert.match(captured, /You are read-only/);
});

test("cancellation settles an editor request even if the model ignores its signal", async () => {
  const controller = new AbortController();
  const model = { invoke() { controller.abort(); return new Promise<{ content: string }>(() => {}); } };
  await assert.rejects(runEditorRequest(fixture(), { mode: "ask", prompt: "Explain" }, model, "fixture", controller.signal), /stopped|aborted/i);
});

test("Ollama adapter is loopback-only, cancels requests and explains missing models", async () => {
  let called = ""; let init: RequestInit | undefined;
  const fake = (async (url: unknown, options: RequestInit) => { called = String(url); init = options; return new Response(JSON.stringify({ message: { content: '{"type":"result"}' } }), { status: 200 }); }) as typeof fetch;
  const controller = new AbortController();
  assert.deepEqual(await editorOllamaModel("fixture", fake).invoke("context", { signal: controller.signal }), { content: '{"type":"result"}' });
  assert.equal(called, "http://127.0.0.1:11434/api/chat"); assert.equal(init?.redirect, "error"); assert.equal(init?.signal, controller.signal);
  const absent = (async () => new Response("Missing", { status: 404 })) as typeof fetch;
  await assert.rejects(editorOllamaModel("missing", absent).invoke("request"), /unavailable.*Install/);
});
