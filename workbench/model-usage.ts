import { z } from "zod";

/**
 * Token accounting.
 *
 * Every model provider reports how many tokens a call consumed, each in its
 * own field names. This module reads whichever shape came back and keeps
 * one small record on the job, attempt or chat turn that made the call, so
 * the workspace can say what an assistant costs before anyone tries to
 * make it cheaper. Browser code imports the type and the formatter, so
 * there are no Node imports here.
 */

export const tokenUsageSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
}).strict();
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

const asCount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/**
 * The usage a response carries, or nothing when the provider did not say.
 * Accepts our own `{ usage }`, LangChain's `usage_metadata`, Ollama's
 * `prompt_eval_count` / `eval_count`, and the OpenAI and Anthropic `usage`
 * objects (`prompt_tokens` / `completion_tokens` or `input_tokens` / `output_tokens`).
 */
export function usageOf(response: unknown): TokenUsage | undefined {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  const candidates = [record.usage, record.usage_metadata, record];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const fields = candidate as Record<string, unknown>;
    const prompt = asCount(fields.promptTokens) ?? asCount(fields.prompt_tokens) ?? asCount(fields.input_tokens) ?? asCount(fields.prompt_eval_count);
    const completion = asCount(fields.completionTokens) ?? asCount(fields.completion_tokens) ?? asCount(fields.output_tokens) ?? asCount(fields.eval_count);
    if (prompt !== undefined || completion !== undefined) return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 };
  }
  return undefined;
}

export function addUsage(total: TokenUsage | null | undefined, more: TokenUsage | undefined): TokenUsage | null {
  if (!more) return total ?? null;
  return { promptTokens: (total?.promptTokens ?? 0) + more.promptTokens, completionTokens: (total?.completionTokens ?? 0) + more.completionTokens };
}

export function totalTokens(usage: TokenUsage | null | undefined): number {
  return usage ? usage.promptTokens + usage.completionTokens : 0;
}

/** "1.2k tokens", "980 tokens", or "" when nothing was recorded. */
export function formatTokens(usage: TokenUsage | null | undefined): string {
  const total = totalTokens(usage);
  if (!usage) return "";
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}
