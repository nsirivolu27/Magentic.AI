import { z } from "zod";
import { tokenUsageSchema } from "./model-usage.js";

export const BOT_KINDS = ["manual", "planner", "coder", "reviewer", "validator"] as const;
export const BOT_PROFILE_IDS = ["requirements", "planning", "architecture", "implementation", "validation", "review", "delivery"] as const;
export type BotProfile = typeof BOT_PROFILE_IDS[number];
export const BOT_PROFILE_KINDS = {
  requirements: "planner", planning: "planner", architecture: "planner", implementation: "coder",
  validation: "validator", review: "reviewer", delivery: "planner",
} as const;
export const BOT_REPOSITORY_TOOLS = ["list_project_files", "read_project_file", "project_diff"] as const;
export const botPolicySchema = z.object({
  kind: z.enum(BOT_KINDS), maxSteps: z.number().int().min(1).max(12),
  profile: z.enum(BOT_PROFILE_IDS).optional(),
  timeoutSeconds: z.number().int().min(15).max(300),
  allowedTools: z.array(z.enum(BOT_REPOSITORY_TOOLS)).max(3).refine(tools => new Set(tools).size === tools.length,
    "Tool names must be unique.").optional(),
  maxToolCalls: z.number().int().min(0).max(11).optional(),
}).strict().superRefine((bot, context) => {
  if (bot.profile && bot.kind !== BOT_PROFILE_KINDS[bot.profile]) {
    context.addIssue({ code: "custom", path: ["profile"], message: `${bot.profile} requires the ${BOT_PROFILE_KINDS[bot.profile]} bot type.` });
  }
});
export const DEFAULT_BOT_POLICY = { kind: "manual", maxSteps: 6, timeoutSeconds: 120 } as const;
export const checkSchema = z.object({
  executable: z.string().trim().min(1).max(500), args: z.array(z.string().max(500)).max(20),
}).strict();
export const projectSchema = z.object({
  root: z.string().min(1).max(1000), checks: z.array(checkSchema).max(5),
}).strict();
export const changeSchema = z.object({
  path: z.string().min(1).max(250), before: z.string().max(30_000).nullable(), after: z.string().max(30_000),
}).strict();
export const botHandoffSchema = z.object({
  sections: z.array(z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(400) }).strict()).length(4),
  blockers: z.array(z.string().trim().min(1).max(200)).max(4),
}).strict();
export type BotHandoff = z.infer<typeof botHandoffSchema>;
export const revisionSourceSchema = z.object({
  attemptId: z.string().uuid(),
  expectedHash: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
  feedback: z.string().trim().min(1).max(2000),
}).strict();
export const attemptSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid(), runId: z.string().uuid(), stageId: z.string(),
  revision: z.number().int().min(1), actor: z.string(), bot: botPolicySchema, model: z.string(),
  /** The approved assistant that did this work, recorded at start so the timeline says which unit acted. */
  assistant: z.object({ id: z.string(), name: z.string(), release: z.string(), instructions: z.string() }).strict().optional(),
  checkout: z.string(), baseCommit: z.string(), startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  status: z.enum(["running", "ready", "applying", "applied", "accepted", "failed", "cancelled", "interrupted", "superseded"]),
  summary: z.string().max(4000), error: z.string(), calls: z.number().int().min(0),
  handoff: botHandoffSchema.optional(),
  revisionSource: revisionSourceSchema.optional(),
  /** Summed over the attempt's model calls; null when no provider reported counts. */
  tokenUsage: tokenUsageSchema.nullable(), cost: z.null(),
  events: z.array(z.object({ at: z.string(), message: z.string() }).strict()).max(50),
  changes: z.array(changeSchema).max(5), proposalHash: z.string(),
  checks: z.array(z.object({ command: checkSchema, exitCode: z.number().int().nullable(), output: z.string(), passed: z.boolean() }).strict()).max(5),
  checkedTree: z.string(),
}).strict();
export type BotPolicy = z.infer<typeof botPolicySchema>;
// Older saved phases used all three read tools. Keeping that default preserves
// their behavior; an explicit empty list means no repository access.
export function effectiveToolPolicy(bot: BotPolicy) {
  const allowedTools = bot.kind === "manual" ? [] : [...(bot.allowedTools ?? BOT_REPOSITORY_TOOLS)];
  return { allowedTools, maxToolCalls: allowedTools.length ? Math.min(bot.maxToolCalls ?? bot.maxSteps - 1, bot.maxSteps - 1) : 0 };
}
export type BotAttempt = z.infer<typeof attemptSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Change = z.infer<typeof changeSchema>;
export interface BotSnapshot { project: Project | null; attempts: BotAttempt[]; busy: boolean }
export const botCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("attach"), project: projectSchema }).strict(),
  z.object({ action: z.literal("start"), runId: z.string().uuid(), expectedRevision: z.number().int().min(1), requestId: z.string().uuid(),
    revisionSource: revisionSourceSchema.optional() }).strict(),
  z.object({ action: z.enum(["apply", "checks", "accept", "cancel"]), attemptId: z.string().uuid(), expectedHash: z.string() }).strict(),
]);

export const BOT_DESCRIPTIONS: Record<typeof BOT_KINDS[number], string> = {
  manual: "Record the work yourself.",
  planner: "Inspect the repository and produce a plan and acceptance criteria.",
  coder: "Inspect the repository and propose file changes for your review.",
  reviewer: "Inspect the implementation and report findings without editing files.",
  validator: "Inspect acceptance evidence; configured checks run only when you request them.",
};
