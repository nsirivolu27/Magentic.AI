import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LnkzClientLike } from "../client.js";
import type { Conversation, ConversationAnalysis, ConversationGraph } from "../contract.js";
import { createLnkzMcpServer, optionsFromEnv } from "../mcp.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const handoffId = "22222222-2222-4222-8222-222222222222";
const token = "abcdefghijklmnopqrstuvwx";
const now = "2026-01-01T00:00:00.000Z";

const conversation: Conversation = {
  id: conversationId,
  version: 1,
  title: "Portable context",
  summary: "A summary.",
  source: { provider: "chatgpt", url: "https://example.test/chat" },
  participants: ["Nihal"],
  tags: ["test"],
  messages: [{ id: "message-1", role: "user", content: "Hello", createdAt: now }],
  createdAt: now,
  updatedAt: now,
};

const analysis: ConversationAnalysis = {
  decisions: [],
  openQuestions: [],
  actionItems: [],
  facts: [],
  topics: ["context"],
  participants: ["Nihal"],
  messageCount: 1,
  approxTokens: 2,
  span: { start: now, end: now },
};

const graph: ConversationGraph = {
  nodes: [{ id: `conversation:${conversationId}`, kind: "conversation", label: conversation.title, weight: 1 }],
  edges: [],
  stats: { conversations: 1, decisions: 0, questions: 0, topics: 0, edges: 0, hubs: [], isolated: [] },
  generatedAt: now,
};

function stubClient(calls: string[]): LnkzClientLike {
  const hit = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    workspace: async () => hit("workspace", { workspace: { id: conversationId, name: "Personal", mode: "personal", useCase: "Research", datasets: { enabled: false, approvalTag: "training-approved" } }, access: { actorId: "test", scopes: ["read"] } }),
    exportDataset: async () => hit("exportDataset", { manifest: {}, trainJsonl: "", validationJsonl: "" }),
    saveConversation: async () => hit("saveConversation", { conversation }),
    importConversations: async () => hit("importConversations", {
      format: "text",
      warnings: [],
      preview: [{ title: conversation.title, provider: "chatgpt", messages: 1 }],
      conversations: [conversation],
    }),
    getConversation: async () => hit("getConversation", { conversation, analysis }),
    listConversations: async () => hit("listConversations", {
      conversations: [{ ...conversation, messageCount: 1 }],
    }),
    searchConversations: async () => hit("searchConversations", {
      matches: [{ ...conversation, messageCount: 1, relevance: 1, snippet: "Hello" }],
    }),
    appendMessages: async () => hit("appendMessages", { conversation }),
    deleteConversation: async () => { await hit("deleteConversation", undefined); },
    createHandoff: async () => hit("createHandoff", {
      id: handoffId,
      token,
      shareUrl: `https://lnkz.example/share/${token}`,
      expiresAt: now,
      maxUses: 25,
      redact: false,
    }),
    redeemHandoff: async () => hit("redeemHandoff", {
      format: "lnkz.conversation.v1",
      conversation,
      transcriptMarkdown: "# Portable context",
      analysis,
      redaction: { applied: false, removed: [] },
      handoff: { id: handoffId, usesRemaining: 24, expiresAt: now },
      exportedAt: now,
    }),
    continueHandoff: async () => hit("continueHandoff", { conversation, parentId: conversationId }),
    importFromUrl: async () => hit("importFromUrl", {
      conversation,
      origin: { instance: "https://theirs.example", url: `https://theirs.example/share/${token}`, conversationId: "theirs-1" },
      warnings: [],
    }),
    previewLink: async () => hit("previewLink", {
      origin: { instance: "https://theirs.example", url: `https://theirs.example/share/${token}` },
      warnings: [],
      preview: { title: conversation.title, provider: "chatgpt", messages: 1, usesRemaining: 1, expiresAt: now, redact: true },
    }),
    continueFromLink: async () => hit("continueFromLink", {
      conversation,
      origin: { instance: "https://theirs.example", url: `https://theirs.example/share/${token}`, conversationId: "theirs-1" },
      warnings: [],
    }),
    revokeHandoff: async () => { await hit("revokeHandoff", undefined); },
    listHandoffs: async () => hit("listHandoffs", { handoffs: [] }),
    buildContextPacket: async () => hit("buildContextPacket", {
      packet: {
        query: "context",
        generatedAt: now,
        budgetTokens: 4000,
        usedTokens: 10,
        conversations: [],
        external: [],
        conflicts: [],
        markdown: "# Context packet",
      },
    }),
    findConflicts: async () => hit("findConflicts", { conflicts: [], scanned: 1 }),
    findDuplicates: async () => hit("findDuplicates", { duplicates: [], scanned: 1 }),
    searchContext: async () => hit("searchContext", { items: [], errors: [], searchedSources: ["lnkz"] }),
    listConnectors: async () => hit("listConnectors", {
      connectors: [{ id: "lnkz", label: "LNKZ", configured: true, detail: "Ready" }],
    }),
    stats: async () => hit("stats", {
      stats: { conversations: 1, messages: 1, providers: [{ provider: "chatgpt", count: 1 }], activeHandoffs: 0, events: 1 },
    }),
    audit: async () => hit("audit", { events: [] }),
    exportConversation: async (_id, format) => hit("exportConversation", {
      format,
      mimeType: "text/markdown",
      filename: "portable-context.markdown.md",
      reimportable: true,
      body: "# Portable context",
    }),
    graph: async () => hit("graph", { graph }),
    publishTargets: async () => hit("publishTargets", { targets: [], errors: [] }),
    preparePublish: async () => hit("preparePublish", {
      prepared: {
        target: "jira",
        tool: "create_issue",
        arguments: { title: conversation.title },
        missing: [],
        filled: [{ name: "title", from: "conversation title" }],
        notes: ["Nothing was sent."],
        sent: false,
      },
    }),
  };
}

const toolCases: { name: string; input: Record<string, unknown>; call: string }[] = [
  ["save_conversation", { title: "Portable context", source: { provider: "chatgpt" }, messages: [{ role: "user", content: "Hello" }] }, "saveConversation"],
  ["import_conversation", { payload: "User: Hello", format: "text" }, "importConversations"],
  ["get_conversation", { id: conversationId }, "getConversation"],
  ["list_conversations", {}, "listConversations"],
  ["search_conversations", { query: "context" }, "searchConversations"],
  ["append_messages", { conversationId, messages: [{ role: "assistant", content: "Hi" }] }, "appendMessages"],
  ["export_conversation", { conversationId, format: "markdown" }, "exportConversation"],
  ["build_context_graph", {}, "graph"],
  ["list_publish_targets", {}, "publishTargets"],
  ["prepare_publish", { conversationId, target: "jira", tool: "create_issue" }, "preparePublish"],
  ["delete_conversation", { id: conversationId }, "deleteConversation"],
  ["create_handoff", { conversationId }, "createHandoff"],
  ["redeem_handoff", { token }, "redeemHandoff"],
  ["continue_handoff", { token, provider: "claude", messages: [{ role: "assistant", content: "Continued" }] }, "continueHandoff"],
  ["revoke_handoff", { handoffId }, "revokeHandoff"],
  ["list_handoffs", {}, "listHandoffs"],
  ["import_from_url", { url: "https://theirs.example/share/abcdefghijklmnopqrstuvwx" }, "importFromUrl"],
  ["preview_handoff", { url: "https://theirs.example/share/abcdefghijklmnopqrstuvwx" }, "previewLink"],
  ["continue_from_link", {
    url: "https://theirs.example/share/abcdefghijklmnopqrstuvwx",
    provider: "claude",
    messages: [{ role: "assistant", content: "Carrying it forward." }],
  }, "continueFromLink"],
  ["build_context_packet", { query: "context" }, "buildContextPacket"],
  ["analyze_conversation", { conversationId }, "getConversation"],
  ["find_conflicts", {}, "findConflicts"],
  ["find_duplicates", {}, "findDuplicates"],
  ["search_context", { query: "context" }, "searchContext"],
  ["list_connectors", {}, "listConnectors"],
  ["workspace_stats", {}, "stats"],
  ["audit_log", {}, "audit"],
].map(([name, input, call]) => ({ name, input, call })) as { name: string; input: Record<string, unknown>; call: string }[];

for (const item of toolCases) {
  test(`tool ${item.name} delegates to LNKZ REST`, async (t) => {
    const calls: string[] = [];
    const server = createLnkzMcpServer(stubClient(calls));
    const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: item.name, arguments: item.input });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [item.call]);
  });
}

test("publishes the preserved tool, resource, template, and prompt names", async (t) => {
  const server = createLnkzMcpServer(stubClient([]));
  const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), toolCases.map((item) => item.name).sort());
  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    "lnkz://connectors", "lnkz://conversations", "lnkz://graph", "lnkz://stats",
  ]);
  const templates = await client.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates.map((resource) => resource.uriTemplate), ["lnkz://conversation/{id}"]);
  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [
    "continue_shared_conversation", "prepare_handoff", "reconcile_conflicts", "research_brief",
  ]);
});

test("resources are served through the REST client", async (t) => {
  const calls: string[] = [];
  const server = createLnkzMcpServer(stubClient(calls));
  const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.readResource({ uri: "lnkz://connectors" });
  await client.readResource({ uri: "lnkz://stats" });
  await client.readResource({ uri: "lnkz://conversations" });
  await client.readResource({ uri: "lnkz://graph" });
  await client.readResource({ uri: `lnkz://conversation/${conversationId}` });
  assert.deepEqual(calls, ["listConnectors", "stats", "listConversations", "graph", "getConversation"]);
});

test("a dry run import previews the link instead of redeeming it", async (t) => {
  // import_from_url with dryRun must not reach importFromUrl. Fetching the
  // packet to describe it is a redemption as far as the sending relay is
  // concerned, which on a one-use link makes looking and taking mutually
  // exclusive. The same mistake has been fixed in four places now; this test
  // is what stops it reappearing in a fifth.
  const calls: string[] = [];
  const server = createLnkzMcpServer(stubClient(calls));
  const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({
    name: "import_from_url",
    arguments: { url: "https://theirs.example/share/abcdefghijklmnopqrstuvwx", dryRun: true },
  });

  assert.deepEqual(calls, ["previewLink"], "a dry run redeemed the link instead of previewing it");
});

test("preview never returns the transcript", async (t) => {
  // The preview route is unauthenticated on the relay, exactly like redemption,
  // so a peek must not become a way to read someone's conversation for free.
  const server = createLnkzMcpServer(stubClient([]));
  const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "preview_handoff",
    arguments: { url: "https://theirs.example/share/abcdefghijklmnopqrstuvwx" },
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("messages\":["), false, "the preview carried the transcript");
  assert.ok(serialized.includes("Nothing was written"), "the preview did not say what it cost");
});

test("a read-only adapter does not expose the tools that change things", async (t) => {
  // Not "registers them and refuses": a model cannot build a plan around a
  // tool it never sees, so a reader-only deployment stops being offered
  // deletions it was never going to be allowed to perform.
  const server = createLnkzMcpServer(stubClient([]), { allowWrites: false });
  const client = new Client({ name: "lnkz-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));

  for (const hidden of [
    "save_conversation", "import_conversation", "import_from_url", "append_messages",
    "delete_conversation", "create_handoff", "redeem_handoff", "continue_handoff",
    "continue_from_link", "revoke_handoff",
  ]) {
    assert.equal(names.has(hidden), false, `${hidden} was exposed on a read-only adapter`);
  }

  // Reading still works, and previewing counts as reading: it spends nothing.
  for (const kept of ["search_conversations", "get_conversation", "build_context_packet", "preview_handoff"]) {
    assert.equal(names.has(kept), true, `${kept} was hidden on a read-only adapter`);
  }
});

test("exposure defaults to everything, and only an explicit read restricts it", () => {
  // Defaulting to read-only would silently remove tools from every existing
  // deployment on upgrade. The relay is the enforcer either way, so the safe
  // default here is the non-breaking one.
  assert.equal(optionsFromEnv({}).allowWrites, true);
  assert.equal(optionsFromEnv({ LNKZ_MCP_SCOPES: "" }).allowWrites, true);
  assert.equal(optionsFromEnv({ LNKZ_MCP_SCOPES: "read" }).allowWrites, false);
  assert.equal(optionsFromEnv({ LNKZ_MCP_SCOPES: "read,write" }).allowWrites, true);
  assert.equal(optionsFromEnv({ LNKZ_MCP_SCOPES: "READ, WRITE" }).allowWrites, true);
  assert.equal(optionsFromEnv({ LNKZ_MCP_SCOPES: "nonsense" }).allowWrites, false);
});
