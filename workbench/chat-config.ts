import { z } from "zod";
import { llmConfigFromEnv } from "../llm/provider.js";
import { setting } from "../env.js";
import type { ChatConfiguration } from "./chat.js";

import { withCloudModels } from "./model-catalog.js";
import { ollamaRequest } from "./ollama-request.js";
import { usageOf } from "./model-usage.js";

const modelListSchema = z.object({ models: z.array(z.object({ name: z.string().min(1).max(200) })).max(500) });
const ollamaAnswer = z.object({ message: z.object({ content: z.string().min(1) }), done: z.literal(true) });

function selectedDefault(catalog: ChatConfiguration, provider: string, model: string): ChatConfiguration {
  return { ...catalog, provider, model, loadModel: (name = model, limits) => catalog.loadModel(name, limits) };
}

/** Workbench chat does not require the relay's optional LangChain adapters. */
export function chatConfiguration(localDemo = false, options: { env?: NodeJS.ProcessEnv; request?: typeof fetch } = {}): ChatConfiguration | undefined {
  const env = options.env ?? process.env;
  const config = llmConfigFromEnv(env) ?? (localDemo ? llmConfigFromEnv({
    MAGENTIC_LLM_PROVIDER: "ollama", MAGENTIC_LLM_CHAT_MODEL: "qwen2.5-coder:7b",
    MAGENTIC_LLM_BASE_URL: "http://127.0.0.1:11434",
  }) : undefined);
  const empty: ChatConfiguration = { provider: "unconfigured", model: "", listModels: async () => [],
    loadModel: async () => { throw new Error("Choose a connected model."); } };
  if (!config) {
    // API-only installations must not need a pretend Ollama configuration.
    const configured = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
      "AZURE_OPENAI_API_KEY", "MAGENTIC_GATEWAY_BASE_URL"].some(key => setting(key, env)?.trim());
    return configured ? withCloudModels(empty, env, options.request) : undefined;
  }
  if (config.provider !== "ollama") {
    if (config.provider === "openai" && config.baseUrl) {
      // Preserve an explicitly configured compatible endpoint. Never redirect
      // its prompts or credential to OpenAI's public API as a fallback.
      const catalog = withCloudModels(empty, { ...env,
        MAGENTIC_GATEWAY_BASE_URL: config.baseUrl,
        MAGENTIC_GATEWAY_MODELS: config.chatModel,
        MAGENTIC_GATEWAY_API_KEY: setting("OPENAI_API_KEY", env) ?? "",
      }, options.request);
      return selectedDefault(catalog, "gateway", `gateway/${config.chatModel}`);
    }
    const provider = config.provider;
    const namesKey = provider === "azure" ? "AZURE_OPENAI_DEPLOYMENTS" : `MAGENTIC_${provider.toUpperCase()}_MODELS`;
    const names = (setting(namesKey, env) ?? "").split(",").map(name => name.trim()).filter(Boolean);
    const catalog = withCloudModels(empty, { ...env, [namesKey]: [...new Set([...names, config.chatModel])].join(",") }, options.request);
    return selectedDefault(catalog, provider, `${provider}/${config.chatModel}`);
  }
  const baseUrl = config.baseUrl ?? "http://127.0.0.1:11434";
  const base: ChatConfiguration = {
    provider: "ollama", model: config.chatModel, outputLimit: true,
    async listModels() {
      const response = await (options.request ?? fetch)(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(8_000), redirect: "error" });
      if (!response.ok) throw new Error("Ollama model list is unavailable.");
      const data = modelListSchema.parse(await response.json());
      return [...new Set(data.models.map((model) => model.name))].sort();
    },
    async loadModel(name = config.chatModel, limits) {
      return { async invoke(prompt, invocation) {
        const deadline = AbortSignal.timeout(900_000);
        const signal = invocation?.signal ? AbortSignal.any([invocation.signal, deadline]) : deadline;
        signal.throwIfAborted();
        const response = await (options.request ?? ollamaRequest(signal))(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal, redirect: "error",
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: prompt }], stream: false,
            format: invocation?.format ?? "json", keep_alive: "1m",
            options: { temperature: 0, num_predict: limits?.maxOutputTokens ?? 512, num_thread: 4 } }),
        });
        if (!response.ok) throw new Error("Ollama rejected the model request. Check the selected installed model.");
        const data: unknown = await response.json();
        const answer = ollamaAnswer.parse(data);
        const usage = usageOf(data);
        return { content: answer.message.content, ...(usage ? { usage } : {}) };
      } };
    },
  };
  return withCloudModels(base, env, options.request);
}
