export type MessageRole = "system" | "user" | "assistant" | "tool" | "other";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  author?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
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

export interface Conversation {
  id: string;
  version: 1;
  title: string;
  summary?: string;
  source: ConversationSource;
  participants: string[];
  tags: string[];
  messages: ConversationMessage[];
  lineage?: ConversationLineage;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export type MessageInput =
  & Partial<Pick<ConversationMessage, "id" | "author" | "createdAt" | "metadata">>
  & Pick<ConversationMessage, "role" | "content">;

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

export interface ConversationSummary {
  id: string;
  title: string;
  summary?: string;
  source: ConversationSource;
  participants: string[];
  tags: string[];
  messageCount: number;
  lineage?: ConversationLineage;
  createdAt: string;
  updatedAt: string;
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

export interface AnalysisClaim {
  text: string;
  messageId: string;
  author: string;
  createdAt: string;
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

export interface Graph {
  nodes: { id: string; kind: string; label: string; conversationId?: string; weight: number; metadata?: Record<string, unknown> }[];
  edges: { from: string; to: string; kind: string; weight: number; reason: string }[];
  stats: Record<string, unknown>;
  generatedAt: string;
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