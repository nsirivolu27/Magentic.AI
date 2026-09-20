import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { LnkzApiError, type LnkzClientLike } from "./client.js";
import { registerSurfaces } from "./surfaces.js";
import { registerWorkspaceTools } from "./workspace.js";
import { createSuggestions, resolveConversation, shortId } from "./suggest.js";
import { askHandoffChoices, clientSupportsElicitation, missingChoices } from "./elicit.js";
import { setting } from "./env.js";
import { legacyUrisEnabled, registerAliasedResource, LEGACY_SCHEME, SCHEME } from "./resources.js";
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
  HANDOFF_FALLBACKS,
  duplicateSchema,
  importSchema,
  importUrlSchema,
  previewLinkSchema,
  continueFromLinkSchema,
  listConversationsSchema,
  redeemHandoffSchema,
  revokeHandoffSchema,
  searchConversationsSchema,
  type Conversation,
  type ConversationAnalysis,
  type ConversationInput,
  type MessageInput,
} from "./contract.js";

export const MAGENTIC_VERSION = "0.2.0";

/**
 * Tools that change something: on this relay, on someone else's, or to a
 * link's remaining uses. redeem_handoff is here because redeeming spends a
 * use, which is a change even though nothing is stored locally.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "save_conversation",
  "import_conversation",
  "import_from_url",
  "append_messages",
  "delete_conversation",
  "create_handoff",
  "redeem_handoff",
  "continue_handoff",
  "continue_from_link",
  "revoke_handoff",
  // Exporting a dataset does not change the relay, but it takes conversation
  // content out of it, which is the thing a read-only deployment is trying to
  // prevent. Hidden with the writes.
  "export_training_dataset",
]);

export interface McpServerOptions {
  /**
   * Whether this adapter exposes the tools that change things. Defaults to
   * true, which is what every existing deployment already has.
   *
   * This is exposure, not enforcement. The relay decides what the API key may
   * actually do and will refuse a write on a read-only key regardless of what
   * is registered here. What this controls is what a model can see, which
   * matters for a different reason: a model cannot plan around a tool that
   * does not appear in its list, so a reader-only deployment stops getting
   * proposals to delete things it was never going to be allowed to delete.
   */
  allowWrites?: boolean;

  /**
   * Restrict this server to a named set of tools. Absent means every tool,
   * which is what a direct connection to the adapter gets.
   *
   * This is how one hosted process serves several agents: a request arriving
   * at an agent's endpoint builds a server with that agent's allowlist, so
   * the tools outside it are not registered rather than registered and
   * refusing. allowWrites still applies on top, and an allowlist cannot
   * widen it: a read-only deployment stays read-only however an agent is
   * defined.
   */
  tools?: ReadonlySet<string>;

  /**
   * Replace the server instructions a client reads on connect. An agent is
   * mostly a description of what it is for, and the instructions are where a
   * model actually reads that.
   */
  instructions?: string;

  /**
   * Every tool name the server considered registering, appended as it goes.
   * Only magenticToolNames uses it, to learn what this build actually exposes
   * rather than trusting a list someone typed.
   */
  collect?: string[];
}

/** Read the exposure setting. Anything other than an explicit read-only wins nothing. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerOptions {
  const declared = (setting("MAGENTIC_SCOPES", env) ?? "").trim().toLowerCase();
  if (!declared) return { allowWrites: true };
  const scopes = new Set(declared.split(/[\s,]+/).filter(Boolean));
  return { allowWrites: scopes.has("write") };
}

const DEFAULT_INSTRUCTIONS = [
  "LNKZ carries portable conversation context between people, devices, and LLM clients.",
  "Save or import a chat, build a context packet when another model needs the gist,",
  "and create a handoff when a human or a different client needs the whole thread.",
  "Treat handoff tokens as bearer secrets and never echo them into shared output.",
].join(" ");

/**
 * Every tool this build registers, read from the build rather than listed by
 * hand. A hand-written list is a list that drifts, and the thing it would
 * drift away from is what an agent definition is checked against.
 *
 * The probe client throws on any call, which is safe because registration
 * only describes tools; nothing reaches the relay until one is invoked.
 */
let toolNames: readonly string[] | undefined;
export function magenticToolNames(): readonly string[] {
  if (toolNames) return toolNames;
  const collect: string[] = [];
  const probe = new Proxy({}, {
    get: () => () => {
      throw new Error("The tool-name probe must not reach the relay.");
    },
  }) as LnkzClientLike;
  createMagenticMcpServer(probe, { allowWrites: true, collect });
  toolNames = [...new Set(collect)].sort();
  return toolNames;
}

export function createMagenticMcpServer(client: LnkzClientLike, options: McpServerOptions = {}): McpServer {
  const allowWrites = options.allowWrites ?? true;
  const server = new McpServer(
    { name: "magentic", version: MAGENTIC_VERSION },
    {
      instructions: options.instructions?.trim() || DEFAULT_INSTRUCTIONS,
    },
  );
  const originalRegisterTool = server.registerTool.bind(server);
  const register = originalRegisterTool as unknown as (
    name: string,
    config: unknown,
    handler: (input: unknown) => Promise<unknown>,
  ) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (input: unknown) => Promise<unknown>) => {
    options.collect?.push(name);
    // Not registered rather than registered-and-refusing. A tool a model
    // cannot see is a tool it will not build a plan around.
    if (!allowWrites && WRITE_TOOLS.has(name)) return undefined as never;
    // The allowlist is checked after the write gate, never instead of it.
    // An agent narrows what this deployment offers; it cannot widen it.
    if (options.tools && !options.tools.has(name)) return undefined as never;
    return register(name, config, async (input: unknown) => {
      try {
        return await handler(input);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "LNKZ request failed.");
      }
    });
  }) as typeof server.registerTool;

  // One suggestion source per server, so a burst of keystrokes shares a
  // single relay request. See suggest.ts.
  const suggestions = createSuggestions(client);

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
      description: "Mints an expiring, use-limited bearer link that another person, device, or LLM client can redeem for portable context. Leave ttlMinutes, maxUses or redact out and the person is asked, so the link matches the situation instead of a default; pass them to decide without a prompt. Redaction strips names, addresses and keys before the packet leaves.",
      inputSchema: createHandoffSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      const options = createHandoffSchema.parse(input);
      const unanswered = missingChoices(options);

      // Only looked up when there is a question to put a name on. A client
      // that cannot be asked should not pay for a listing nobody reads.
      const willAsk = unanswered.length > 0 && clientSupportsElicitation(server);
      const title = willAsk
        ? (await suggestions.conversations().catch(() => []))
            .find((entry) => entry.id === options.conversationId)?.title
        : undefined;

      const asked = await askHandoffChoices(server, title ?? "this conversation", unanswered);
      if (asked.asked && !asked.accepted) {
        // Being shown the question and dismissing it is not agreement to an
        // hour-long unredacted link, so nothing is minted.
        return toolError(
          `No handoff was created: the ${asked.reason === "declined" ? "request was declined" : "prompt was dismissed"}. `
          + "Pass ttlMinutes, maxUses and redact directly to skip the question.",
        );
      }

      const { conversationId, ...request } = options;
      const chosen = asked.asked && asked.accepted ? asked.choices : {};
      // Fallbacks last and only where still unset, so an answer beats them
      // and an explicit argument beats everything.
      const handoff = await client.createHandoff(conversationId, {
        ...HANDOFF_FALLBACKS,
        ...clean(request),
        ...clean(chosen),
      });
      return ok(
        `Handoff ${handoff.id}${title ? ` for "${title}"` : ""} expires ${handoff.expiresAt} `
        + `after up to ${handoff.maxUses} use(s)`
        + `${handoff.redact ? ", redacted" : ", not redacted"}: ${handoff.shareUrl}`,
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
    "import_from_url",
    {
      title: "Pull a conversation from another LNKZ",
      description:
        "Fetches a LNKZ share link through the relay and stores the conversation there. This is how a conversation "
        + "moves between two people running their own instances: they send a link, you import it, and it becomes "
        + "yours, continuable without touching their server again. Lineage records which instance it came from.",
      inputSchema: importUrlSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const options = importUrlSchema.parse(input);
      if (options.dryRun) {
        const peek = await client.previewLink(options.url);
        return ok(
          `${peek.origin.instance} offers "${peek.preview.title}" from ${peek.preview.provider} with `
          + `${peek.preview.messages} message(s). Nothing was written and no use was spent.`,
          { origin: peek.origin, preview: peek.preview },
        );
      }
      const result = await client.importFromUrl(options);
      return ok(
        `Imported "${result.conversation.title}" from ${result.origin.instance} as ${result.conversation.id}.`,
        result,
      );
    },
  );

  server.registerTool(
    "preview_handoff",
    {
      title: "Look at a link without taking it",
      description:
        "Reports what a LNKZ share link contains without redeeming it: title, provider, message count, uses "
        + "remaining and whether it will be redacted. Never returns the transcript and never spends one of the "
        + "link's uses, so it is safe on a one-use link. Use it before import_from_url or continue_from_link when "
        + "you are not sure what someone sent you.",
      inputSchema: previewLinkSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { url } = previewLinkSchema.parse(input);
      const peek = await client.previewLink(url);
      const lines = [
        `"${peek.preview.title}" from ${peek.preview.provider}, ${peek.preview.messages} message(s).`,
        `Offered by ${peek.origin.instance}.`,
        `${peek.preview.usesRemaining} use(s) left, expiring ${peek.preview.expiresAt}.`,
        peek.preview.redact ? "It will be redacted on the way out." : "It will be sent unredacted.",
        "Nothing was written and no use was spent.",
      ];
      return ok(lines.join("\n"), { origin: peek.origin, preview: peek.preview });
    },
  );

  server.registerTool(
    "continue_from_link",
    {
      title: "Continue someone else's conversation here",
      description:
        "Takes a LNKZ share link from another instance and stores your continuation of it as a new conversation, "
        + "recording which instance it came from and which provider carried it forward. Different from "
        + "import_from_url followed by append_messages: that edits your copy and leaves nothing saying the work "
        + "moved on. Use continue_handoff for a link this relay minted.",
      inputSchema: continueFromLinkSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const options = continueFromLinkSchema.parse(input);
      const result = await client.continueFromLink(options);
      const lines = [
        `Continued ${result.origin.instance}'s conversation as ${result.conversation.id} in ${options.provider}.`,
        `It carries ${result.conversation.messages.length} message(s), including everything that came before.`,
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ];
      return ok(lines.join("\n"), result);
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

  registerAliasedResource(
    server,
    "connector-status",
    "connectors",
    { title: "Connector status", description: "Configured and disabled connector inventory.", mimeType: "application/json" },
    async (uri) => jsonResource(uri, await client.listConnectors()),
  );

  registerAliasedResource(
    server,
    "workspace-stats",
    "stats",
    { title: "Workspace statistics", description: "Conversation, message, provider, and handoff counts.", mimeType: "application/json" },
    async (uri) => jsonResource(uri, (await client.stats()).stats),
  );

  registerAliasedResource(
    server,
    "recent-conversations",
    "conversations",
    { title: "Recent conversations", description: "The 25 most recently updated conversations.", mimeType: "application/json" },
    async (uri) => jsonResource(uri, await client.listConversations({ limit: 25 })),
  );

  const conversationTemplateOptions = (scheme: string) => ({
    // A list callback is what puts conversations in a client's resource
    // picker, so a person points at one by title instead of a model going
    // looking for it by id. The completion callback narrows that list as
    // they type. The protocol only completes prompt arguments and resource
    // template variables, never tool arguments, so this and the prompts
    // below are the whole of where completion can help.
    list: async () => {
        const conversations = await suggestions.conversations().catch(() => []);
        return {
          resources: conversations.map((conversation) => ({
            uri: `${scheme}://conversation/${conversation.id}`,
            name: conversation.title,
            description: `${conversation.source.provider} \u00b7 ${conversation.messageCount} messages \u00b7 ${shortId(conversation.id)}`,
            mimeType: "text/markdown",
          })),
        };
      },
      complete: {
        id: async (value: string) => {
          const conversations = await suggestions.conversations().catch(() => []);
          const needle = value.trim().toLowerCase();
          return conversations
            .filter((conversation) =>
              !needle
              || conversation.id.startsWith(needle)
              || conversation.title.toLowerCase().includes(needle))
            .slice(0, 25)
            .map((conversation) => conversation.id);
        },
      },
  });

  const conversationConfig = {
    title: "Conversation",
    description: "One conversation as a portable Markdown transcript.",
    mimeType: "text/markdown",
  };

  const readConversation = async (uri: URL, variables: Record<string, string | string[]>) => {
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
    };

  server.registerResource(
    "conversation",
    new ResourceTemplate(`${SCHEME}://conversation/{id}`, conversationTemplateOptions(SCHEME)),
    conversationConfig,
    readConversation,
  );

  if (legacyUrisEnabled()) {
    server.registerResource(
      "conversation-legacy",
      new ResourceTemplate(`${LEGACY_SCHEME}://conversation/{id}`, conversationTemplateOptions(LEGACY_SCHEME)),
      { ...conversationConfig, description: `${conversationConfig.description} Deprecated alias for ${SCHEME}://conversation/{id}.` },
      readConversation,
    );
  }

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
      argsSchema: { topic: completable(z.string().min(1), (value) => suggestions.tags(value ?? "")) },
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
      // A title or an id. Completion offers titles because nobody recognises
      // a uuid, and the handler resolves whichever arrived back to one
      // conversation before the model sees it.
      argsSchema: {
        conversation: completable(z.string().min(1), (value) => suggestions.conversationTitles(value ?? "")),
        audience: z.string().min(1),
        ttlMinutes: z.string().optional(),
      },
    },
    async ({ conversation, audience, ttlMinutes }) => {
      const found = await resolveConversation(client, conversation, suggestions);
      if (!found.ok) return userPrompt(found.message);
      const conversationId = found.conversation.id;
      return userPrompt(
      `Call analyze_conversation for ${conversationId} ("${found.conversation.title}") and summarize what the recipient needs: the decision, the reason, and what is still open. `
      + `Then call create_handoff for that conversation with audience "${audience}"`
      + `${ttlMinutes ? `, ttlMinutes ${ttlMinutes}` : ""}, redact true, and maxUses 3. `
      + "Give the recipient the share URL and the summary together, and say when it expires.",
      );
    },
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

/** Drop absent keys so a spread cannot overwrite a set value with undefined. */
function clean<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
