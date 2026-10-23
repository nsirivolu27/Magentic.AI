import { z } from "zod";

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

export const createHandoffSchema = z.object({
  conversationId: z.string().uuid(),
  ttlMinutes: z.number().int().min(5).max(10_080).default(60),
  maxUses: z.number().int().min(1).max(1_000).default(25),
  audience: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1_000).optional(),
  redact: z.boolean().default(false),
});

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
export const graphSchema = {
  limit: z.number().int().min(2).max(200).default(50),
  minTopicConversations: z.number().int().min(2).max(20).default(2),
  duplicateThreshold: z.number().min(0.2).max(0.99).default(0.6),
  conflictThreshold: z.number().min(0.1).max(0.95).default(0.45),
  maxTopics: z.number().int().min(1).max(200).default(40),
};
export const publishShapeSchema = z.enum(["summary", "decisions", "transcript", "brief"]);
export const preparePublishSchema = {
  conversationId: z.string().uuid(),
  target: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(120),
  shape: publishShapeSchema.default("summary"),
};