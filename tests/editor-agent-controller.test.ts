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
  module.exports.activate({ subscriptions: [], extensionUri: Uri.file(resolve("extensions/vscode")), workspaceState: { get() { return []; }, async update() {} },
    globalState: { get(_key: string, fallback: unknown) { return fallback; }, async update() {} } });
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

test("a pending proposal cannot be replaced by another agent request", async () => {
  const f = fixture(); const id = await propose(f.provider);
  await assert.rejects(f.provider.receive({ type: "ask", agent: "review", mode: "ask", prompt: "Review" }), /Apply or discard/);
  assert.equal(f.provider.proposal.id, id);
});

test("agent and mode mismatch is refused before any model call", async () => {
  const f = fixture();
  await assert.rejects(f.provider.receive({ type: "ask", agent: "review", mode: "edit", prompt: "Edit" }), /does not allow/);
  assert.equal(f.provider.controller, undefined);
  assert.equal(f.provider.messages.length, 0);
});

test("phase labels persist and follow subsequent requests across agents", async () => {
  const f = fixture(); const previous = globalThis.fetch; const prompts: string[] = [];
  globalThis.fetch = (async (_url, options) => {
    prompts.push(JSON.parse(String(options?.body)).messages[0].content);
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ type: "result", summary: "Plan with unverified checks", changes: [] }) } }));
  }) as typeof fetch;
  try {
    await f.provider.receive({ type: "ask", agent: "plan", mode: "ask", prompt: "Plan the change" });
    await f.provider.receive({ type: "ask", agent: "review", mode: "ask", prompt: "Review the saved change" });
  } finally { globalThis.fetch = previous; }
  assert.equal(f.provider.messages[1].agent, "plan");
  assert.equal(f.provider.messages[3].agent, "review");
  assert.match(prompts[1]!, /"agent":"plan"/);
  const saved = structuredClone(f.provider.messages);
  f.provider.context.workspaceState.get = () => saved;
  f.provider.restore();
  assert.equal(f.provider.messages[1].agent, "plan");
});

test("code preview uses saved text and withholds protected and untrusted files", () => {
  const f = fixture(); let state: any;
  (f.api.window as any).activeTextEditor = { document: { uri: f.document.uri, getText() { return "unsaved selection"; } }, selection: {} };
  f.provider.view = { webview: { postMessage(value: unknown) { state = value; } } };
  f.provider.send();
  assert.equal(state.activeCode, "original");
  assert.equal(state.activeFile, "answer.txt");
  f.api.workspace.isTrusted = false; f.provider.send();
  assert.equal(state.activeCode, ""); assert.equal(state.activeFile, "");
  f.api.workspace.isTrusted = true;
  (f.api.window as any).activeTextEditor.document.uri = Uri.file(join(f.root, ".env"));
  writeFileSync(join(f.root, ".env"), "secret");
  f.provider.send();
  assert.equal(state.activeCode, ""); assert.equal(state.activeFile, "");
});
