import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import test from "node:test";

const bundle = buildSync({ entryPoints: ["extensions/vscode/extension.mjs"], bundle: true, write: false, format: "cjs", platform: "node", external: ["vscode"] }).outputFiles[0]!.text;
const require = createRequire(import.meta.url);

class Uri {
  constructor(readonly scheme: string, readonly fsPath: string) {}
  toString() { return `${this.scheme}:${this.fsPath}`; }
  static file(path: string) { return new Uri("file", path); }
  static from(value: { scheme: string; path: string }) { return new Uri(value.scheme, value.path); }
  static joinPath(uri: Uri, ...paths: string[]) { return Uri.file(join(uri.fsPath, ...paths)); }
}
class WorkspaceEdit {
  operations: unknown[] = [];
  replace(uri: Uri, range: unknown, content: string) { this.operations.push({ type: "replace", uri, range, content }); }
  createFile(uri: Uri, options: unknown) { this.operations.push({ type: "create", uri, options }); }
  insert(uri: Uri, position: unknown, content: string) { this.operations.push({ type: "insert", uri, position, content }); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "magentic-extension-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "answer.txt"), "original");
  execFileSync("git", ["add", "answer.txt"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  let provider: any;
  const applied: WorkspaceEdit[] = [];
  const calls: unknown[][] = [];
  const document = { uri: Uri.file(join(root, "answer.txt")), isDirty: false, version: 1, getText() { return readFileSync(this.uri.fsPath, "utf8"); }, positionAt(offset: number) { return offset; } };
  const disposable = { dispose() {} };
  const api = {
    Uri, WorkspaceEdit, Position: class { constructor(..._args: unknown[]) {} }, Range: class { constructor(..._args: unknown[]) {} },
    ConfigurationTarget: { Global: 1 },
    window: { registerWebviewViewProvider(_id: string, value: unknown) { provider = value; return disposable; }, onDidChangeActiveTextEditor() { return disposable; } },
    commands: { registerCommand() { return disposable; }, async executeCommand(...args: unknown[]) { calls.push(args); } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: Uri.file(root), name: "fixture" }], textDocuments: [document],
      registerTextDocumentContentProvider() { return disposable; }, onDidChangeWorkspaceFolders() { return disposable; }, onDidGrantWorkspaceTrust() { return disposable; }, onDidChangeConfiguration() { return disposable; },
      getConfiguration() { return { get(_name: string, fallback: unknown) { return fallback; } }; },
      async openTextDocument() { return document; }, async applyEdit(edit: WorkspaceEdit) { applied.push(edit); return true; } },
  };
  const module = { exports: {} as { activate(context: unknown): void } };
  new Function("require", "module", "exports", bundle)((name: string) => name === "vscode" ? api : require(name), module, module.exports);
  const globalState = new Map<string, unknown>();
  module.exports.activate({ subscriptions: [], extensionUri: Uri.file(resolve("extensions/vscode")), workspaceState: { get() { return []; }, async update() {} },
    globalState: { get(key: string, fallback: unknown) { return globalState.has(key) ? globalState.get(key) : fallback; }, async update(key: string, value: unknown) { globalState.set(key, value); } } });
  return { root, api, provider, document, applied, calls };
}

async function propose(provider: any) {
  const previous = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    const decision = ++count === 1 ? { type: "tool", name: "read_project_file", arguments: { path: "answer.txt" } }
      : { type: "result", summary: "Proposed correction", changes: [{ path: "answer.txt", content: "corrected" }] };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(decision) } }));
  }) as typeof fetch;
  try { await provider.receive({ type: "ask", mode: "edit", prompt: "Correct the answer", includeContext: false }); }
  finally { globalThis.fetch = previous; }
  assert.ok(provider.proposal, "a proposal is ready");
  return provider.proposal.id as string;
}

test("extension refuses untrusted workspaces before model access", async () => {
  const f = fixture(); f.api.workspace.isTrusted = false;
  await assert.rejects(f.provider.receive({ type: "ask", mode: "edit", prompt: "Fix" }), /Trust this folder/);
  assert.equal(f.applied.length, 0);
});

test("native edit path requires diff review, protects dirty buffers and uses WorkspaceEdit", async () => {
  const f = fixture(); const id = await propose(f.provider);
  await assert.rejects(f.provider.receive({ type: "apply", id }), /Open each proposed diff/);
  await f.provider.receive({ type: "diff", id, index: 0 });
  assert.equal(f.calls.at(-1)?.[0], "vscode.diff");
  f.document.isDirty = true;
  await assert.rejects(f.provider.receive({ type: "apply", id }), /unsaved edits/);
  assert.equal(f.applied.length, 0);
  f.document.isDirty = false;
  await f.provider.receive({ type: "apply", id });
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0]!.operations.length, 1);
  assert.equal(f.provider.proposal, undefined);
  assert.match(f.provider.messages.at(-1).text, /Undo/);
});

test("a source edit after diff review invalidates the native apply path", async () => {
  const f = fixture(); const id = await propose(f.provider);
  await f.provider.receive({ type: "diff", id, index: 0 });
  writeFileSync(join(f.root, "answer.txt"), "user changed this");
  await assert.rejects(f.provider.receive({ type: "apply", id }), /changed/);
  assert.equal(f.applied.length, 0);
});

test("changing folders invalidates proposals and clears diff documents", async () => {
  const f = fixture(); const id = await propose(f.provider);
  await f.provider.receive({ type: "diff", id, index: 0 });
  f.provider.changeFolder(0);
  await assert.rejects(f.provider.receive({ type: "apply", id }), /no longer available/);
  assert.equal(f.provider.diffContent.size, 0);
  assert.equal(f.applied.length, 0);
});

test("the worker picker only accepts assistants the workbench listed as usable, and stays on the local model without a workbench", async () => {
  const { provider } = fixture();
  await provider.refreshAssistants();
  assert.equal(provider.workbench.status, "off");
  assert.equal(provider.assistantId, "");
  await assert.rejects(provider.receive({ type: "assistant", id: "11111111-1111-4111-8111-111111111111" }), /cannot work right now/);
  provider.assistants = [{ id: "11111111-1111-4111-8111-111111111111", name: "Repo bot", project: "Repo helper", release: "v1", usable: false, reason: "Retired." }];
  await assert.rejects(provider.receive({ type: "assistant", id: "11111111-1111-4111-8111-111111111111" }), /cannot work right now/);
  provider.assistants[0].usable = true;
  await provider.receive({ type: "assistant", id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(provider.assistantId, "11111111-1111-4111-8111-111111111111");
  // A chosen assistant without a workbench address cannot run: the request says what to set.
  await assert.rejects(provider.chosenAssistant(), /magentic\.workbenchUrl/);
  await provider.receive({ type: "assistant", id: "" });
  assert.equal(await provider.chosenAssistant(), undefined);
});
