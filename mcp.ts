import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LnkzApiError, type LnkzClientLike } from "./client.js";
import { registerSurfaces } from "./surfaces.js";
import { registerWorkspaceTools } from "./workspace.js";
import {
  analyzeSchema,
  appendMessagesSchema,
  auditSchema,
  conflictSchema,
  contextPacketSchema,
  contextSearchSchema,
  continueConversationSchema,
  conversationInputSchema,
  createHandoffSchema,
  duplicateSchema,
  importSchema,
  listConversationsSchema,
  redeemHandoffSchema,
  revokeHandoffSchema,
  searchConversationsSchema,
  type Conversation,
  type ConversationAnalysis,
  type ConversationInput,
  type MessageInput,
} from "./contract.js";

export const LNKZ_VERSION = "0.2.0";

export function createLnkzMcpServer(client: LnkzClientLike): McpServer {
  const server = new McpServer(
    { name: "lnkz", version: LNKZ_VERSION },
    {
      instructions: [
        "LNKZ carries portable conversation context between people, devices, and LLM clients.",
        "Save or import a chat, build a context packet when another model needs the gist,",
        "and create a handoff when a human or a different client needs the whole thread.",
        "Treat handoff tokens as bearer secrets and never echo them into shared output.",
      ].join(" "),
    },
  );
  const originalRegisterTool = server.registerTool.bind(server);
  const register = originalRegisterTool as unknown as (
    name: string,
    config: unknown,
    handler: (input: unknown) => Promise<unknown>,
  ) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (input: unknown) => Promise<unknown>) =>
    register(name, config, async (input: unknown) => {
      try {
        return await handler(input);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "LNKZ request failed.");
      }
    })) as typeof server.registerTool;

  registerWorkspaceTools(server, client);

  // ---------------------------------------------------------------- conversations

  server.registerTool(
    "save_conversation",
    {
      title: "Save portable conversation",
      description: "Stores a normalized conversation from any LLM client or device so it can be searched, packaged, or handed off.",
      inputSchema: conversationInputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const { conversation } = await client.saveConversation(conversationInputSchema.parse(input) as ConversationInput);
      return ok(
        `Saved "${conversation.title}" with ${conversation.messages.length} messages as ${conversation.id}.`,
        { conversation },
      );
    },
  );

  server.registerTool(
    "import_conversation",
    {
      title: "Import a chat from another client",
      description: "Normalizes a ChatGPT, Claude, Gemini, LNKZ, Markdown, or plain-text transcript into portable conversations. Format is detected automatically unless one is given.",
      inputSchema: importSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const parsed = importSchema.parse(input);
      const result = await client.importConversations(parsed);

      if (parsed.dryRun) {
        return ok(
          `Detected ${result.format}: ${result.preview?.length ?? 0} conversation(s). Nothing was written.`,
          { format: result.format, warnings: result.warnings, preview: result.preview ?? [] },
        );
      }

      const saved = result.conversations ?? [];

      const lines = [
        `Imported ${saved.length} conversation(s) as ${result.format}.`,
        ...saved.map((conversation) => `${conversation.id} — ${conversation.title} (${conversation.messages.length} messages)`),
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ];
      return ok(lines.join("\n"), {
        format: result.format,
        warnings: result.warnings,
        conversations: saved.map(summaryOf),
      });
    },
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation",
      description: "Loads a stored conversation with its messages, lineage, extracted decisions, and a portable Markdown transcript.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const { conversation, analysis } = await client.getConversation(id);
      return ok(conversationToMarkdownWithAnalysis(conversation, analysis), { conversation, analysis });
    },
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "Lists stored conversations newest first, optionally filtered by provider, tag, or participant.",
      inputSchema: listConversationsSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const options = listConversationsSchema.parse(input);
      const { conversations } = await client.listConversations(options);
      const text = conversations.length
        ? conversations.map((item) => `${item.id} — ${item.title} [${item.source.provider}] ${item.messageCount} messages, updated ${item.updatedAt}`).join("\n")
        : "No conversations stored yet.";
      return ok(text, { conversations });
    },
  );

  server.registerTool(
    "search_conversations",
    {
      title: "Search LNKZ conversations",
      description: "Full-text ranked search across saved chats by title, summary, participant, tag, or message content.",
      inputSchema: searchConversationsSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const request = searchConversationsSchema.parse(input);
      const { matches } = await client.searchConversations(request);
      const text = matches.length
        ? matches.map((match) => `${match.id} — ${match.title} (relevance ${match.relevance})\n    ${match.snippet}`).join("\n")
        : "No saved conversations matched.";
      return ok(text, { matches });
    },
  );

  server.registerTool(
    "append_messages",
    {
      title: "Append messages to a conversation",
      description: "Adds new turns to an existing conversation, which is how a thread continued in a second client stays one thread.",
      inputSchema: appendMessagesSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const { conversationId, messages } = appendMessagesSchema.parse(input);
      const { conversation } = await client.appendMessages(conversationId, messages as MessageInput[]);
      return ok(`Appended ${messages.length} message(s); ${conversation.messages.length} total.`, { conversation });
    },
  );

  registerSurfaces(server, client);

  server.registerTool(
    "delete_conversation",
    {
      title: "Delete conversation",
      description: "Permanently removes a conversation, its messages, and its handoffs.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      await client.deleteConversation(id);
      return ok(`Deleted ${id}.`, { id });
    },
  );

  // -------------------------------------------------------------------- handoffs

  server.registerTool(
    "create_handoff",
    {
      title: "Create conversation handoff",
      description: "Mints an expiring, use-limited bearer link that another person, device, or LLM client can redeem for portable context. Optionally redacts secrets before the packet leaves.",
      inputSchema: createHandoffSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const options = createHandoffSchema.parse(input);
      const { conversationId, ...request } = options;
      const handoff = await client.createHandoff(conversationId, request);
      return ok(
        `Handoff ${handoff.id} expires ${handoff.expiresAt} after up to ${handoff.maxUses} use(s): ${handoff.shareUrl}`,
        { ...handoff },
      );
    },
  );

  server.registerTool(
    "redeem_handoff",
    {
      title: "Redeem conversation handoff",
      description: "Loads the portable packet behind an unexpired LNKZ handoff token, including the transcript and the extracted decisions and open questions.",
      inputSchema: redeemHandoffSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const { token } = redeemHandoffSchema.parse(input);
      const packet = await client.redeemHandoff(token);
      return ok(packet.transcriptMarkdown, { packet });
    },
  );

  server.registerTool(
    "continue_handoff",
    {
      title: "Continue a handed-off conversation",
      description: "Redeems a handoff and stores the continuation as a new conversation in this client, linked back to the original so the chain stays walkable.",
      inputSchema: continueConversationSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const options = continueConversationSchema.parse(input);
      const { conversation: continuation, parentId } = await client.continueHandoff(options);

      return ok(
        `Continued ${parentId} as ${continuation.id} in ${options.provider}.`,
        { conversation: continuation, parentId },
      );
    },
  );

  server.registerTool(
    "revoke_handoff",
    {
      title: "Revoke handoff",
      description: "Immediately invalidates a handoff link that has already been shared.",
      inputSchema: revokeHandoffSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => {
      const { handoffId } = revokeHandoffSchema.parse(input);
      await client.revokeHandoff(handoffId);
      return ok(`Revoked ${handoffId}.`, { handoffId });
    },
  );

  server.registerTool(
    "list_handoffs",
    {
      title: "List handoffs",
      description: "Shows issued handoffs with their expiry, remaining uses, audience, and revocation state. Tokens are never returned.",
      inputSchema: { conversationId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ conversationId }) => {
      const { handoffs } = await client.listHandoffs(conversationId);
      const text = handoffs.length
        ? handoffs.map((handoff) => `${handoff.id} — ${handoff.active ? "active" : "inactive"}, ${handoff.uses}/${handoff.maxUses} uses, expires ${handoff.expiresAt}${handoff.audience ? `, for ${handoff.audience}` : ""}`).join("\n")
        : "No handoffs issued.";
      return ok(text, { handoffs });
    },
  );

  // ---------------------------------------------------------------- intelligence

  server.registerTool(
    "build_context_packet",
    {
      title: "Build a context packet",
      description: "Assembles a token-budgeted brief from stored conversations and connected sources: decisions, open questions, action items, a recent excerpt, and any contradictions between chats. Use this instead of pasting a whole transcript.",
      inputSchema: contextPacketSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const request = contextPacketSchema.parse(input);
      if (!request.query && !request.conversationIds?.length) {
        return toolError("Provide a query, one or more conversationIds, or both.");
      }
      const { packet } = await client.buildContextPacket(request);
      return ok(packet.markdown, { packet });
    },
  );

  server.registerTool(
    "analyze_conversation",
    {
      title: "Analyze a conversation",
      description: "Extracts decisions, open questions, action items, cited facts, and topics from one stored conversation without calling a model.",
      inputSchema: analyzeSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const { conversationId } = analyzeSchema.parse(input);
      const { conversation, analysis } = await client.getConversation(conversationId);
      const lines = [
        `${conversation.title} — ${analysis.messageCount} messages, roughly ${analysis.approxTokens} tokens.`,
        section("Decisions", analysis.decisions.map((claim) => claim.text)),
        section("Open questions", analysis.openQuestions.map((claim) => claim.text)),
        section("Action items", analysis.actionItems.map((claim) => claim.text)),
        section("Topics", analysis.topics),
      ].filter(Boolean);
      return ok(lines.join("\n\n"), { analysis });
    },
  );

  server.registerTool(
    "find_conflicts",
    {
      title: "Find contradicting decisions",
      description: "Compares decisions across recent conversations and reports pairs that appear to disagree. Heuristic: it surfaces candidates for review, it does not adjudicate them.",
      inputSchema: conflictSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const request = conflictSchema.parse(input);
      const { conflicts, scanned } = await client.findConflicts(request);
      const text = conflicts.length
        ? conflicts.map((conflict) => `${conflict.reason}\n  - ${conflict.left.title}: ${conflict.left.text}\n  - ${conflict.right.title}: ${conflict.right.text}`).join("\n\n")
        : `No contradicting decisions found across ${scanned} conversation(s).`;
      return ok(text, { conflicts, scanned });
    },
  );

  server.registerTool(
    "find_duplicates",
    {
      title: "Find near-duplicate conversations",
      description: "Reports conversations whose transcripts overlap heavily, which happens whenever the same chat is relayed through more than one client.",
      inputSchema: duplicateSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const request = duplicateSchema.parse(input);
      const { duplicates, scanned } = await client.findDuplicates(request);
      const text = duplicates.length
        ? duplicates.map((pair) => `${pair.similarity}: ${pair.left.title} (${pair.left.conversationId}) ~ ${pair.right.title} (${pair.right.conversationId})`).join("\n")
        : `No near-duplicates found across ${scanned} conversation(s).`;
      return ok(text, { duplicates, scanned });
    },
  );

  // ------------------------------------------------------------------ federation

  server.registerTool(
    "search_context",
    {
      title: "Search connected context",
      description: "Searches LNKZ conversations plus every configured connector (Slack, Jira, Figma, documentation feeds, and any federated MCP server) in one call, reporting per-source failures instead of hiding them.",
      inputSchema: contextSearchSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const request = contextSearchSchema.parse(input);
      const result = await client.searchContext(request);
      const lines = result.items.length
        ? result.items.map((item) => `[${item.source}] ${item.title}: ${item.text}${item.url ? ` (${item.url})` : ""}`)
        : ["No connected source returned a match."];
      if (result.errors.length) {
        lines.push(`Connector errors: ${result.errors.map((error) => `${error.source}: ${error.message}`).join("; ")}`);
      }
      return ok(lines.join("\n\n"), { ...result });
    },
  );

  server.registerTool(
    "list_connectors",
    {
      title: "List connector status",
      description: "Shows which context sources are configured and which are disabled, with the reason.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { connectors: statuses } = await client.listConnectors();
      const text = statuses
        .map((status) => `${status.label}: ${status.configured ? "configured" : "disabled"}. ${status.detail}`)
        .join("\n");
      return ok(text, { connectors: statuses });
    },
  );

  server.registerTool(
    "workspace_stats",
    {
      title: "Workspace statistics",
      description: "Counts stored conversations and messages, the providers they came from, and active handoffs.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { stats } = await client.stats();
      const providers = stats.providers.map((entry) => `${entry.provider} (${entry.count})`).join(", ") || "none";
      return ok(
        `${stats.conversations} conversations, ${stats.messages} messages, ${stats.activeHandoffs} active handoffs.\nProviders: ${providers}`,
        { stats },
      );
    },
  );

  server.registerTool(
    "audit_log",
    {
      title: "Read the audit log",
      description: "Returns recent LNKZ events: saves, imports, handoff creation, redemption, rejection, and revocation.",
      inputSchema: auditSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const { limit } = auditSchema.parse(input);
      const { events } = await client.audit(limit);
      const text = events.length
        ? events.map((event) => `${event.at} ${event.kind}${event.conversationId ? ` conversation=${event.conversationId}` : ""}${event.handoffId ? ` handoff=${event.handoffId}` : ""}`).join("\n")
        : "No events recorded.";
      return ok(text, { events });
    },
  );

  // ------------------------------------------------------------------- resources

  server.registerResource(
    "connector-status",
    "lnkz://connectors",
    { title: "LNKZ connector status", description: "Configured and disabled connector inventory.", mimeType: "application/json" },
    async () => jsonResource("lnkz://connectors", await client.listConnectors()),
  );

  server.registerResource(
    "workspace-stats",
    "lnkz://stats",
    { title: "LNKZ workspace statistics", description: "Conversation, message, provider, and handoff counts.", mimeType: "application/json" },
    async () => jsonResource("lnkz://stats", (await client.stats()).stats),
  );

  server.registerResource(
    "recent-conversations",
    "lnkz://conversations",
    { title: "Recent LNKZ conversations", description: "The 25 most recently updated conversations.", mimeType: "application/json" },
    async () => jsonResource("lnkz://conversations", await client.listConversations({ limit: 25 })),
  );

  server.registerResource(
    "conversation",
    new ResourceTemplate("lnkz://conversation/{id}", { list: undefined }),
    { title: "LNKZ conversation", description: "One conversation as a portable Markdown transcript.", mimeType: "text/markdown" },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      if (!id) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Conversation not found." }] };
      }
      try {
        const { conversation, analysis } = await client.getConversation(id);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/markdown",
            text: conversationToMarkdownWithAnalysis(conversation, analysis),
          }],
        };
      } catch (error) {
        if (error instanceof LnkzApiError && error.status === 404) {
          return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Conversation not found." }] };
        }
        throw error;
      }
    },
  );

  // --------------------------------------------------------------------- prompts

  server.registerPrompt(
    "continue_shared_conversation",
    {
      title: "Continue shared conversation",
      description: "Resume an LNKZ handoff while preserving facts, decisions, sources, and unanswered questions.",
      argsSchema: { token: z.string().min(20), goal: z.string().min(1).optional() },
    },
    async ({ token, goal }) => userPrompt(
      `Call redeem_handoff with token ${token}. Continue from that context${goal ? ` toward this goal: ${goal}` : ""}. `
      + "Preserve source attribution, distinguish facts from assumptions, restate the open questions before answering them, "
      + "and when you are done call continue_handoff so the thread stays linked to the original.",
    ),
  );

  server.registerPrompt(
    "research_brief",
    {
      title: "Cross-source research brief",
      description: "Builds a sourced brief from conversations and connected work systems.",
      argsSchema: { topic: z.string().min(1) },
    },
    async ({ topic }) => userPrompt(
      `Call build_context_packet with query "${topic}". Write a brief that separates verified facts, decisions, assumptions, and open questions. `
      + "Cite conversation ids and source URLs, and report unavailable connectors rather than filling the gap.",
    ),
  );

  server.registerPrompt(
    "prepare_handoff",
    {
      title: "Prepare a conversation for handoff",
      description: "Summarize a conversation, then mint a scoped handoff for a named recipient.",
      argsSchema: { conversationId: z.string().uuid(), audience: z.string().min(1), ttlMinutes: z.string().optional() },
    },
    async ({ conversationId, audience, ttlMinutes }) => userPrompt(
      `Call analyze_conversation for ${conversationId} and summarize what the recipient needs: the decision, the reason, and what is still open. `
      + `Then call create_handoff for that conversation with audience "${audience}"`
      + `${ttlMinutes ? `, ttlMinutes ${ttlMinutes}` : ""}, redact true, and maxUses 3. `
      + "Give the recipient the share URL and the summary together, and say when it expires.",
    ),
  );

  server.registerPrompt(
    "reconcile_conflicts",
    {
      title: "Reconcile contradicting decisions",
      description: "Review flagged contradictions and propose which decision stands.",
      argsSchema: {},
    },
    async () => userPrompt(
      "Call find_conflicts. For each pair, read both conversations with get_conversation, decide which decision is more recent and better supported, "
      + "and propose a single reconciled statement. Say plainly where the evidence is too thin to choose.",
    ),
  );

  return server;
}

function summaryOf(conversation: Conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    provider: conversation.source.provider,
    messageCount: conversation.messages.length,
    updatedAt: conversation.updatedAt,
  };
}

function conversationToMarkdownWithAnalysis(
  conversation: Conversation,
  analysis: ConversationAnalysis,
): string {
  const lines = [
    `# ${conversation.title}`,
    "",
    `Source: ${conversation.source.provider}`,
    `Updated: ${conversation.updatedAt}`,
  ];
  if (conversation.summary) lines.push("", conversation.summary);
  lines.push("", "## Conversation", "");
  for (const message of conversation.messages) {
    lines.push(`### ${message.author || roleLabel(message.role)}`, "", message.content, "");
  }
  const decisions = section("Decisions", analysis.decisions.map((claim) => claim.text));
  const questions = section("Open questions", analysis.openQuestions.map((claim) => claim.text));
  if (decisions || questions) lines.push("## Analysis", "", decisions, questions);
  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
}

function roleLabel(role: string): string {
  return role === "assistant" ? "Assistant" : role === "system" ? "System" : role === "tool" ? "Tool" : "User";
}

function section(heading: string, values: string[]): string {
  if (!values.length) return "";
  return `${heading}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function ok(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function toolError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function jsonResource(uri: string, payload: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
}

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}
