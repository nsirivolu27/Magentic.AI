import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startLocalWorkbench, type LocalWorkbench } from "../workbench/local.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { loadMcpToken } from "../workbench/local-session.js";

const assets = mkdtempSync(join(tmpdir(), "magentic-workspace-assets-"));
const source = fileURLToPath(new URL("../../workbench/", import.meta.url));
for (const name of ["index.html", "styles.css", "pipeline.css", "chat.css", "theme.css", "mcp.css", "email.css", "manifest.webmanifest", "icon.svg"]) copyFileSync(join(source, name), join(assets, name));
writeFileSync(join(assets, "app.js"), "/* HTTP tests; the desktop smoke checks the real bundle. */");
process.env.MAGENTIC_WORKBENCH_ASSETS = assets;
test.after(() => rmSync(assets, { recursive: true, force: true }));

async function claim(app: LocalWorkbench, oldCookie?: string) {
  const page = await fetch(app.url, { headers: oldCookie ? { Cookie: oldCookie } : {} });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-mode="local"/);
  const cookie = page.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}
async function request(app: LocalWorkbench, cookie: string, path: string, data?: unknown, workspaceId?: string) {
  return fetch(new URL(path, app.url), {
    method: data === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: new URL(app.url).origin, "Content-Type": "application/json",
      ...(workspaceId ? { "X-Magentic-Workspace": workspaceId } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

test("create, select, isolate and reopen local workspaces without redirecting older tabs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-workspaces-"));
  let app = await startLocalWorkbench({ dataDir });
  try {
    const cookie = await claim(app);
    const input = { name: "Engine project", requestId: randomUUID() };
    const response = await request(app, cookie, "api/workspaces", input);
    assert.equal(response.status, 201);
    const created = await response.json() as { workspaceId: string };
    const duplicate = await request(app, cookie, "api/workspaces", input);
    assert.deepEqual(await duplicate.json(), created);
    assert.equal((await request(app, cookie, "api/workspaces", { ...input, name: "Other name" })).status, 409);
    assert.equal((await request(app, cookie, "api/workspaces", { ...input, unknown: true })).status, 400);
    const started = await request(app, cookie, "api/pipeline", {
      action: "start", requestId: randomUUID(), title: "Durable run", brief: "Keep this in the selected project.",
    }, created.workspaceId);
    assert.equal(started.status, 200);
    const run = await started.json() as { runs: { id: string }[] };
    assert.equal((await request(app, cookie, "api/workspaces/open", created)).status, 200);
    const original = await (await request(app, cookie, "api/workspace", undefined, "workspace")).json();
    assert.equal(original.pipelines.runs.length, 0);
    assert.equal(original.workspaceId, "workspace");
    assert.equal((await request(app, cookie, "api/workspace", undefined, "../escape")).status, 401);
    await app.close();
    app = await startLocalWorkbench({ dataDir });
    const nextCookie = await claim(app, cookie);
    assert.notEqual(nextCookie, cookie);
    assert.equal((await request(app, cookie, "api/workspace")).status, 401);
    const restored = await (await request(app, nextCookie, "api/workspace")).json();
    assert.equal(restored.workspaceId, created.workspaceId);
    assert.equal(restored.pipelines.runs[0].id, run.runs[0]!.id);
    assert.equal(restored.pipelines.storage, "file");
    assert.deepEqual(restored.roles, ["author", "admin"]);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("standalone credentials work without Origin only on MCP and stay bound to their workspace", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-scoped-mcp-"));
  let app = await startLocalWorkbench({ dataDir });
  try {
    const cookie = await claim(app);
    const created = await (await request(app, cookie, "api/workspaces", { name: "Second project", requestId: randomUUID() })).json() as { workspaceId: string };
    const access = await (await request(app, cookie, "api/workspaces/mcp-access", {}, created.workspaceId)).json() as { tokenFile: string };
    const token = readFileSync(access.tokenFile, "utf8").trim();
    const initialToken = readFileSync(join(dataDir, "mcp-token"), "utf8").trim();
    assert.notEqual(token, initialToken);
    async function mcp(bearer: string, extra: Record<string, string> = {}) {
      return fetch(new URL("api/pipeline-mcp", app.url), { method: "POST", headers: {
        Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra,
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "scope-test", version: "1" },
      } }) });
    }
    assert.equal((await mcp(token)).status, 200);
    assert.equal((await mcp(token, { "X-Magentic-Workspace": "workspace" })).status, 401);
    assert.equal((await mcp(initialToken, { "X-Magentic-Workspace": created.workspaceId })).status, 401);
    assert.equal((await mcp(token, { Origin: "https://evil.example" })).status, 403);
    for (const path of ["api/workspace", "api/workspaces", "api/chat/models"]) {
      assert.equal((await fetch(new URL(path, app.url), { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    }
    assert.equal((await mcp(token, { Cookie: cookie })).status, 401);
    await app.close();
    app = await startLocalWorkbench({ dataDir });
    assert.equal((await mcp(token)).status, 200);
    assert.equal((await mcp(initialToken, { "X-Magentic-Workspace": "workspace" })).status, 200);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("foreign navigation cannot consume the startup session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-bootstrap-"));
  const app = await startLocalWorkbench({ dataDir });
  try {
    const foreign = await fetch(app.url, { headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("set-cookie"), null);
    assert.equal(app.session.claimed(), false);
    await claim(app);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("saving refuses malformed existing workspace JSON and leaves it untouched", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-corrupt-"));
  const store = fileWorkspaceStore(dataDir);
  try {
    const path = store.pathFor("workspace");
    writeFileSync(path, "{broken");
    assert.throws(() => store.commit("workspace", { config: DEFAULT_PIPELINE, version: 1, runs: [] }), /unreadable/);
    assert.equal(readFileSync(path, "utf8"), "{broken");
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a corrupt MCP token is not silently replaced", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-token-"));
  try {
    const path = join(dataDir, "mcp-token");
    writeFileSync(path, "damaged");
    assert.throws(() => loadMcpToken(path), /Invalid MCP credential/);
    assert.equal(readFileSync(path, "utf8"), "damaged");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
