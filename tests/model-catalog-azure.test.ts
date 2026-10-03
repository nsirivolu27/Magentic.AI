import assert from "node:assert/strict";
import test from "node:test";
import { withCloudModels } from "../workbench/model-catalog.js";
import type { ChatConfiguration } from "../workbench/chat.js";

const base: ChatConfiguration = {
  provider: "ollama", model: "qwen2.5-coder:7b",
  async listModels() { return ["qwen2.5-coder:7b"]; },
  async loadModel() { return { async invoke() { return { content: "{}" }; } }; },
};

const CONFIGURED = {
  AZURE_OPENAI_API_KEY: "azure-secret",
  AZURE_OPENAI_INSTANCE: "magentic",
  AZURE_OPENAI_DEPLOYMENTS: "gpt-4o-mini, gpt-4o",
};

test("azure deployments appear as options when fully configured", async () => {
  const chat = withCloudModels(base, CONFIGURED);
  const options = await chat.modelOptions!();
  const azure = options.filter((option) => option.id.startsWith("azure/"));
  assert.deepEqual(azure.map((option) => option.id), ["azure/gpt-4o-mini", "azure/gpt-4o"]);
  assert.equal(azure.every((option) => option.available), true);
  assert.match(azure[0]!.detail ?? "", /magentic\.openai\.azure\.com/);
});

test("a key with no resource or deployment is unavailable and says what is missing", async () => {
  const chat = withCloudModels(base, { AZURE_OPENAI_API_KEY: "azure-secret" });
  const azure = (await chat.modelOptions!()).filter((option) => option.id.startsWith("azure/"));
  assert.equal(azure.length, 1);
  assert.equal(azure[0]?.available, false);
  assert.match(azure[0]?.detail ?? "", /AZURE_OPENAI_INSTANCE/);
  assert.match(azure[0]?.detail ?? "", /AZURE_OPENAI_DEPLOYMENTS/);
  assert.equal(azure[0]?.detail?.includes("azure-secret"), false, "the key is never shown");
});

test("an unavailable azure model refuses to load rather than calling out", async () => {
  const chat = withCloudModels(base, {}, async () => { throw new Error("must not be called"); });
  await assert.rejects(() => chat.loadModel!("azure/gpt-4o"), /AZURE_OPENAI_API_KEY/);
});

test("an azure call goes to the deployment path with the api-key header", async () => {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const request: typeof fetch = async (url, init) => {
    seen.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  const chat = withCloudModels(base, CONFIGURED, request);
  const model = await chat.loadModel!("azure/gpt-4o-mini");
  const answer = await model.invoke("plan the stage");

  assert.equal(answer.content, '{"ok":true}');
  assert.equal(seen[0]?.url,
    "https://magentic.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21");
  assert.equal(seen[0]?.headers["api-key"], "azure-secret");
  assert.equal(seen[0]?.headers.Authorization, undefined, "azure takes a header key, not a bearer token");
  // The deployment is in the path, so the body must not also name a model.
  assert.equal((seen[0]?.body as { model?: unknown }).model, undefined);
});

test("the api version can be pinned", async () => {
  const seen: string[] = [];
  const request: typeof fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
  };
  const chat = withCloudModels(base, { ...CONFIGURED, AZURE_OPENAI_API_VERSION: "2025-01-01-preview" }, request);
  await (await chat.loadModel!("azure/gpt-4o")).invoke("x");
  assert.match(seen[0] ?? "", /api-version=2025-01-01-preview/);
});

test("the other providers are unchanged", async () => {
  const chat = withCloudModels(base, { OPENAI_API_KEY: "k" });
  const options = await chat.modelOptions!();
  assert.ok(options.some((option) => option.id.startsWith("openai/") && option.available));
  assert.ok(options.some((option) => option.id.startsWith("anthropic/") && !option.available));
  assert.ok(options.some((option) => option.id.startsWith("google/") && !option.available));
});
