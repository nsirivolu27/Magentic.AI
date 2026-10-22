import { createChatHistory } from "./chat-history.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { setting } from "../env.js";
import type { ChatConfiguration, ChatModelOption, AgentModel } from "./chat.js";
import { chatRequestSchema } from "./chat.js";
import { cloudModel } from "./model-catalog.js";
import { createChatConnections, providerLabels } from "./chat-connections.js";
import { chatPlanSchema, decideChatRoute, type ChatPlan, type ChatRoute } from "./chat-routing.js";
import { usageOf } from "./model-usage.js";
import type { ChatVault } from "./chat-vault.js";

export class ChatAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function loadChatPlan(): ChatPlan | undefined {
  const path = setting("MAGENTIC_CHAT_PLAN_FILE")?.trim();
  if (!path) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("MAGENTIC_CHAT_PLAN_FILE must name a readable JSON file."); }
  const parsed = chatPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`MAGENTIC_CHAT_PLAN_FILE: ${parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  return parsed.data;
}
export interface ChatAccessSummary {
  tier: "free" | "paid"; plan?: "free" | "pro" | "max"; auto: boolean; managedReady: boolean;
  connections: { provider: string; models: string[]; connectedAt: string }[];
  dailyTokens?: number; accountedTokens: number; budgetDate: string;
  mcp: { active: boolean; expiresAt?: string };
}
const usageRecord = z.object({ date: z.string(), tokens: z.number().int().nonnegative() });
const grantSchema = z.object({ workspace: z.string(), actor: z.string(), expiresAt: z.number(), hash: z.string() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createChatAccess(options: {
  vault: ChatVault; base: ChatConfiguration; managedLogin: boolean;
  plan?: ChatPlan | undefined; entitled: (workspace: string) => Promise<boolean | "free" | "pro" | "max">; request?: typeof fetch; now?: () => number;
}) {
  const { vault, base } = options;
  const connections = createChatConnections(vault, options.request);
  const now = options.now ?? Date.now;
  const date = () => new Date(now()).toISOString().slice(0, 10);
  const usageKey = (workspace: string) => JSON.stringify(["usage", workspace]);
  const accessKey = (workspace: string, actor: string) => JSON.stringify(["mcp-access", workspace, actor]);
  const active = new Set<string>();
  function usage(workspace: string) {
    const value = usageRecord.parse(vault.read(usageKey(workspace)) ?? { date: date(), tokens: 0 });
    return value.date === date() ? value : { date: date(), tokens: 0 };
  }
  async function tier(workspace: string): Promise<"free" | "pro" | "max"> {
    if (!options.managedLogin || !options.plan) return "free";
    try {
      const value = await options.entitled(workspace);
      return value === true ? "pro" : value === "pro" || value === "max" ? value : "free";
    } catch { return "free"; }
  }
  function allowance(level: "free" | "pro" | "max") {
    return level === "free" ? undefined : level === "max" ? options.plan?.max ?? options.plan : options.plan;
  }
  async function configuration(workspace: string, actor: string) {
    const level = await tier(workspace);
    const isPaid = level !== "free";
    const plan = allowance(level);
    const personal = connections.read(workspace, actor);
    const server = base.modelOptions ? await base.modelOptions() : (base.listModels ? await base.listModels() : [base.model]).map(id => ({
      id, label: id, provider: base.provider, local: base.provider === "ollama", available: true, detail: "Configured workspace model.", outputLimit: base.outputLimit === true,
    }));
    const choices: ChatModelOption[] = server.map(model => {
      const managed = (plan ?? options.plan)?.models.some(rule => rule.id === model.id);
      const locked = !model.local && options.managedLogin && (!managed || !isPaid);
      return { ...model, available: model.available && !locked,
        ...(locked ? { detail: managed ? "Paid model access requires an active subscription." : "This model is not in the managed plan. Connect your own API account." } : {}) };
    }).filter(model => model.local || model.available || (plan ?? options.plan)?.models.some(rule => rule.id === model.id));
    for (const connection of personal) for (const model of connection.models) choices.push({
      id: `personal/${connection.provider}/${model}`, label: model, provider: `${providerLabels[connection.provider]} · your account`,
      available: true, local: false, outputLimit: true, detail: "API account verified. The provider bills your usage; inference access still depends on the selected model.",
    });
    const config: ChatConfiguration = {
      provider: base.provider, model: base.model, modelOptions: async () => choices,
      listModels: async () => choices.filter(model => model.available).map(model => model.id),
      async loadModel(id = base.model, limits) {
        const choice = choices.find(model => model.id === id);
        if (!choice?.available) throw new ChatAccessError(403, "This model is not available for your account.");
        if (id.startsWith("personal/")) {
          // Read again so disconnecting a provider invalidates an already prepared request.
          const current = connections.read(workspace, actor).find(connection => id.startsWith(`personal/${connection.provider}/`));
          const model = current ? id.slice(`personal/${current.provider}/`.length) : "";
          if (!current?.models.includes(model)) throw new ChatAccessError(403, "This provider connection was removed. Refresh models.");
          return cloudModel(current.provider, model, current.apiKey, options.request ?? fetch, undefined, undefined, limits?.maxOutputTokens);
        }
        const managed = !choice.local && options.managedLogin;
        const currentPlan = allowance(await tier(workspace));
        const rule = currentPlan?.models.find(rule => rule.id === id);
        if (managed && !rule) throw new ChatAccessError(403, "Paid model access could not be verified.");
        const cap = managed ? Math.min(limits?.maxOutputTokens ?? rule!.maxOutputTokens, rule!.maxOutputTokens) : limits?.maxOutputTokens;
        const model = await base.loadModel(id, cap === undefined ? undefined : { maxOutputTokens: cap });
        if (!managed) return model;
        return {
          async invoke(prompt, invocation) {
            const currentPlan = allowance(await tier(workspace));
            const rule = currentPlan?.models.find(rule => rule.id === id);
            // A prepared request cannot retain Max access after a downgrade.
            if (!rule || cap! > rule.maxOutputTokens) throw new ChatAccessError(403, "Paid model access could not be verified. Refresh after a plan change.");
            const current = usage(workspace);
            // Reserve before the provider call. Failed or unmetered calls retain their
            // reservation, so errors and restarts cannot replenish an allowance.
            const reserved = Buffer.byteLength(prompt, "utf8") + cap! + 256;
            if (current.tokens + reserved > currentPlan!.dailyTokens) throw new ChatAccessError(429, "The workspace's daily managed token allowance is reached. Use your own connection or try tomorrow.");
            vault.write(usageKey(workspace), { date: current.date, tokens: current.tokens + reserved });
            const answer = await model.invoke(prompt, invocation);
            const reported = usageOf(answer);
            if (reported) {
              const latest = usage(workspace);
              if (latest.date === current.date) vault.write(usageKey(workspace), { date: latest.date, tokens: Math.max(0, latest.tokens - reserved) + reported.promptTokens + reported.completionTokens });
            }
            return answer;
          },
        } satisfies AgentModel;
      },
    };
    return config;
  }
  return {
    configuration,
    history: createChatHistory(vault),
    async summary(workspace: string, actor: string): Promise<ChatAccessSummary> {
      const level = await tier(workspace);
      const isPaid = level !== "free";
      const plan = allowance(level);
      const record = vault.read(accessKey(workspace, actor));
      const grant = record ? grantSchema.parse(record) : undefined;
      const current = usage(workspace);
      return { tier: isPaid ? "paid" : "free", plan: level, auto: isPaid, managedReady: !!options.plan && options.managedLogin,
        connections: connections.list(workspace, actor), ...(plan ? { dailyTokens: plan.dailyTokens } : {}),
        accountedTokens: current.tokens, budgetDate: current.date,
        mcp: { active: !!grant && grant.expiresAt > now(), ...(grant ? { expiresAt: new Date(grant.expiresAt).toISOString() } : {}) } };
    },
    async connect(workspace: string, actor: string, raw: unknown) {
      try { await connections.execute(workspace, actor, raw); }
      catch (error) { throw new ChatAccessError(400, error instanceof z.ZodError ? "Check the provider, API key and model IDs." : error instanceof Error ? error.message : "Connection update failed."); }
    },
    async prepare(workspace: string, actor: string, input: z.infer<typeof chatRequestSchema>) {
      const config = await configuration(workspace, actor);
      const choices = await config.modelOptions!();
      const plan = allowance(await tier(workspace));
      let route: ChatRoute | undefined;
      if (input.routing === "auto") {
        if (input.profile) throw new ChatAccessError(400, "Auto cannot replace an approved assistant's model selection.");
        if (!plan) throw new ChatAccessError(403, "Auto requires verified paid access and a managed model plan.");
        try { route = decideChatRoute(input.messages, choices, plan.models, input.preference); }
        catch (error) { throw new ChatAccessError(503, (error as Error).message); }
      }
      const model = route?.model ?? input.model ?? config.model;
      const rule = plan?.models.find(item => item.id === model);
      const managed = options.managedLogin && !choices.find(item => item.id === model)?.local && !model.startsWith("personal/");
      const maxOutputTokens = route?.maxOutputTokens ?? (managed && rule ? Math.min(input.maxOutputTokens ?? rule.maxOutputTokens, rule.maxOutputTokens) : input.maxOutputTokens);
      return { config, model, maxOutputTokens, route };
    },
    acquire(workspace: string, actor: string) {
      const key = JSON.stringify([workspace, actor]);
      if (active.has(key) || active.size >= 4) throw new ChatAccessError(429, "A chat is already running. Wait or stop it before trying again.");
      active.add(key);
      return () => { active.delete(key); };
    },
    issueToken(workspace: string, actor: string) {
      const token = "mchat_" + randomBytes(32).toString("hex");
      const grant = { workspace, actor, hash: hash(token), expiresAt: now() + 7 * 86_400_000 };
      vault.write(JSON.stringify(["mcp-token", grant.hash]), grant);
      vault.write(accessKey(workspace, actor), grant);
      return { token, expiresAt: new Date(grant.expiresAt).toISOString() };
    },
    revokeToken(workspace: string, actor: string) { vault.write(accessKey(workspace, actor), null); },
    authenticateToken(token: string) {
      if (!/^mchat_[a-f0-9]{64}$/.test(token)) return undefined;
      const record = vault.read(JSON.stringify(["mcp-token", hash(token)]));
      if (!record) return undefined;
      const grant = grantSchema.parse(record);
      const current = vault.read(accessKey(grant.workspace, grant.actor));
      if (!current || grantSchema.parse(current).hash !== grant.hash || grant.expiresAt <= now()) return undefined;
      return { workspaceId: grant.workspace, actor: grant.actor };
    },
  };
}
export type ChatAccess = ReturnType<typeof createChatAccess>;
