import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  analyzeSchema,
  appendMessagesSchema,
  auditSchema,
  conflictSchema,
  contextPacketSchema,
  contextSearchSchema,
  conversationInputSchema,
  createHandoffSchema,
  duplicateSchema,
  graphSchema,
  importSchema,
  listConversationsSchema,
  preparePublishSchema,
  redeemHandoffSchema,
  revokeHandoffSchema,
  searchConversationsSchema,
  continueConversationSchema,
  publishShapeSchema,
} from "./schemas.js";
import type { LnkzRestClient } from "./client.js";
import type {
  Conversation,
  ConversationAnalysis,
  ConversationInput,
  Graph,
  HandoffPacket,
  PreparedCall,
} from "./types.js";

export const LNKZ_VERSION = "0.2.0";
export const EXPECTED_TOOL_NAMES = [
  "analyze_conversation", "append_messages", "audit_log", "build_context_graph",
  "build_context_packet", "continue_handoff", "create_handoff", "delete_conversation",
  "export_conversation", "find_conflicts", "find_duplicates", "get_conversation",
  "import_conversation", "list_connectors", "list_conversations", "list_handoffs",
  "list_publish_targets", "prepare_publish", "redeem_handoff", "revoke_handoff",
  "save_conversation", "search_context", "search_conversations", "workspace_stats",
] as const;

export function createLnkzMcpServer(client: LnkzRestClient, publicBaseUrl?: string): McpServer {
  const server = new McpServer(
    { name: "lnkz", version: LNKZ_VERSION },
    {
      instructions: [
        "LNKZ carries conversation context between people, devices, and LLM clients.",
        "Save or import a chat, build a context packet when another model needs the gist,",
        "and create a handoff when a human or a different client needs the whole thread.",
        "Treat handoff tokens as bearer secrets and never echo them into shared output.",
      ].join(" "),
    },
  );
  const shareUrl = (token: string) => `${(publicBaseUrl ?? process.env.LNKZ_BASE_URL ?? "").replace(/\/$/, "")}/share/${token}`;

  server.registerTool("save_conversation", {
    title: "Save portable conversation",
    description: "Stores a normalized conversation through the LLMM/LNKZ REST relay.",
    inputSchema: conversationInputSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const response = await client.request<{ conversation: Conversation }>("POST", "/api/conversations", conversationInputSchema.parse(input));
    return ok(`Saved "${response.conversation.title}" with ${response.conversation.messages.length} messages as ${response.conversation.id}.`, response);
  }));

  server.registerTool("import_conversation", {
    title: "Import a chat from another client",
    description: "Normalizes a ChatGPT, Claude, Gemini, LNKZ, Markdown, or plain-text transcript through the relay.",
    inputSchema: importSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const response = await client.request<Record<string, unknown>>("POST", "/api/conversations/import", importSchema.parse(input));
    if (response.preview) {
      return ok(`Detected ${String(response.format)}. Nothing was written.`, response);
    }
    const conversations = (response.conversations as Conversation[] | undefined) ?? [];
    return ok([
      `Imported ${conversations.length} conversation(s) as ${String(response.format)}.`,
      ...conversations.map((conversation) => `${conversation.id} — ${conversation.title} (${conversation.messages.length} messages)`),
      ...((response.warnings as string[] | undefined) ?? []).map((warning) => `Warning: ${warning}`),
    ].join("\n"), response);
  }));

  server.registerTool("get_conversation", {
    title: "Get conversation",
    description: "Loads a stored conversation with messages, lineage, extracted decisions, and a Markdown transcript.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const response = await client.request<{ conversation: Conversation; analysis: ConversationAnalysis }>(
      "GET", `/api/conversations/${encodeURIComponent(input.id)}`,
    );
    return ok(conversationToMarkdownWithAnalysis(response.conversation, response.analysis), response);
  }));

  server.registerTool("list_conversations", {
    title: "List conversations",
    description: "Lists stored conversations newest first, optionally filtered by provider, tag, or participant.",
    inputSchema: listConversationsSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const options = listConversationsSchema.parse(input);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
    const response = await client.request<{ conversations: unknown[] }>("GET", `/api/conversations?${params}`);
    const text = response.conversations.length
      ? response.conversations.map((item) => {
        const conversation = item as { id: string; title: string; source: { provider: string }; messageCount: number; updatedAt: string };
        return `${conversation.id} — ${conversation.title} [${conversation.source.provider}] ${conversation.messageCount} messages, updated ${conversation.updatedAt}`;
      }).join("\n")
      : "No conversations stored yet.";
    return ok(text, response);
  }));

  server.registerTool("search_conversations", {
    title: "Search LNKZ conversations",
    description: "Full-text ranked search across saved chats.",
    inputSchema: searchConversationsSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const response = await client.request<{ matches: { id: string; title: string; relevance: number; snippet: string }[] }>(
      "POST", "/api/conversations/search", searchConversationsSchema.parse(input),
    );
    const text = response.matches.length
      ? response.matches.map((match) => `${match.id} — ${match.title} (relevance ${match.relevance})\n    ${match.snippet}`).join("\n")
      : "No saved conversations matched.";
    return ok(text, response);
  }));

  server.registerTool("append_messages", {
    title: "Append messages to a conversation",
    description: "Adds new turns to an existing conversation.",
    inputSchema: appendMessagesSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const options = appendMessagesSchema.parse(input);
    const response = await client.request<{ conversation: Conversation }>(
      "POST", `/api/conversations/${encodeURIComponent(options.conversationId)}/messages`, { messages: options.messages },
    );
    return ok(`Appended ${options.messages.length} message(s); ${response.conversation.messages.length} total.`, response);
  }));

  server.registerTool("delete_conversation", {
    title: "Delete conversation",
    description: "Permanently removes a conversation, its messages, and its handoffs.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, (input) => safe(async () => {
    await client.request("DELETE", `/api/conversations/${encodeURIComponent(input.id)}`);
    return ok(`Deleted ${input.id}.`, { id: input.id });
  }));

  server.registerTool("create_handoff", {
    title: "Create conversation handoff",
    description: "Mints an expiring, use-limited bearer link through LLMM/LNKZ.",
    inputSchema: createHandoffSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const options = createHandoffSchema.parse(input);
    const response = await client.request<{ id: string; token: string; expiresAt: string; maxUses: number; audience?: string; shareUrl?: string }>(
      "POST", `/api/conversations/${encodeURIComponent(options.conversationId)}/handoffs`, {
        ttlMinutes: options.ttlMinutes, maxUses: options.maxUses, audience: options.audience, note: options.note, redact: options.redact,
      },
    );
    const url = response.shareUrl ?? shareUrl(response.token);
    return ok(`Handoff ${response.id} expires ${response.expiresAt} after up to ${response.maxUses} use(s): ${url}`, { ...response, shareUrl: url });
  }));

  server.registerTool("redeem_handoff", {
    title: "Redeem conversation handoff",
    description: "Loads the portable packet behind an unexpired LNKZ handoff token.",
    inputSchema: redeemHandoffSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const { token } = redeemHandoffSchema.parse(input);
    const packet = await client.request<HandoffPacket>("GET", `/share/${encodeURIComponent(token)}`);
    return ok(packet.transcriptMarkdown, { packet });
  }));

  server.registerTool("continue_handoff", {
    title: "Continue a handed-off conversation",
    description: "Redeems a handoff and stores the continuation as a linked conversation.",
    inputSchema: continueConversationSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, (input) => safe(async () => {
    const options = continueConversationSchema.parse(input);
    const packet = await client.request<HandoffPacket>("GET", `/share/${encodeURIComponent(options.token)}`);
    const parent = packet.conversation;
    const response = await client.request<{ conversation: Conversation }>("POST", "/api/conversations", {
      title: options.title || `${parent.title} (continued in ${options.provider})`,
      summary: parent.summary,
      source: { provider: options.provider, app: options.app },
      participants: parent.participants,
      tags: [...new Set([...parent.tags, "continuation"])],
      messages: [...parent.messages, ...options.messages],
      lineage: {
        parentId: parent.id,
        rootId: parent.lineage?.rootId ?? parent.id,
        handoffId: packet.handoff.id,
        continuedBy: options.provider,
      },
    } satisfies ConversationInput);
    return ok(
      `Continued ${parent.id} as ${response.conversation.id} in ${options.provider}, carrying ${parent.messages.length} prior message(s).`,
      { conversation: response.conversation, parentId: parent.id },
    );
  }));

  server.registerTool("revoke_handoff", {
    title: "Revoke handoff",
    description: "Immediately invalidates a handoff link.",
    inputSchema: revokeHandoffSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, (input) => safe(async () => {
    const { handoffId } = revokeHandoffSchema.parse(input);
    await client.request("DELETE", `/api/handoffs/${encodeURIComponent(handoffId)}`);
    return ok(`Revoked ${handoffId}.`, { handoffId });
  }));

  server.registerTool("list_handoffs", {
    title: "List handoffs",
    description: "Shows issued handoffs without returning bearer tokens.",
    inputSchema: { conversationId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const params = input.conversationId ? `?conversationId=${encodeURIComponent(input.conversationId)}` : "";
    const response = await client.request<{ handoffs: { id: string; active: boolean; uses: number; maxUses: number; expiresAt: string; audience?: string }[] }>("GET", `/api/handoffs${params}`);
    const text = response.handoffs.length
      ? response.handoffs.map((handoff) => `${handoff.id} — ${handoff.active ? "active" : "inactive"}, ${handoff.uses}/${handoff.maxUses} uses, expires ${handoff.expiresAt}${handoff.audience ? `, for ${handoff.audience}` : ""}`).join("\n")
      : "No handoffs issued.";
    return ok(text, response);
  }));

  server.registerTool("build_context_packet", {
    title: "Build a context packet",
    description: "Assembles a token-budgeted brief from stored conversations and connected sources.",
    inputSchema: contextPacketSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (input) => safe(async () => {
    const request = contextPacketSchema.parse(input);
    if (!request.query && !request.conversationIds?.length) return toolError("Provide a query, one or more conversationIds, or both.");
    const response = await client.request<{ packet: { markdown: string } }>("POST", "/api/context/packet", request);
    return ok(response.packet.markdown, response);
  }));

  server.registerTool("analyze_conversation", {
    title: "Analyze a conversation",
    description: "Extracts decisions, open questions, action items, cited facts, and topics.",
    inputSchema: analyzeSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const { conversationId } = analyzeSchema.parse(input);
    const response = await client.request<{ conversation: Conversation; analysis: ConversationAnalysis }>("GET", `/api/conversations/${encodeURIComponent(conversationId)}`);
    const analysis = response.analysis;
    return ok([
      `${response.conversation.title} — ${analysis.messageCount} messages, roughly ${analysis.approxTokens} tokens.`,
      section("Decisions", analysis.decisions.map((claim) => claim.text)),
      section("Open questions", analysis.openQuestions.map((claim) => claim.text)),
      section("Action items", analysis.actionItems.map((claim) => claim.text)),
      section("Topics", analysis.topics),
    ].filter(Boolean).join("\n\n"), { analysis });
  }));

  server.registerTool("find_conflicts", {
    title: "Find contradicting decisions",
    description: "Compares decisions across recent conversations and reports candidate disagreements.",
    inputSchema: conflictSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const options = conflictSchema.parse(input);
    const response = await client.request<{ conflicts: { reason: string; left: { title: string; text: string }; right: { title: string; text: string } }[]; scanned: number }>(
      "GET", `/api/context/conflicts?limit=${options.limit}&threshold=${options.threshold}`,
    );
    const text = response.conflicts.length
      ? response.conflicts.map((conflict) => `${conflict.reason}\n  - ${conflict.left.title}: ${conflict.left.text}\n  - ${conflict.right.title}: ${conflict.right.text}`).join("\n\n")
      : `No contradicting decisions found across ${response.scanned} conversation(s).`;
    return ok(text, response);
  }));

  server.registerTool("find_duplicates", {
    title: "Find near-duplicate conversations",
    description: "Reports conversations whose transcripts overlap heavily.",
    inputSchema: duplicateSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const options = duplicateSchema.parse(input);
    const response = await client.request<{ duplicates: { similarity: number; left: { title: string; conversationId: string }; right: { title: string; conversationId: string } }[]; scanned: number }>(
      "GET", `/api/context/duplicates?limit=${options.limit}&threshold=${options.threshold}`,
    );
    const text = response.duplicates.length
      ? response.duplicates.map((pair) => `${pair.similarity}: ${pair.left.title} (${pair.left.conversationId}) ~ ${pair.right.title} (${pair.right.conversationId})`).join("\n")
      : `No near-duplicates found across ${response.scanned} conversation(s).`;
    return ok(text, response);
  }));

  server.registerTool("search_context", {
    title: "Search connected context",
    description: "Searches LNKZ conversations plus every configured connector.",
    inputSchema: contextSearchSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (input) => safe(async () => {
    const response = await client.request<{ items: { source: string; title: string; text: string; url?: string }[]; errors: { source: string; message: string }[] }>(
      "POST", "/api/context/search", contextSearchSchema.parse(input),
    );
    const lines = response.items.length
      ? response.items.map((item) => `[${item.source}] ${item.title}: ${item.text}${item.url ? ` (${item.url})` : ""}`)
      : ["No connected source returned a match."];
    if (response.errors.length) lines.push(`Connector errors: ${response.errors.map((error) => `${error.source}: ${error.message}`).join("; ")}`);
    return ok(lines.join("\n\n"), response);
  }));

  server.registerTool("list_connectors", {
    title: "List connector status",
    description: "Shows configured and disabled context sources.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => safe(async () => {
    const response = await client.request<{ connectors: { label: string; configured: boolean; detail: string }[] }>("GET", "/api/connectors");
    return ok(response.connectors.map((status) => `${status.label}: ${status.configured ? "configured" : "disabled"}. ${status.detail}`).join("\n"), response);
  }));

  server.registerTool("workspace_stats", {
    title: "Workspace statistics",
    description: "Counts stored conversations, messages, providers, and active handoffs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => safe(async () => {
    const response = await client.request<{ stats: { conversations: number; messages: number; activeHandoffs: number; providers: { provider: string; count: number }[] } }>("GET", "/api/stats");
    const stats = response.stats;
    return ok(`${stats.conversations} conversations, ${stats.messages} messages, ${stats.activeHandoffs} active handoffs.\nProviders: ${stats.providers.map((entry) => `${entry.provider} (${entry.count})`).join(", ") || "none"}`, response);
  }));

  server.registerTool("audit_log", {
    title: "Read the audit log",
    description: "Returns recent LNKZ events.",
    inputSchema: auditSchema.shape,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const { limit } = auditSchema.parse(input);
    const response = await client.request<{ events: { at: string; kind: string; conversationId?: string; handoffId?: string }[] }>("GET", `/api/events?limit=${limit}`);
    const text = response.events.length
      ? response.events.map((event) => `${event.at} ${event.kind}${event.conversationId ? ` conversation=${event.conversationId}` : ""}${event.handoffId ? ` handoff=${event.handoffId}` : ""}`).join("\n")
      : "No events recorded.";
    return ok(text, response);
  }));

  server.registerTool("build_context_graph", {
    title: "Build the conversation graph",
    description: "Builds a graph over stored conversations, claims, topics, lineage, duplicates, and contradictions.",
    inputSchema: graphSchema,
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const options = z.object(graphSchema).parse(input);
    const params = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
    const response = await client.request<{ graph: Graph }>("GET", `/api/graph?${params}`);
    return ok(graphToMarkdown(response.graph), response);
  }));

  server.registerTool("export_conversation", {
    title: "Export a conversation",
    description: "Writes a stored conversation back out in another client's format.",
    inputSchema: { conversationId: z.string().uuid(), format: z.enum(["markdown", "markdown-brief", "openai", "chatgpt", "claude", "llmm", "latex", "text"]).default("markdown") },
    annotations: { readOnlyHint: true },
  }, (input) => safe(async () => {
    const format = input.format as ExportFormat;
    const response = await client.requestText("GET", `/api/conversations/${encodeURIComponent(input.conversationId)}/export?format=${encodeURIComponent(format)}`, undefined, { accept: "text/plain, application/json" });
    const meta = exportMetadata(format, response.contentType);
    return { content: [{ type: "text" as const, text: response.body }], structuredContent: { ...meta, bytes: Buffer.byteLength(response.body, "utf8") } };
  }));

  server.registerTool("list_publish_targets", {
    title: "List publish targets",
    description: "Discovers configured downstream MCP servers without changing anything.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, () => safe(async () => {
    const response = await client.request<{ targets: unknown[]; errors: string[] }>("GET", "/api/publish/targets");
    const text = response.targets.length ? JSON.stringify(response.targets, null, 2) : "No publish targets are configured. Set LNKZ_MCP_TARGETS to name=url pairs.";
    return ok(text, response);
  }));

  server.registerTool("prepare_publish", {
    title: "Prepare a conversation for another system",
    description: "Maps a conversation onto a downstream MCP tool's schema and returns the exact call that would be made. It never sends anything.",
    inputSchema: preparePublishSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (input) => safe(async () => {
    const response = await client.request<{ prepared: PreparedCall }>("POST", "/api/publish/prepare", z.object(preparePublishSchema).parse(input));
    const prepared = response.prepared;
    const lines = [
      `Prepared a call to ${prepared.target}.${prepared.tool}. Nothing was sent.`,
      "", JSON.stringify(prepared.arguments, null, 2), "",
      prepared.filled.length ? `Filled: ${prepared.filled.map((entry) => `${entry.name} from ${entry.from}`).join("; ")}` : "",
      prepared.missing.length ? `Still needed: ${prepared.missing.map((entry) => `${entry.name} (${entry.type})`).join(", ")}` : "",
      ...prepared.notes,
    ].filter(Boolean);
    return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: response };
  }));

  server.registerResource("connector-status", "lnkz://connectors", { title: "LNKZ connector status", description: "Configured and disabled connector inventory.", mimeType: "application/json" }, async () => jsonResource("lnkz://connectors", await client.request("GET", "/api/connectors")));
  server.registerResource("workspace-stats", "lnkz://stats", { title: "LNKZ workspace statistics", description: "Conversation, message, provider, and handoff counts.", mimeType: "application/json" }, async () => jsonResource("lnkz://stats", await client.request("GET", "/api/stats")));
  server.registerResource("recent-conversations", "lnkz://conversations", { title: "Recent LNKZ conversations", description: "The 25 most recently updated conversations.", mimeType: "application/json" }, async () => jsonResource("lnkz://conversations", await client.request("GET", "/api/conversations?limit=25")));
  server.registerResource("conversation-graph", "lnkz://graph", { title: "LNKZ conversation graph", description: "Nodes and edges over recent conversations.", mimeType: "application/json" }, async () => jsonResource("lnkz://graph", await client.request("GET", "/api/graph?limit=50")));
  server.registerResource("conversation", new ResourceTemplate("lnkz://conversation/{id}", { list: undefined }), { title: "LNKZ conversation", description: "One conversation as a portable Markdown transcript.", mimeType: "text/markdown" }, async (uri, variables) => {
    const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
    try {
      const response = await client.request<{ conversation: Conversation; analysis: ConversationAnalysis }>("GET", `/api/conversations/${encodeURIComponent(String(id ?? ""))}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: conversationToMarkdownWithAnalysis(response.conversation, response.analysis) }] };
    } catch {
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Conversation not found." }] };
    }
  });

  server.registerPrompt("continue_shared_conversation", {
    title: "Continue shared conversation",
    description: "Resume a LNKZ handoff while preserving facts, decisions, sources, and unanswered questions.",
    argsSchema: { token: z.string().min(20), goal: z.string().min(1).optional() },
  }, async ({ token, goal }) => userPrompt(`Call redeem_handoff with token ${token}. Continue from that context${goal ? ` toward this goal: ${goal}` : ""}. Preserve source attribution, distinguish facts from assumptions, restate the open questions before answering them, and when you are done call continue_handoff so the thread stays linked to the original.`));
  server.registerPrompt("research_brief", { title: "Cross-source research brief", description: "Builds a sourced brief from conversations and connected work systems.", argsSchema: { topic: z.string().min(1) } }, async ({ topic }) => userPrompt(`Call build_context_packet with query "${topic}". Write a brief that separates verified facts, decisions, assumptions, and open questions. Cite conversation ids and source URLs, and report unavailable connectors rather than filling the gap.`));
  server.registerPrompt("prepare_handoff", { title: "Prepare a conversation for handoff", description: "Summarize a conversation, then mint a scoped handoff for a named recipient.", argsSchema: { conversationId: z.string().uuid(), audience: z.string().min(1), ttlMinutes: z.string().optional() } }, async ({ conversationId, audience, ttlMinutes }) => userPrompt(`Call analyze_conversation for ${conversationId} and summarize what the recipient needs: the decision, the reason, and what is still open. Then call create_handoff for that conversation with audience "${audience}"${ttlMinutes ? `, ttlMinutes ${ttlMinutes}` : ""}, redact true, and maxUses 3. Give the recipient the share URL and the summary together, and say when it expires.`));
  server.registerPrompt("reconcile_conflicts", { title: "Reconcile contradicting decisions", description: "Review flagged contradictions and propose which decision stands.", argsSchema: {} }, async () => userPrompt("Call find_conflicts. For each pair, read both conversations with get_conversation, decide which decision is more recent and better supported, and propose a single reconciled statement. Say plainly where the evidence is too thin to choose."));

  return server;
}

type ExportFormat = "markdown" | "markdown-brief" | "openai" | "chatgpt" | "claude" | "llmm" | "latex" | "text";

function exportMetadata(format: ExportFormat, contentType: string) {
  const names: Record<ExportFormat, { mimeType: string; filename: string; reimportable: boolean }> = {
    markdown: { mimeType: "text/markdown", filename: "conversation.md", reimportable: true },
    "markdown-brief": { mimeType: "text/markdown", filename: "conversation-brief.md", reimportable: true },
    openai: { mimeType: "application/json", filename: "conversation-openai.json", reimportable: true },
    chatgpt: { mimeType: "application/json", filename: "conversation-chatgpt.json", reimportable: true },
    claude: { mimeType: "application/json", filename: "conversation-claude.json", reimportable: true },
    llmm: { mimeType: "application/json", filename: "conversation-llmm.json", reimportable: true },
    latex: { mimeType: "application/x-latex", filename: "conversation.tex", reimportable: false },
    text: { mimeType: "text/plain", filename: "conversation.txt", reimportable: true },
  };
  return { format, ...(names[format] ?? { mimeType: contentType, filename: "conversation", reimportable: false }) };
}

function conversationToMarkdownWithAnalysis(conversation: Conversation, analysis: ConversationAnalysis): string {
  const sections = [
    `# ${conversation.title}`,
    conversation.summary ? `\n${conversation.summary}` : "",
    `\n**Provider:** ${conversation.source.provider}`,
    section("Decisions", analysis.decisions.map((claim) => claim.text)),
    section("Open questions", analysis.openQuestions.map((claim) => claim.text)),
    "\n## Transcript\n",
    ...conversation.messages.map((message) => `### ${message.author || message.role}\n\n${message.content}\n`),
  ];
  return sections.filter(Boolean).join("\n").trim();
}

function graphToMarkdown(graph: Graph): string {
  const stats = graph.stats as { conversations?: number; decisions?: number; questions?: number; topics?: number; edges?: number; hubs?: { label: string; kind: string; degree: number }[]; isolated?: { label: string }[] };
  const lines = [
    "# LNKZ conversation graph", "",
    `${stats.conversations ?? 0} conversations, ${stats.decisions ?? 0} decisions, ${stats.questions ?? 0} open questions, ${stats.topics ?? 0} shared topics, ${stats.edges ?? 0} edges.`,
  ];
  if (stats.hubs?.length) lines.push("", "## Most connected", ...stats.hubs.map((hub) => `- ${hub.label} (${hub.kind}, ${hub.degree} connections)`));
  if (stats.isolated?.length) lines.push("", "## Connected to nothing else", ...stats.isolated.map((node) => `- ${node.label}`));
  return lines.join("\n");
}

function section(heading: string, values: string[]): string {
  return values.length ? `${heading}:\n${values.map((value) => `- ${value}`).join("\n")}` : "";
}

function ok(text: string, structuredContent: Record<string, unknown> | unknown) {
  return { content: [{ type: "text" as const, text }], structuredContent: structuredContent as Record<string, unknown> };
}

function toolError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

async function safe<T>(work: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await work();
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "LNKZ REST request failed.");
  }
}

function jsonResource(uri: string, payload: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
}

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}