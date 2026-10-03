import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentSchema } from "../catalog/schema.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { authorDraft, submit, approve, retire } from "../registry/transition.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { emptyInspector, mcpView } from "../workbench/mcp-view.js";

async function fixture(t: TestContext) {
  const context = {
    store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([
      { workspaceId: "one", actor: "writer", roles: ["author"] },
      { workspaceId: "one", actor: "reviewer", roles: ["approver"] },
      { workspaceId: "one", actor: "second", roles: ["approver"] },
      { workspaceId: "two", actor: "outsider", roles: ["admin"] },
    ]),
  };
  const server = createWorkbenchServer({ context, assets: new Map(), authenticate: async (request) => {
    const actor = request.headers.authorization?.replace(/^Bearer /, "");
    return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const endpoint = new URL("/api/mcp", base);
  async function connect(actor = "writer") {
    const client = new Client({ name: "portal-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${actor}` } } });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    t.after(() => client.close());
    return client;
  }
  async function seed(name = "reader", tools = ["list_conversations"]) {
    await authorDraft(context, { workspaceId: "one", actor: "writer", definition: agentSchema.parse({ name, version: "1.0.0", title: "Reader", description: "Read references.", instructions: "Cite sources.", tools }) });
    await submit(context, { workspaceId: "one", actor: "writer", name });
    await approve(context, { workspaceId: "one", actor: "reviewer", name });
  }
  async function second(name = "reader") { await approve(context, { workspaceId: "one", actor: "second", name }); }
  return { context, connect, seed, second, base, endpoint };
}
function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  assert.equal(content[0]?.type, "text");
  return JSON.parse(content[0]!.text);
}

test("workspace MCP negotiates Streamable HTTP and exposes only three read-only tools", async (t) => {
  const { connect, context } = await fixture(t);
  const client = await connect();
  assert.equal(client.getServerVersion()?.name, "magentic-workspace");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_approved_agent", "get_workspace_policy", "list_approved_agents"]);
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
  const policy = payload(await client.callTool({ name: "get_workspace_policy", arguments: {} }));
  assert.equal(policy.workspaceId, "one");
  assert.equal(policy.workflow.requiredApprovals, 2);
  assert.equal(policy.allowSelfApproval, false);
  assert.deepEqual(await context.audit.list("one"), []);
});

test("workspace MCP requires both signatures and sees the second without a restart", async (t) => {
  const { connect, seed, second } = await fixture(t);
  await seed(); const client = await connect();
  assert.deepEqual(payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents, []);
  assert.equal((await client.callTool({ name: "get_approved_agent", arguments: { name: "reader" } })).isError, true);
  await second();
  const agents = payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents;
  assert.equal(agents.length, 1); assert.equal(agents[0].name, "reader");
  const detail = payload(await client.callTool({ name: "get_approved_agent", arguments: { name: "reader" } }));
  assert.equal(detail.definition.instructions, "Cite sources.");
  assert.equal(detail.hash, agents[0].hash);
  assert.equal(detail.endpoint, undefined);
});

test("workspace MCP rechecks hashes after edits even for an already connected client", async (t) => {
  const { connect, seed, second, context } = await fixture(t);
  await seed(); await second(); const client = await connect();
  assert.equal(payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents.length, 1);
  const record = (await context.store.get("one", "reader"))!;
  await context.store.put({ ...record, definition: { ...record.definition, instructions: "Unreviewed replacement." } });
  assert.deepEqual(payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents, []);
  const denied = await client.callTool({ name: "get_approved_agent", arguments: { name: "reader" } });
  assert.equal(denied.isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /Unreviewed replacement/);
});

test("workspace MCP drops retired agents and withholds definitions with missing required tools", async (t) => {
  const { connect, seed, second, context } = await fixture(t);
  await seed(); await second(); await seed("missing", ["not_registered"]); await second("missing");
  const client = await connect();
  assert.equal(payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents.length, 1);
  await retire(context, { workspaceId: "one", actor: "reviewer", name: "reader" });
  assert.deepEqual(payload(await client.callTool({ name: "list_approved_agents", arguments: {} })).agents, []);
});

test("workspace MCP scopes every request to membership and rejects workspace overrides", async (t) => {
  const { connect, seed, second, endpoint } = await fixture(t);
  await seed(); await second(); const outsider = await connect("outsider");
  assert.deepEqual(payload(await outsider.callTool({ name: "list_approved_agents", arguments: {} })).agents, []);
  assert.equal((await outsider.callTool({ name: "get_approved_agent", arguments: { name: "reader" } })).isError, true);
  assert.equal((await outsider.callTool({ name: "list_approved_agents", arguments: { workspaceId: "one" } })).isError, true);
  assert.equal(payload(await outsider.callTool({ name: "get_workspace_policy", arguments: {} })).workspaceId, "two");
  for (const [actor, status] of [["", 401], ["unknown", 403]] as const) {
    const response = await fetch(endpoint, { method: "POST", headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, status);
  }
});

test("workspace MCP refuses cross-origin calls, oversized bodies, and streaming GET", async (t) => {
  const { endpoint } = await fixture(t);
  const headers = { Authorization: "Bearer writer", "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const blocked = await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: "{}" });
  assert.equal(blocked.status, 403);
  const large = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(70_000) }) });
  assert.equal(large.status, 413);
  const get = await fetch(endpoint, { headers });
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
  const malformed = await fetch(endpoint, { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 400);
});

test("portal catalog explains withholding without exposing records from another workspace", async (t) => {
  const { base, seed } = await fixture(t); await seed();
  const own = await (await fetch(base + "/api/workspace", { headers: { Authorization: "Bearer writer" } })).json();
  assert.equal(own.mcp.withheld[0].name, "reader");
  assert.equal(own.mcp.withheld[0].reason, "approvals-stale");
  const other = await (await fetch(base + "/api/workspace", { headers: { Authorization: "Bearer outsider" } })).json();
  assert.deepEqual(other.mcp, { agents: [], withheld: [] });
});

test("MCP inspector escapes definition metadata, protocol responses, and connection settings", () => {
  const value = '<img src=x onerror="alert(1)">';
  const inspector = { ...emptyInspector(), output: value };
  const html = mcpView({ agents: [{ name: "reader", title: value, description: value, hash: "abc", readTools: [] }], withheld: [] }, inspector, "http://localhost/api/mcp", true, value);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});
