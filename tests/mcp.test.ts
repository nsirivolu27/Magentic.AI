import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLnkzMcpServer } from "../src/mcp.js";
import type { LnkzRestClient } from "../src/client.js";

const id = "7a1b2c3d-0000-4000-8000-000000000000";

function fakeClient(): LnkzRestClient {
  const conversation = {
    id, version: 1 as const, title: "REST-backed conversation", source: { provider: "local" },
    participants: [], tags: [], messages: [{ id: "m1", role: "user" as const, content: "We decided to use REST.", createdAt: "2026-09-07T10:00:00.000Z" }],
    createdAt: "2026-09-07T10:00:00.000Z", updatedAt: "2026-09-07T10:00:00.000Z",
  };
  const analysis = { decisions: [], openQuestions: [], actionItems: [], facts: [], topics: [], participants: [], messageCount: 1, approxTokens: 5, span: {} };
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/api/conversations" && method === "POST") return { conversation } as T;
      if (path === `/api/conversations/${id}`) return { conversation, analysis } as T;
      if (path.startsWith("/api/conversations?")) return { conversations: [] } as T;
      if (path === "/api/conversations/search") return { matches: [] } as T;
      if (path === "/api/connectors") return { connectors: [] } as T;
      if (path === "/api/stats") return { stats: { conversations: 1, messages: 1, activeHandoffs: 0, providers: [] } } as T;
      if (path.startsWith("/api/graph")) return { graph: { nodes: [], edges: [], stats: {}, generatedAt: "now" } } as T;
      if (path.startsWith("/api/events")) return { events: [] } as T;
      if (path.startsWith("/api/handoffs")) return { handoffs: [] } as T;
      if (path.startsWith("/api/context/")) return { conflicts: [], duplicates: [], scanned: 0, items: [], errors: [], packet: { markdown: "LNKZ context packet" } } as T;
      if (path === "/api/publish/targets") return { targets: [], errors: [] } as T;
      throw new Error(`stub has no route for ${method} ${path}`);
    },
    async requestText(): Promise<{ body: string; contentType: string }> {
      return { body: '{"messages":[]}', contentType: "application/json" };
    },
  };
}

async function connected(t: { after: (fn: () => unknown) => void }) {
  const server = createLnkzMcpServer(fakeClient(), "https://relay.example");
  const client = new Client({ name: "adapter-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("stdio adapter preserves every tool, prompt, and resource name", async (t) => {
  const client = await connected(t);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 24);
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "analyze_conversation", "append_messages", "audit_log", "build_context_graph", "build_context_packet",
    "continue_handoff", "create_handoff", "delete_conversation", "export_conversation", "find_conflicts",
    "find_duplicates", "get_conversation", "import_conversation", "list_connectors", "list_conversations",
    "list_handoffs", "list_publish_targets", "prepare_publish", "redeem_handoff", "revoke_handoff",
    "save_conversation", "search_context", "search_conversations", "workspace_stats",
  ]);
  assert.deepEqual((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(), [
    "continue_shared_conversation", "prepare_handoff", "reconcile_conflicts", "research_brief",
  ]);
  assert.deepEqual((await client.listResources()).resources.map((resource) => resource.uri).sort(), [
    "lnkz://connectors", "lnkz://conversations", "lnkz://graph", "lnkz://stats",
  ]);
});

test("adapter delegates writes and turns REST failures into tool errors", async (t) => {
  const client = await connected(t);
  const saved = await client.callTool({
    name: "save_conversation",
    arguments: { title: "REST-backed conversation", source: { provider: "local" }, messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(saved.isError, undefined);
  assert.equal((saved.structuredContent as { conversation: { id: string } }).conversation.id, id);

  const broken = createLnkzMcpServer({
    ...fakeClient(),
    async request() { throw new Error("LNKZ REST request failed with HTTP 503."); },
  }, "https://relay.example");
  const isolated = new Client({ name: "error-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([broken.connect(b), isolated.connect(a)]);
  const result = await isolated.callTool({ name: "workspace_stats", arguments: {} });
  assert.equal(result.isError, true);
  await isolated.close();
  await broken.close();
});