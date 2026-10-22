import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelSetupHtml, modelSetupNotice } from "../workbench/model-setup.js";
import { workspaceDirectory } from "../workbench/workspace-directory.js";
import { fileWorkspaceStore } from "../workbench/storage.js";

const ollama = { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b", provider: "ollama", local: true, available: false,
  detail: "The configured model service is unavailable. Start it and refresh models.", outputLimit: true };
const cloud = { id: "openai/gpt", label: "gpt", provider: "OpenAI", local: false, available: false,
  detail: "Set MAGENTIC_OPENAI_API_KEY on the server and restart to connect this provider.", outputLimit: true };

test("first run: a stopped Ollama is a setup state with the install link and the pull command", () => {
  const notice = modelSetupNotice(ollama);
  assert.equal(notice.tone, "warn");
  assert.equal(notice.title, "Ollama is not running");
  const html = modelSetupHtml(ollama);
  assert.match(html, /class="chat-setup warn"/);
  assert.match(html, /href="https:\/\/ollama\.com\/download"/);
  assert.match(html, /<code>ollama pull qwen2\.5-coder:7b<\/code>/);
  assert.match(html, /data-refresh-models/);
  assert.doesNotMatch(html, /id="refresh-models"/);
});

test("first run: a cloud provider without a key names the setting and escapes the detail", () => {
  const html = modelSetupHtml({ ...cloud, detail: "<b>x</b> needs a key" });
  assert.match(html, /Connect OpenAI/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; needs a key/);
  assert.doesNotMatch(html, /ollama pull/);
});

test("first run: data saved by a newer application is refused with a clear reason, not rewritten", async t => {
  const dir = await mkdtemp(join(tmpdir(), "magentic-directory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "workspaces.json");
  const newer = JSON.stringify({ version: 2, lastWorkspaceId: "workspace", mcpWorkspaceId: "workspace", workspaces: [] });
  await writeFile(path, newer);
  assert.throws(() => workspaceDirectory(dir, fileWorkspaceStore(dir), "workspace"), /newer Magentic.*version 2.*reads version 1/);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(path, "utf8"), newer);
});
