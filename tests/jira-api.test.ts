import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { startLocalWorkbench, type LocalWorkbench } from "../workbench/local.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { createJiraRuntime } from "../workbench/jira-runtime.js";
import { filePipelines, type PipelineRun } from "../workbench/pipeline.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import type { JiraDelivery, PendingJiraAction } from "../workbench/jira.js";

const assets = mkdtempSync(join(tmpdir(), "magentic-jira-api-assets-"));
const source = fileURLToPath(new URL("../../workbench/", import.meta.url));
for (const name of ["index.html", "styles.css", "agency.css", "pipeline.css", "chat.css", "theme.css", "mcp.css", "email.css", "manifest.webmanifest", "icon.svg"]) {
  copyFileSync(join(source, name), join(assets, name));
}
writeFileSync(join(assets, "app.js"), "/* Backend integration fixture. */");
process.env.MAGENTIC_WORKBENCH_ASSETS = assets;
test.after(() => rmSync(assets, { recursive: true, force: true }));

async function claim(app: LocalWorkbench) {
  const response = await fetch(app.url);
  await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie); return cookie;
}
function request(app: LocalWorkbench, cookie: string, path: string, input?: unknown, workspace?: string) {
  return fetch(new URL(path, app.url), { method: input === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: new URL(app.url).origin, "Content-Type": "application/json",
      ...(workspace ? { "X-Magentic-Workspace": workspace } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function start(app: LocalWorkbench, cookie: string) {
  const response = await request(app, cookie, "api/pipeline", {
    action: "start", requestId: randomUUID(), title: "Jira integration evidence", brief: "Review and trace this action.",
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { runs: PipelineRun[] };
  const run = result.runs[0]!;
  return { run, reference: { runId: run.id, eventId: run.jira[0]!.eventId } };
}
type Inspection = { mode: string; total: number; actions: PendingJiraAction[] };

test("local Jira API requires a reviewed hash, rejects forged inputs, and defaults to durable previews", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-jira-api-"));
  let app = await startLocalWorkbench({ dataDir });
  try {
    let cookie = await claim(app);
    const { run, reference } = await start(app, cookie);
    const path = `api/jira?runId=${run.id}`;
    assert.equal((await fetch(new URL(path, app.url))).status, 401);
    const previewResponse = await request(app, cookie, "api/jira", { action: "preview", ...reference });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.mode, "preview");
    assert.equal((await (await request(app, cookie, path)).json()).total, 0);
    const command = { action: "deliver", ...reference, expectedIntentHash: preview.expectedIntentHash };
    assert.equal((await request(app, cookie, "api/jira", { ...command, expectedIntentHash: "0".repeat(64) })).status, 409);
    for (const extra of [{ authorizedBy: "admin" }, { roles: ["admin"] }, { siteOrigin: "https://other.invalid" }, { workspaceId: "other" }]) {
      assert.equal((await request(app, cookie, "api/jira", { ...command, ...extra })).status, 400);
    }
    assert.equal((await request(app, cookie, `${path}&limit=51`)).status, 400);
    assert.equal((await request(app, cookie, `${path}&unknown=true`)).status, 400);
    const foreign = await fetch(new URL("api/jira", app.url), { method: "POST", headers: {
      Cookie: cookie, Origin: "https://foreign.invalid", "Content-Type": "application/json",
    }, body: JSON.stringify(command) });
    assert.equal(foreign.status, 403);
    const created = await (await request(app, cookie, "api/workspaces", { name: "Another workspace", requestId: randomUUID() })).json();
    assert.equal((await request(app, cookie, path, undefined, created.workspaceId)).status, 404);
    assert.equal((await request(app, cookie, "api/jira", command, created.workspaceId)).status, 409);
    const delivered = await (await request(app, cookie, "api/jira", command)).json();
    assert.equal(delivered.dispatched, false); assert.equal(delivered.action.status, "pending");
    assert.equal((await (await request(app, cookie, "api/jira", command)).json()).action.id, delivered.action.id);
    await request(app, cookie, "api/pipeline", { action: "pause", runId: run.id, expectedRevision: 1 });
    await app.close(); app = await startLocalWorkbench({ dataDir }); cookie = await claim(app);
    const restored = await (await request(app, cookie, path, undefined, run.workspaceId)).json() as Inspection;
    assert.equal(restored.total, 1); assert.equal(restored.actions[0]!.id, delivered.action.id);
    assert.equal(restored.actions[0]!.evidence, undefined);
    await app.close();
    const store = fileWorkspaceStore(dataDir);
    try {
      const state = store.read(run.workspaceId)!;
      store.commit(run.workspaceId, { ...state, jiraActions: [{ ...restored.actions[0]!, status: "claimed",
        claim: { attemptId: randomUUID(), at: new Date().toISOString() } }] });
    } finally { store.close(); }
    app = await startLocalWorkbench({ dataDir }); cookie = await claim(app);
    const recovered = await (await request(app, cookie, path, undefined, run.workspaceId)).json() as Inspection;
    assert.equal(recovered.actions[0]!.status, "uncertain");
    assert.equal(recovered.actions[0]!.claim, undefined);
    const repeated = await (await request(app, cookie, "api/jira", command, run.workspaceId)).json();
    assert.equal(repeated.dispatched, false); assert.equal(repeated.action.status, "uncertain");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("an explicit fixture adapter records evidence that standalone MCP can inspect but cannot deliver", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-jira-mcp-")); let calls = 0;
  const delivery: JiraDelivery = { mode: "live", siteOrigin: "https://fixture.invalid", async send(action) {
    calls++; return { ...action, status: "sent", attempts: action.attempts + 1,
      evidence: { issueKey: "ENG-9", url: "https://fixture.invalid/browse/ENG-9", at: new Date().toISOString() } };
  } };
  const app = await startLocalWorkbench({ dataDir, jiraDelivery: delivery });
  const client = new Client({ name: "jira-inspection-test", version: "1" });
  const outsider = new Client({ name: "jira-other-workspace", version: "1" });
  try {
    const cookie = await claim(app); const { run, reference } = await start(app, cookie);
    const preview = await (await request(app, cookie, "api/jira", { action: "preview", ...reference })).json();
    const command = { action: "deliver", ...reference, expectedIntentHash: preview.expectedIntentHash };
    const first = await request(app, cookie, "api/jira", command); assert.equal(first.status, 200);
    assert.equal((await first.json()).action.evidence.issueKey, "ENG-9");
    await request(app, cookie, "api/jira", command); assert.equal(calls, 1);
    const token = readFileSync(join(dataDir, "mcp-token"), "utf8").trim();
    const mcpUrl = new URL("api/pipeline-mcp", app.url);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    } }) as unknown as Parameters<typeof client.connect>[0]);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.filter(tool => tool.name.includes("jira")).map(tool => tool.name), ["get_jira_actions"]);
    assert.equal(tools.find(tool => tool.name === "get_jira_actions")?.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: "get_jira_actions", arguments: { runId: run.id } });
    assert.notEqual(result.isError, true);
    const read = JSON.parse((result.content as { text: string }[])[0]!.text) as Inspection;
    assert.equal(read.actions[0]!.evidence!.issueKey, "ENG-9");
    for (const input of [{ runId: randomUUID() }, { runId: run.id, workspaceId: "other" }, { runId: run.id, limit: 51 }]) {
      assert.equal((await client.callTool({ name: "get_jira_actions", arguments: input })).isError, true);
    }
    assert.equal((await client.callTool({ name: "deliver_jira_action", arguments: command })).isError, true);
    const denied = await fetch(new URL("api/jira", app.url), { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: new URL(app.url).origin,
    }, body: JSON.stringify(command) });
    assert.equal(denied.status, 401);
    const created = await (await request(app, cookie, "api/workspaces", { name: "Separate project", requestId: randomUUID() })).json();
    const access = await (await request(app, cookie, "api/workspaces/mcp-access", {}, created.workspaceId)).json();
    const otherToken = readFileSync(access.tokenFile, "utf8").trim();
    await outsider.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: {
      headers: { Authorization: `Bearer ${otherToken}` },
    } }) as unknown as Parameters<typeof outsider.connect>[0]);
    assert.equal((await outsider.callTool({ name: "get_jira_actions", arguments: { runId: run.id } })).isError, true);
    assert.equal(calls, 1);
  } finally {
    await client.close(); await outsider.close(); await app.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the API requires both trusted session capability and directory admin membership", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "magentic-jira-authority-"));
  const store = fileWorkspaceStore(dataDir); const pipelines = filePipelines(store);
  const jira = createJiraRuntime(pipelines, store);
  const run = pipelines.execute("one", "owner", ["admin"], {
    action: "start", requestId: randomUUID(), title: "Check server authority", brief: "Client roles are untrusted.",
  }, 1).runs[0]!;
  const server = createWorkbenchServer({ assets: new Map(), pipelines, jira,
    context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([
      { workspaceId: "one", actor: "owner", roles: ["admin"] },
      { workspaceId: "one", actor: "writer", roles: ["author"] },
    ]) },
    async authenticate(req) {
      if (req.headers.authorization === "Bearer admin-fixture") return { workspaceId: "one", actor: "owner" };
      if (req.headers.authorization === "Bearer author-fixture") return { workspaceId: "one", actor: "writer", canDeliverJira: true };
      return undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    for (const token of ["admin-fixture", "author-fixture"]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/jira`, { method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      }, body: JSON.stringify({ action: "preview", runId: run.id, eventId: run.jira[0]!.eventId }) });
      assert.equal(response.status, 403);
    }
    assert.equal(jira.inspect("one", { runId: run.id }).total, 0);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await jira.close(); store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});
