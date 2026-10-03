import { z } from "zod";
import { setting } from "../env.js";
import type { AgentModel, ChatConfiguration, ChatModelOption } from "./chat.js";
import { usageOf } from "./model-usage.js";

type CloudProvider = "openai" | "anthropic" | "google" | "azure" | "gateway";
const providers = {
  openai: { label: "OpenAI", key: "OPENAI_API_KEY", models: [
    ["gpt-6-astra", "GPT-6 Astra"], ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"], ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ] },
  anthropic: { label: "Anthropic · Claude", key: "ANTHROPIC_API_KEY", models: [
    ["claude-fable-5-1", "Claude Fable 5.1"], ["claude-opus-5", "Claude Opus 5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
  ] },
  google: { label: "Google · Gemini", key: "GEMINI_API_KEY", models: [
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ] },
  // Azure has no fixed model list: you deploy a model under a name you
  // choose, and that deployment name is what the API takes. The options are
  // therefore read from settings rather than hardcoded here.
  azure: { label: "Azure · OpenAI", key: "AZURE_OPENAI_API_KEY", models: [] },
  // A gateway is any OpenAI compatible endpoint the person runs or rents:
  // a local router such as OmniRoute, a compression proxy, or a hosted
  // service. Its address and model names come from settings, and a key is
  // optional because a local gateway usually has none.
  gateway: { label: "Gateway · OpenAI compatible", key: "MAGENTIC_GATEWAY_BASE_URL", models: [] },
} as const;

/**
 * Where a gateway may live: this machine over plain http, or anywhere over
 * https. Server credentials never travel over plain http to another host.
 * Returns the reason it cannot be used, or "" when it can.
 */
export function gatewayProblem(baseUrl: string): string {
  if (!baseUrl) return "Set MAGENTIC_GATEWAY_BASE_URL on the server and restart to connect a gateway.";
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return "MAGENTIC_GATEWAY_BASE_URL is not a valid URL."; }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "https:") return "";
  if (parsed.protocol === "http:" && loopback) return "";
  return "MAGENTIC_GATEWAY_BASE_URL must be https, or http on this machine (127.0.0.1).";
}

/** The chat completions URL under a gateway base, whether or not the base already ends in /v1. */
export function gatewayCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`}/chat/completions`;
}

function gatewaySetup(env?: NodeJS.ProcessEnv) {
  const baseUrl = setting("MAGENTIC_GATEWAY_BASE_URL", env)?.trim() ?? "";
  const key = setting("MAGENTIC_GATEWAY_API_KEY", env)?.trim() ?? "";
  const models = (setting("MAGENTIC_GATEWAY_MODELS", env) ?? "").split(",").map((name) => name.trim()).filter(Boolean).slice(0, 50);
  return { baseUrl, key, models, problem: gatewayProblem(baseUrl) };
}

/** Azure needs a resource and at least one deployment as well as a key. */
function azureSetup(env?: NodeJS.ProcessEnv) {
  const instance = setting("AZURE_OPENAI_INSTANCE", env)?.trim() ?? "";
  const apiVersion = setting("AZURE_OPENAI_API_VERSION", env)?.trim() || "2024-10-21";
  const declared = setting("AZURE_OPENAI_DEPLOYMENTS", env)?.trim()
    || setting("AZURE_OPENAI_DEPLOYMENT", env)?.trim() || "";
  const deployments = declared.split(",").map((name) => name.trim()).filter(Boolean).slice(0, 20);
  return { instance, apiVersion, deployments };
}

const textBlock = z.object({ type: z.string(), text: z.string().optional() });
const openaiResponse = z.object({ output: z.array(z.object({ type: z.string(), content: z.array(textBlock).optional() })) });
const claudeResponse = z.object({ content: z.array(textBlock) });
const geminiResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) });

function cloudModel(
  provider: CloudProvider, model: string, key: string, request: typeof fetch,
  azure?: { instance: string; apiVersion: string }, gateway?: { baseUrl: string },
): AgentModel {
  return {
    async invoke(prompt, options) {
      let url: string;
      let headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: Record<string, unknown>;
      if (provider === "openai") {
        url = "https://api.openai.com/v1/responses";
        headers.Authorization = `Bearer ${key}`;
        body = { model, input: prompt, store: false, max_output_tokens: 4096, text: { format: { type: "json_object" } } };
      } else if (provider === "anthropic") {
        url = "https://api.anthropic.com/v1/messages";
        headers = { ...headers, "x-api-key": key, "anthropic-version": "2023-06-01" };
        body = { model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] };
      } else if (provider === "azure") {
        // The deployment name is part of the path, and the key is a header
        // rather than a bearer token. The instance is fixed at configuration
        // time, so a model choice cannot redirect the credential elsewhere.
        url = `https://${azure!.instance}.openai.azure.com/openai/deployments/${encodeURIComponent(model)}`
          + `/chat/completions?api-version=${encodeURIComponent(azure!.apiVersion)}`;
        headers = { ...headers, "api-key": key };
        body = { max_tokens: 4096, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
      } else if (provider === "gateway") {
        // The address was checked at configuration time (gatewayProblem), so a
        // model choice in the browser cannot point the request elsewhere.
        url = gatewayCompletionsUrl(gateway!.baseUrl);
        if (key) headers.Authorization = `Bearer ${key}`;
        body = { model, max_tokens: 4096, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
      } else {
        url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        headers.Authorization = `Bearer ${key}`;
        body = { model, max_tokens: 4096, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
      }
      // Fixed endpoints and rejected redirects keep a browser's model choice
      // from sending server credentials to a caller-controlled address.
      const response = await request(url, { method: "POST", headers, body: JSON.stringify(body),
        signal: options?.signal ?? AbortSignal.timeout(120_000), redirect: "error" });
      if (!response.ok) throw new Error("The model provider rejected the request.");
      const data: unknown = await response.json();
      let content: string;
      if (provider === "openai") content = openaiResponse.parse(data).output
        .filter((item) => item.type === "message").flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
      else if (provider === "anthropic") content = claudeResponse.parse(data).content
        .filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
      // Azure, Gemini and any gateway answer in the OpenAI chat-completions shape.
      else content = geminiResponse.parse(data).choices[0]?.message.content ?? "";
      if (!content) throw new Error("The model returned no text.");
      const usage = usageOf(data);
      return { content, ...(usage ? { usage } : {}) };
    },
  };
}

export function withCloudModels(base: ChatConfiguration, env?: NodeJS.ProcessEnv, request: typeof fetch = fetch): ChatConfiguration {
  const keys: Record<CloudProvider, string> = {
    openai: setting("OPENAI_API_KEY", env)?.trim() ?? "",
    anthropic: setting("ANTHROPIC_API_KEY", env)?.trim() ?? "",
    google: (setting("GEMINI_API_KEY", env) || setting("GOOGLE_API_KEY", env))?.trim() ?? "",
    azure: setting("AZURE_OPENAI_API_KEY", env)?.trim() ?? "",
    gateway: setting("MAGENTIC_GATEWAY_API_KEY", env)?.trim() ?? "",
  };
  const azure = azureSetup(env);
  const gateway = gatewaySetup(env);
  const cloud: ChatModelOption[] = [];
  for (const provider of Object.keys(providers) as CloudProvider[]) {
    const config = providers[provider];
    if (provider === "azure") {
      // Availability needs all three. A key with no resource or deployment
      // cannot reach anything, and saying so beats a request that 404s.
      const ready = Boolean(keys.azure && azure.instance && azure.deployments.length);
      const missing = [
        keys.azure ? undefined : "AZURE_OPENAI_API_KEY",
        azure.instance ? undefined : "AZURE_OPENAI_INSTANCE",
        azure.deployments.length ? undefined : "AZURE_OPENAI_DEPLOYMENTS",
      ].filter(Boolean);
      const names = azure.deployments.length ? azure.deployments : ["deployment"];
      for (const name of names) cloud.push({
        id: `azure/${name}`, label: name, provider: config.label, available: ready, local: false,
        detail: ready
          ? `Deployment on ${azure.instance}.openai.azure.com · account model access still applies.`
          : `Set ${missing.join(", ")} on the server and restart to connect this provider.`,
      });
      continue;
    }
    if (provider === "gateway") {
      const ready = !gateway.problem && gateway.models.length > 0;
      const detail = gateway.problem || (gateway.models.length ? `Served by ${new URL(gateway.baseUrl).host}.` : "Set MAGENTIC_GATEWAY_MODELS (comma separated) on the server and restart.");
      for (const name of gateway.models.length ? gateway.models : ["model"]) cloud.push({
        id: `gateway/${name}`, label: name, provider: config.label, available: ready, local: false, detail,
      });
      continue;
    }
    for (const [model, label] of config.models) cloud.push({
      id: `${provider}/${model}`, label, provider: config.label, available: Boolean(keys[provider]),
      local: false, detail: keys[provider] ? "API key configured · account model access still applies."
        : `Set ${config.key} on the server and restart to connect this provider.`,
    });
  }
  async function modelOptions(): Promise<ChatModelOption[]> {
    let local: ChatModelOption[];
    try {
      const names = base.listModels ? await base.listModels() : [base.model];
      local = names.map((name) => ({ id: name, label: name, provider: base.provider === "ollama" ? "Ollama · local" : base.provider,
        local: base.provider === "ollama", available: true, detail: base.provider === "ollama" ? "Installed in Ollama." : "Configured server provider." }));
    } catch {
      // A stopped local service must not hide unrelated cloud choices.
      local = [{ id: base.model, label: base.model, provider: base.provider, local: base.provider === "ollama", available: false,
        detail: "The configured model service is unavailable. Start it and refresh models." }];
    }
    return [...local, ...cloud];
  }
  return {
    provider: base.provider, model: base.model, modelOptions,
    listModels: async () => (await modelOptions()).filter((model) => model.available).map((model) => model.id),
    async loadModel(id = base.model) {
      const option = cloud.find((model) => model.id === id);
      if (!option) {
        // An id naming a cloud provider that is not among the options is a
        // configuration the server does not have. Falling through to the
        // local model would quietly run a different model than the one that
        // was chosen, which is worse than refusing.
        const slash = id.indexOf("/");
        const prefix = slash === -1 ? "" : id.slice(0, slash);
        if (prefix && prefix in providers) {
          const config = providers[prefix as CloudProvider];
          throw new Error(`${id} is not available on this server. Set ${config.key} and its provider settings, then restart.`);
        }
        return base.loadModel(id);
      }
      if (!option.available) throw new Error(option.detail);
      const slash = id.indexOf("/");
      const provider = id.slice(0, slash) as CloudProvider;
      return cloudModel(provider, id.slice(slash + 1), keys[provider], request,
        provider === "azure" ? { instance: azure.instance, apiVersion: azure.apiVersion } : undefined,
        provider === "gateway" ? { baseUrl: gateway.baseUrl } : undefined);
    },
  };
}
