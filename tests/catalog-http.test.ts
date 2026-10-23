import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAdapterHttpServer } from "../http.js";
import { loadCatalog } from "../catalog/load.js";
import { createLnkzMcpServer } from "../mcp.js";
import type { LnkzClientLike } from "../client.js";

/**
 * Hosting several agents out of one process.
 *
 * Two things are being checked and they are different. Over HTTP: that a
 * request lands on the right agent, that the catalog is readable without a
 * key, and that everything that was true of /mcp before is still true. In
 * memory: that an agent's endpoint registers its tools and no others, which
 * is the actual boundary and is cheaper to assert directly than through a
 * protocol handshake.
 */

const RELAY = "https://relay.example.com";

function hosted(allowWrites = true) {
  const catalog = loadCatalog({ directory: "agents", allowWrites });
  const server = createAdapterHttpServer({ baseUrl: RELAY, options: { allowWrites }, catalog });
  server.listen(0, "127.0.0.1");
  return new Promise<{ base: string; close: () => Promise<void> }>((settle) => {
    server.once("listening", () => settle({
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });
}

/** Throws on any call: registration describes tools, it does not use them. */
const unusedClient = new Proxy({}, {
  get: () => () => { throw new Error("A registration test must not reach the relay."); },
}) as LnkzClientLike;

async function toolsOf(options: Parameters<typeof createLnkzMcpServer>[1]) {
  const server = createLnkzMcpServer(unusedClient, options);
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return { names, instructions };
}

// ------------------------------------------------------------------ the catalog over HTTP

test("the catalog is readable without a key, because choosing an agent comes before having one", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/agents`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json() as { object: string; data: { id: string; endpoint: string; tools: string[] }[] };
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((agent) => agent.id), ["conversation-relay", "handoff-desk", "research-reader"]);
  for (const agent of body.data) {
    assert.equal(agent.endpoint, `/mcp/${agent.id}`);
    assert.ok(agent.tools.length > 0);
  }
});

test("one agent can be read on its own, and an unknown one says which exist", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const found = await fetch(`${server.base}/agents/research-reader`);
  assert.equal(found.status, 200);
  const agent = await found.json() as { id: string; scopes: string[] };
  assert.equal(agent.id, "research-reader");
  assert.deepEqual(agent.scopes, ["read"]);

  const missing = await fetch(`${server.base}/agents/no-such-agent`);
  assert.equal(missing.status, 404);
  const body = await missing.json() as { known: string[] };
  assert.ok(body.known.includes("handoff-desk"), "a 404 should tell you what you could have asked for");
});

test("health reports how many agents are hosted", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const body = await (await fetch(`${server.base}/health`)).json() as Record<string, unknown>;
  assert.deepEqual(body, { ok: true, relay: RELAY, agents: 3 });
});

test("the index page lists every endpoint and names no relay", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const page = await response.text();
  for (const name of ["conversation-relay", "handoff-desk", "research-reader"]) {
    assert.ok(page.includes(`/mcp/${name}`), `${name} is hosted and should be on the page`);
  }
  assert.equal(page.includes(RELAY), false, "the page is public and the relay is the operator's business");
});

// ------------------------------------------------------------------ the agent endpoints

test("an agent endpoint still demands the caller's own key", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/mcp/research-reader`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("an unknown agent endpoint is a 404 and not a protocol error", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/mcp/no-such-agent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer a-caller-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 404);
  const body = await response.json() as Record<string, unknown>;
  assert.equal("jsonrpc" in body, false);
  assert.equal(body["catalog"], "/agents");
});

// ------------------------------------------------------------------ what each endpoint exposes

test("an agent registers its own tools and nothing else", async () => {
  const catalog = loadCatalog({ directory: "agents", allowWrites: true });
  for (const entry of catalog.entries) {
    const { names, instructions } = await toolsOf({
      allowWrites: entry.writesAllowed,
      tools: entry.activeTools,
      instructions: entry.definition.instructions,
    });
    assert.deepEqual(names, [...entry.activeTools].sort(), `${entry.definition.name} exposed a different set than it declared`);
    assert.equal(instructions, entry.definition.instructions, "a client should read what this endpoint is for");
  }
});

test("the unrestricted endpoint still exposes everything", async () => {
  const { names } = await toolsOf({ allowWrites: true });
  const reader = loadCatalog({ directory: "agents", allowWrites: true }).byName.get("research-reader");
  assert.ok(reader);
  assert.ok(names.length > reader.activeTools.size, "/mcp is the whole surface, not an agent's slice");
  assert.ok(names.includes("delete_conversation"));
});

test("a read-only deployment strips writes from an agent that asked for them", async () => {
  const catalog = loadCatalog({ directory: "agents", allowWrites: false });
  const relay = catalog.byName.get("conversation-relay");
  assert.ok(relay);
  assert.equal(relay.writesAllowed, false);

  const { names } = await toolsOf({
    allowWrites: relay.writesAllowed,
    tools: relay.activeTools,
    instructions: relay.definition.instructions,
  });
  for (const write of ["save_conversation", "create_handoff", "append_messages", "revoke_handoff"]) {
    assert.equal(names.includes(write), false, `${write} survived a read-only deployment`);
  }
  assert.ok(names.includes("list_conversations"), "the reads it declared are still there");
});

test("an allowlist cannot add a tool the deployment does not have", async () => {
  const { names } = await toolsOf({ allowWrites: true, tools: new Set(["list_conversations", "not_a_real_tool"]) });
  assert.deepEqual(names, ["list_conversations"]);
});
