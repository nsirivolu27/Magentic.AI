import { z } from "zod";
import { llmConfigFromEnv, loadChatModel } from "../llm/provider.js";
import type { AgentModel, ChatConfiguration } from "./chat.js";

import { withCloudModels } from "./model-catalog.js";
import { ollamaRequest } from "./ollama-request.js";

const modelListSchema = z.object({ models: z.array(z.object({ name: z.string().min(1).max(200) })).max(500) });

export function chatConfiguration(localDemo = false): ChatConfiguration | undefined {
  const base = localConfiguration(localDemo);
  return base ? withCloudModels(base) : undefined;
}

function localConfiguration(localDemo: boolean): ChatConfiguration | undefined {
  const config = llmConfigFromEnv() ?? (localDemo ? llmConfigFromEnv({
    MAGENTIC_LLM_PROVIDER: "ollama", MAGENTIC_LLM_CHAT_MODEL: "qwen2.5-coder:7b",
    MAGENTIC_LLM_BASE_URL: "http://127.0.0.1:11434",
  }) : undefined);
  if (!config) return undefined;
  if (config.provider !== "ollama") return { provider: config.provider, model: config.chatModel, loadModel: () => loadChatModel(config) };
  const baseUrl = config.baseUrl ?? "http://127.0.0.1:11434";
  return {
    provider: "ollama", model: config.chatModel, outputLimit: true,
    async listModels() {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(8_000), redirect: "error" });
      if (!response.ok) throw new Error("Ollama model list is unavailable.");
      const data = modelListSchema.parse(await response.json());
      return [...new Set(data.models.map((model) => model.name))].sort();
    },
    async loadModel(name = config.chatModel, options) {
      // A separate instance keeps one chat's selection and output limit from
      // changing the model used by the relay's existing retrieval tools.
      const specifier = "@langchain/ollama";
      const module = await import(specifier) as Record<string, unknown>;
      if (typeof module.ChatOllama !== "function") throw new Error("The Ollama integration is unavailable.");
      const ChatOllama = module.ChatOllama as new (options: Record<string, unknown>) => AgentModel;
      return { async invoke(prompt, invocation) {
        const signal = invocation?.signal ?? AbortSignal.timeout(900_000);
        signal.throwIfAborted();
        const request = ollamaRequest(signal);
        const model = new ChatOllama({ model: name, baseUrl, temperature: 0, format: "json", numPredict: options?.maxOutputTokens ?? 512, numThread: 4, keepAlive: "1m", checkOrPullModel: false, fetch: request });
        return model.invoke(prompt, invocation);
      } };
    },
  };
}
