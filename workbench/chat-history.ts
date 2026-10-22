import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatVault } from "./chat-vault.js";

const turnSchema = z.object({
  role: z.enum(["user", "assistant"]), content: z.string().min(1).max(12000),
  model: z.string().max(500).optional(), assistant: z.string().max(200).optional(),
  usage: z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative() }).strict().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  tools: z.array(z.object({ name: z.string().max(100), state: z.enum(["running", "done", "failed"]) }).strict()).max(60).optional(),
}).strict();
const draftSchema = z.object({
  channel: z.enum(["general", "workspace"]), profile: z.union([z.literal(""), z.string().uuid()]),
  selectedModel: z.string().min(1).max(200), messages: z.array(turnSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.channel === "general" && value.profile) context.addIssue({ code: "custom", path: ["profile"], message: "General chat cannot use a profile." });
  if (value.messages.reduce((size, item) => size + item.content.length, 0) > 100000) context.addIssue({ code: "custom", path: ["messages"], message: "Save up to 100,000 characters per chat." });
});
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("save"), id: z.string().uuid().optional(), expectedRevision: z.number().int().nonnegative(), chat: draftSchema }).strict(),
]);
export interface SavedChat {
  id: string; revision: number; title: string; updatedAt: string;
  chat: z.infer<typeof draftSchema>;
}
export type SavedChatSummary = Omit<SavedChat, "chat">;
export class ChatHistoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function createChatHistory(vault: ChatVault) {
  const key = (workspace: string, actor: string) => JSON.stringify(["chat-history", workspace, actor]);
  const read = (workspace: string, actor: string) => (vault.read(key(workspace, actor)) ?? []) as SavedChat[];
  return {
    list(workspace: string, actor: string): SavedChatSummary[] {
      return read(workspace, actor).map(({ chat, ...summary }) => summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    execute(workspace: string, actor: string, raw: unknown): SavedChat {
      const command = commandSchema.parse(raw);
      const records = read(workspace, actor);
      const existing = records.find(item => item.id === command.id);
      if (command.id && !existing) throw new ChatHistoryError(404, "Chat not found in your workspace account.");
      if (command.action === "open") return structuredClone(existing!);
      if (command.expectedRevision !== (existing?.revision ?? 0)) throw new ChatHistoryError(409, "This chat changed in another tab. Reopen it before saving.");
      if (!existing && records.length >= 30) throw new ChatHistoryError(409, "This account has 30 saved chats. Continue an existing chat.");
      const saved: SavedChat = { id: existing?.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1,
        title: command.chat.messages.find(item => item.role === "user")?.content.slice(0, 80) ?? "Conversation",
        updatedAt: new Date().toISOString(), chat: command.chat };
      vault.write(key(workspace, actor), [...records.filter(item => item.id !== saved.id), saved]);
      return structuredClone(saved);
    },
  };
}
