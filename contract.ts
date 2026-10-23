import { z } from "zod";

export type ConnectorId = "lnkz" | "slack" | "jira" | "figma" | "documents" | "fantasy";
export type MessageRole = "system" | "user" | "assistant" | "tool" | "other";

export interface MessageInput {
  id?: string;
  role: MessageRole;
  content: string;
  author?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessage extends Omit<MessageInput, "id" | "createdAt"> {
  id: string;
  createdAt: string;
}

export interface ConversationSource {
  provider: string;
  app?: string;
  deviceId?: string;
  externalConversationId?: string;
  url?: string;
}

export interface ConversationLineage {
  parentId?: string;
  rootId?: string;
  handoffId?: string;
  continuedBy?: string;
}

export interface ConversationInput {
  id?: string;
  title: string;
  summary?: string;
  source: ConversationSource;
  participants?: string[];
  tags?: string[];
  messages: MessageInput[];
  lineage?: ConversationLineage;
  metadata?: Record<string, unknown>;
}

export interface Conversation extends Omit<ConversationInput, "id" | "participants" | "tags" | "messages"> {
  id: string;
  version: 1;
  participants: string[];
  tags: string[];
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends Omit<Conversation, "messages"> {
  messageCount: number;
}

export interface ConversationMatch extends ConversationSummary {
  relevance: number;
  snippet: string;
}

export interface AnalysisClaim {
  text: string;
  messageId: string;
  author: string;
  createdAt: string;
}

export interface ConversationAnalysis {
  decisions: AnalysisClaim[];
  openQuestions: AnalysisClaim[];
  actionItems: AnalysisClaim[];
  facts: AnalysisClaim[];
  topics: string[];
  participants: string[];
  messageCount: number;
  approxTokens: number;
  span: { start?: string; end?: string };
}

export interface HandoffIssue {
  id: string;
  token: string;
  shareUrl: string;
  expiresAt: string;
  maxUses: number;
  audience?: string;
  redact: boolean;
}

export interface HandoffSummary {
  id: string;
  conversationId: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt?: string;
  audience?: string;
  note?: string;
  redact: boolean;
  active: boolean;
}

export interface HandoffPacket {
  format: "lnkz.conversation.v1";
  conversation: Conversation;
  transcriptMarkdown: string;
  analysis: ConversationAnalysis;
  redaction: { applied: boolean; removed: { kind: string; count: number }[] };
  handoff: { id: string; usesRemaining: number | null; expiresAt: string; audience?: string };
  exportedAt: string;
}

export interface ConflictPair {
  left: { conversationId: string; title: string; text: string };
  right: { conversationId: string; title: string; text: string };
  reason: string;
  similarity: number;
}

export interface DuplicatePair {
  left: { conversationId: string; title: string };
  right: { conversationId: string; title: string };
  similarity: number;
}

export interface ContextPacket {
  query?: string;
  generatedAt: string;
  budgetTokens: number;
  usedTokens: number;
  conversations: {
    id: string;
    title: string;
    provider: string;
    updatedAt: string;
    relevance: number;
    decisions: string[];
    openQuestions: string[];
    actionItems: string[];
    excerpt: string;
  }[];
  external: ContextItem[];
  conflicts: ConflictPair[];
  markdown: string;
}

export interface ContextItem {
  source: ConnectorId;
  id: string;
  title: string;
  text: string;
  url?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  items: ContextItem[];
  errors: { source: ConnectorId; message: string }[];
  searchedSources: ConnectorId[];
}

export interface ConnectorStatus {
  id: ConnectorId;
  label: string;
  configured: boolean;
  detail: string;
}

export interface StoreStats {
  conversations: number;
  messages: number;
  providers: { provider: string; count: number }[];
  activeHandoffs: number;
  events: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  kind: string;
  actorId?: string;
  conversationId?: string;
  handoffId?: string;
  detail?: Record<string, unknown>;
}

export interface ConversationGraph {
  nodes: { id: string; kind: string; label: string; conversationId?: string; weight: number; metadata?: Record<string, unknown> }[];
  edges: { from: string; to: string; kind: string; weight: number; reason: string }[];
  stats: {
    conversations: number;
    decisions: number;
    questions: number;
    topics: number;
    edges: number;
    hubs: { id: string; label: string; kind: string; degree: number }[];
    isolated: { id: string; label: string }[];
  };
  generatedAt: string;
}

export interface TargetTools {
  target: string;
  url: string;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown>; write: boolean }[];
  error?: string;
}

export interface PreparedCall {
  target: string;
  tool: string;
  arguments: Record<string, unknown>;
  missing: { name: string; type: string; description?: string }[];
  filled: { name: string; from: string }[];
  notes: string[];
  sent: false;
}

export const connectorIdSchema = z.enum(["lnkz", "slack", "jira", "figma", "documents", "fantasy"]);
export const importFormatSchema = z.enum([
  "auto", "chatgpt", "claude", "gemini", "openai", "lnkz", "generic", "markdown", "text",
]);
export const lineageSchema = z.object({
  parentId: z.string().uuid().optional(),
  rootId: z.string().uuid().optional(),
  handoffId: z.string().uuid().optional(),
  continuedBy: z.string().trim().max(120).optional(),
});
export const messageSchema = z.object({
  id: z.string().trim().min(1).max(240).optional(),
  role: z.enum(["system", "user", "assistant", "tool", "other"]),
  content: z.string().trim().min(1).max(200_000),
  author: z.string().trim().max(160).optional(),
  createdAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export const conversationInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(20_000).optional(),
  source: z.object({
    provider: z.string().trim().min(1).max(80),
    app: z.string().trim().max(120).optional(),
    deviceId: z.string().trim().max(200).optional(),
    externalConversationId: z.string().trim().max(500).optional(),
    url: z.string().url().optional(),
  }),
  participants: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  messages: z.array(messageSchema).min(1).max(5_000),
  lineage: lineageSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export const appendMessagesSchema = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(messageSchema).min(1).max(500),
});
export const listConversationsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).max(100_000).default(0),
  provider: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(80).optional(),
  participant: z.string().trim().max(160).optional(),
});
export const searchConversationsSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(50).default(10),
});
export const contextSearchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(50).default(10),
  sources: z.array(connectorIdSchema).optional(),
  excludeSources: z.array(connectorIdSchema).optional(),
});
export const importSchema = z.object({
  payload: z.string().min(1).max(20_000_000),
  format: importFormatSchema.default("auto"),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  dryRun: z.boolean().default(false),
});
/**
 * The three fields that decide what a share link is are optional rather than
 * defaulted, on purpose. A default here is a guess about a situation the
 * tool cannot see, and advertising one told every caller the question was
 * already settled. Left out, the person is asked (see elicit.ts); if their
 * client cannot ask, HANDOFF_FALLBACKS applies the values this schema used
 * to hard-code, so nothing that worked before behaves differently.
 */
export const createHandoffSchema = z.object({
  conversationId: z.string().uuid(),
  ttlMinutes: z.number().int().min(5).max(10_080).optional(),
  maxUses: z.number().int().min(1).max(1_000).optional(),
  audience: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1_000).optional(),
  redact: z.boolean().optional(),
});

/** What a handoff is when nobody said and nobody could be asked. */
export const HANDOFF_FALLBACKS = { ttlMinutes: 60, maxUses: 25, redact: false } as const;
export const redeemHandoffSchema = z.object({ token: z.string().trim().min(20).max(500) });
export const revokeHandoffSchema = z.object({ handoffId: z.string().uuid() });
export const contextPacketSchema = z.object({
  query: z.string().trim().min(1).max(1_000).optional(),
  conversationIds: z.array(z.string().uuid()).max(20).optional(),
  budgetTokens: z.number().int().min(500).max(60_000).default(4_000),
  maxConversations: z.number().int().min(1).max(20).default(5),
  includeExternal: z.boolean().default(true),
});
export const continueConversationSchema = z.object({
  token: z.string().trim().min(20).max(500),
  provider: z.string().trim().min(1).max(80),
  app: z.string().trim().max(120).optional(),
  title: z.string().trim().max(240).optional(),
  messages: z.array(messageSchema).min(1).max(500),
});
/**
 * Pulling a conversation off another instance's link.
 *
 * The relay does the fetching, not this adapter. That keeps every SSRF guard
 * in one place: protocol allowlist, no credentials in the URL, public
 * addresses only, size cap, timeout. An adapter that dialled the link itself
 * would be a second, weaker copy of those rules.
 */
export const importUrlSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  dryRun: z.boolean().default(false),
});

export const previewLinkSchema = z.object({ url: z.string().trim().min(1).max(2_048) });

/**
 * Continuing someone else's link, as distinct from one this relay minted.
 * The two produce different lineage, so they are different calls rather than
 * one call with an optional field.
 */
export const continueFromLinkSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  provider: z.string().trim().min(1).max(80),
  app: z.string().trim().max(120).optional(),
  title: z.string().trim().max(240).optional(),
  messages: z.array(messageSchema).min(1).max(500),
});

export interface TransferOrigin {
  instance: string;
  url: string;
  handoffId?: string;
  conversationId?: string;
}

export interface LinkPreview {
  origin: { instance: string; url: string };
  warnings: string[];
  preview: {
    title: string;
    provider: string;
    messages: number;
    usesRemaining: number;
    expiresAt: string;
    redact: boolean;
  };
}

export const analyzeSchema = z.object({ conversationId: z.string().uuid() });
export const conflictSchema = z.object({
  limit: z.number().int().min(2).max(100).default(30),
  threshold: z.number().min(0.1).max(0.95).default(0.45),
});
export const duplicateSchema = z.object({
  limit: z.number().int().min(2).max(100).default(30),
  threshold: z.number().min(0.2).max(0.99).default(0.6),
});
export const auditSchema = z.object({ limit: z.number().int().min(1).max(500).default(50) });
export const EXPORT_FORMATS = [
  "markdown", "markdown-brief", "openai", "chatgpt", "claude", "lnkz", "latex", "text",
] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
