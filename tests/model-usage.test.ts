import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, formatTokens, usageOf } from "../workbench/model-usage.js";
import { gatewayCompletionsUrl, gatewayProblem, withCloudModels } from "../workbench/model-catalog.js";
import { editorOllamaModel } from "../workbench/editor-session.js";
import type { ChatConfiguration } from "../workbench/chat.js";

/**
 * Token accounting reads whatever a provider reported and keeps one small
 * record per call; a gateway is any OpenAI compatible endpoint the person
 * configured on the server, on this machine over http or anywhere over https.
 */

test("usage is read from every provider shape and summed", () => {
  assert.deepEqual(usageOf({ content: "x", usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }), { promptTokens: 10, completionTokens: 5 });
  assert.deepEqual(usageOf({ message: { content: "x" }, prompt_eval_count: 7, eval_count: 3 }), { promptTokens: 7, completionTokens: 3 });
  assert.deepEqual(usageOf({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { promptTokens: 100, completionTokens: 20 });
  assert.deepEqual(usageOf({ content: [], usage: { input_tokens: 4, output_tokens: 1 } }), { promptTokens: 4, completionTokens: 1 });
  assert.deepEqual(usageOf({ content: "x", usage: { promptTokens: 2, completionTokens: 2 } }), { promptTokens: 2, completionTokens: 2 });
  assert.equal(usageOf({ content: "no counts here" }), undefined);
  assert.equal(usageOf({ usage: { prompt_tokens: -1, completion_tokens: "many" } }), undefined);
  assert.equal(usageOf("text"), undefined);
  assert.deepEqual(addUsage(null, { promptTokens: 1, completionTokens: 2 }), { promptTokens: 1, completionTokens: 2 });
  assert.deepEqual(addUsage({ promptTokens: 1, completionTokens: 2 }, { promptTokens: 10, completionTokens: 20 }), { promptTokens: 11, completionTokens: 22 });
  assert.equal(addUsage(null, undefined), null);
  assert.equal(formatTokens(null), "");
  assert.equal(formatTokens({ promptTokens: 900, completionTokens: 80 }), "980 tokens");
  assert.equal(formatTokens({ promptTokens: 1200, completionTokens: 300 }), "1.5k tokens");
  assert.equal(formatTokens({ promptTokens: 2_000_000, completionTokens: 0 }), "2.0M tokens");
});

test("the editor's local model reports Ollama's counts and only ever calls a loopback address", async () => {
  const fake = (async () => new Response(JSON.stringify({ message: { content: "{}" }, prompt_eval_count: 12, eval_count: 6 }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await editorOllamaModel("fixture", fake).invoke("hi"), { content: "{}", usage: { promptTokens: 12, completionTokens: 6 } });
  let called = "";
  const spy = (async (url: unknown) => { called = String(url); return new Response(JSON.stringify({ message: { content: "{}" } }), { status: 200 }); }) as typeof fetch;
  await editorOllamaModel("fixture", spy, "http://localhost:8787/").invoke("hi");
  assert.equal(called, "http://localhost:8787/api/chat");
  assert.throws(() => editorOllamaModel("fixture", spy, "http://example.com:11434"), /loopback/);
  assert.throws(() => editorOllamaModel("fixture", spy, "not a url"), /modelUrl/);
});

test("a gateway needs an https or loopback address and a model list, then answers in the chat completions shape with usage", async () => {
  assert.match(gatewayProblem(""), /MAGENTIC_GATEWAY_BASE_URL/);
  assert.match(gatewayProblem("http://gateway.example.com"), /https, or http on this machine/);
  assert.equal(gatewayProblem("http://127.0.0.1:20128"), "");
  assert.equal(gatewayProblem("https://router.example.com/v1"), "");
  assert.equal(gatewayCompletionsUrl("http://127.0.0.1:20128"), "http://127.0.0.1:20128/v1/chat/completions");
  assert.equal(gatewayCompletionsUrl("https://router.example.com/v1/"), "https://router.example.com/v1/chat/completions");

  const base: ChatConfiguration = { provider: "ollama", model: "local", listModels: async () => ["local"], loadModel: async () => ({ invoke: async () => ({ content: "local" }) }) };
  // Not configured: listed so the person knows it exists, refused when chosen.
  const unset = withCloudModels(base, {});
  const listed = (await unset.modelOptions!()).filter((option) => option.id.startsWith("gateway/"));
  assert.equal(listed.length, 1); assert.equal(listed[0]!.available, false); assert.match(listed[0]!.detail, /MAGENTIC_GATEWAY_BASE_URL/);
  await assert.rejects(unset.loadModel("gateway/anything"), /MAGENTIC_GATEWAY_BASE_URL/);
  // A plain http address on another host is refused even with models named.
  const remote = withCloudModels(base, { MAGENTIC_GATEWAY_BASE_URL: "http://10.0.0.5:20128", MAGENTIC_GATEWAY_MODELS: "a" });
  await assert.rejects(remote.loadModel("gateway/a"), /https, or http on this machine/);
  // Configured: the request goes to the gateway with the key only when one is set.
  let url = ""; let headers: Record<string, string> = {}; let body: Record<string, unknown> = {};
  const request = (async (target: unknown, init?: RequestInit) => {
    url = String(target); headers = init?.headers as Record<string, string>; body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"type\":\"answer\"}" } }], usage: { prompt_tokens: 30, completion_tokens: 9 } }), { status: 200 });
  }) as typeof fetch;
  const config = withCloudModels(base, { MAGENTIC_GATEWAY_BASE_URL: "http://127.0.0.1:20128", MAGENTIC_GATEWAY_MODELS: "deepseek/deepseek-chat, glm-4" }, request);
  const options = (await config.modelOptions!()).filter((option) => option.id.startsWith("gateway/"));
  assert.deepEqual(options.map((option) => [option.id, option.available, option.detail]), [
    ["gateway/deepseek/deepseek-chat", true, "Served by 127.0.0.1:20128."], ["gateway/glm-4", true, "Served by 127.0.0.1:20128."],
  ]);
  const model = await config.loadModel("gateway/deepseek/deepseek-chat");
  const answer = await model.invoke("hello");
  assert.deepEqual(answer, { content: "{\"type\":\"answer\"}", usage: { promptTokens: 30, completionTokens: 9 } });
  assert.equal(url, "http://127.0.0.1:20128/v1/chat/completions");
  assert.equal(headers.Authorization, undefined);
  assert.equal(body.model, "deepseek/deepseek-chat");
  const keyed = withCloudModels(base, { MAGENTIC_GATEWAY_BASE_URL: "https://router.example.com", MAGENTIC_GATEWAY_MODELS: "m", MAGENTIC_GATEWAY_API_KEY: "gw-secret" }, request);
  await (await keyed.loadModel("gateway/m")).invoke("hello");
  assert.equal(headers.Authorization, "Bearer gw-secret");
  assert.equal(url, "https://router.example.com/v1/chat/completions");
});
