import { z } from "zod";
import type { ChatMessage, ChatModelOption } from "./chat.js";

export const routingTasks = ["quick", "general", "code", "analysis"] as const;
export type RoutingTask = typeof routingTasks[number];
export const routeModelSchema = z.object({
  id: z.string().min(1).max(200), tasks: z.array(z.enum(routingTasks)).min(1).max(4),
  strength: z.enum(["efficient", "balanced", "capable"]).default("balanced"),
  priority: z.number().int().min(0).max(100), maxOutputTokens: z.number().int().min(128).max(8192),
}).strict();
const allowanceSchema = z.object({
  models: z.array(routeModelSchema).min(1).max(50),
  dailyTokens: z.number().int().min(1024).max(100_000_000),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.models.map(model => model.id)).size !== plan.models.length) ctx.addIssue({ code: "custom", path: ["models"], message: "Model ids must be unique." });
});
export const chatPlanSchema = z.object({
  models: z.array(routeModelSchema).min(1).max(50),
  dailyTokens: z.number().int().min(1024).max(100_000_000),
  max: allowanceSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.models.map(model => model.id)).size !== plan.models.length) ctx.addIssue({ code: "custom", path: ["models"], message: "Model ids must be unique." });
  if (plan.max && plan.max.dailyTokens < plan.dailyTokens) ctx.addIssue({ code: "custom", path: ["max", "dailyTokens"], message: "Max allowance must be at least the Pro allowance." });
});
export type ChatPlan = z.infer<typeof chatPlanSchema>;
export interface ChatRoute { model: string; task: RoutingTask; maxOutputTokens: number; reason: string }

export function taskFor(messages: ChatMessage[]): RoutingTask {
  const question = messages.at(-1)?.content ?? "";
  if (/```|\b(debug|code|typescript|javascript|python|sql|function|unit tests?|refactor)\b/i.test(question)) return "code";
  if (question.length > 1800 || /\b(analy[sz]e|compare|trade.?offs?|architecture|investigate|detailed)\b/i.test(question)) return "analysis";
  if (question.length < 180 && messages.length <= 3) return "quick";
  return "general";
}

export function decideChatRoute(messages: ChatMessage[], choices: ChatModelOption[], rules: ChatPlan["models"], preference: "economy" | "balanced" | "quality" = "balanced"): ChatRoute {
  const task = taskFor(messages);
  const eligible = rules.filter(rule => choices.some(choice => choice.id === rule.id && choice.available && choice.outputLimit));
  const matching = eligible.filter(rule => rule.tasks.includes(task));
  const candidates = matching.length ? matching : eligible.filter(rule => rule.tasks.includes("general"));
  const ranks = preference === "economy" ? { efficient: 0, balanced: 1, capable: 2 }
    : preference === "quality" ? { capable: 0, balanced: 1, efficient: 2 } : { balanced: 0, efficient: 1, capable: 2 };
  const selected = [...candidates].sort((a, b) => ranks[a.strength] - ranks[b.strength] || a.priority - b.priority || a.id.localeCompare(b.id))[0];
  if (!selected) throw new Error("No connected managed model is configured for this task. Choose a model manually.");
  const budgets = { quick: 512, general: 1024, code: 2048, analysis: 3072 };
  return { model: selected.id, task, maxOutputTokens: Math.min(preference === "economy" ? Math.max(512, budgets[task] / 2) : preference === "quality" ? budgets[task] * 2 : budgets[task], selected.maxOutputTokens),
    reason: `${task === "quick" ? "Short question" : task === "code" ? "Coding request" : task === "analysis" ? "Detailed analysis" : "General conversation"}; ${preference} preference using configured model roles, not measured accuracy.` };
}
