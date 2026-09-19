import assert from "node:assert/strict";
import test from "node:test";
import { loadChatModel, loadEmbeddings, resetLoadedModels, type LlmConfig } from "../llm/provider.js";

/**
 * Does the real LangChain actually fit the shape we assumed?
 *
 * provider.ts deliberately depends on two interfaces of our own rather than
 * on LangChain's types, which is what lets every other test run with no
 * package installed. The cost of that choice is precise: nothing checks that
 * the real classes still satisfy those interfaces. A renamed export or a
 * changed method name would typecheck, pass every test, and fail at the
 * first tool call on a machine that actually has the package.
 *
 * This file is that check. It skips when the package is absent, which is the
 * normal case in CI and on any instance that never turned the feature on,
 * and it runs for real the moment someone installs one. The skip message
 * names the install command, because a silently skipped test is one nobody
 * ever notices was never run.
 *
 * Nothing here reaches the network: constructing a LangChain client does not
 * call anything, and no invoke happens below.
 */

function configFor(provider: "ollama" | "openai"): LlmConfig {
  return {
    provider,
    chatModel: provider === "ollama" ? "llama3.1" : "gpt-4o-mini",
    embeddingModel: provider === "ollama" ? "nomic-embed-text" : "text-embedding-3-small",
    maxConversations: 40, maxChunks: 12, chunkChars: 1_600,
    batchSize: 64, maxContextChars: 24_000, cacheSize: 100,
  };
}

/** The same variable-specifier import the product uses, so this tests that path too. */
async function packageIsInstalled(specifier: string): Promise<boolean> {
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

function assertEmbeddingsShape(value: unknown, name: string): void {
  assert.equal(typeof value, "object", `${name} did not construct into an object`);
  const candidate = value as Record<string, unknown>;
  assert.equal(typeof candidate.embedDocuments, "function", `${name} has no embedDocuments; EmbeddingsLike is wrong`);
  assert.equal(typeof candidate.embedQuery, "function", `${name} has no embedQuery; EmbeddingsLike is wrong`);
}

function assertChatShape(value: unknown, name: string): void {
  assert.equal(typeof value, "object", `${name} did not construct into an object`);
  const candidate = value as Record<string, unknown>;
  assert.equal(typeof candidate.invoke, "function", `${name} has no invoke; ChatModelLike is wrong`);
}

test("ollama satisfies the interfaces provider.ts assumes", async (t) => {
  if (!await packageIsInstalled("@langchain/ollama")) {
    t.skip("@langchain/ollama is not installed. Run: pnpm add @langchain/ollama");
    return;
  }
  const config = configFor("ollama");

  resetLoadedModels();
  assertEmbeddingsShape(await loadEmbeddings(config), "OllamaEmbeddings");

  resetLoadedModels();
  assertChatShape(await loadChatModel(config), "ChatOllama");
});

test("openai satisfies the interfaces provider.ts assumes", async (t) => {
  if (!await packageIsInstalled("@langchain/openai")) {
    t.skip("@langchain/openai is not installed. Run: pnpm add @langchain/openai");
    return;
  }
  const previous = process.env.OPENAI_API_KEY;
  // Construction only. A placeholder is enough and nothing is sent.
  process.env.OPENAI_API_KEY = previous ?? "sk-not-a-real-key-construction-only";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const config = configFor("openai");

  resetLoadedModels();
  assertEmbeddingsShape(await loadEmbeddings(config), "OpenAIEmbeddings");

  resetLoadedModels();
  assertChatShape(await loadChatModel(config), "ChatOpenAI");
});

test("a missing package fails with the install command rather than a module error", async (t) => {
  const absent = "@langchain/ollama";
  if (await packageIsInstalled(absent)) {
    t.skip("@langchain/ollama is installed, so the absent-package path cannot be exercised here");
    return;
  }
  resetLoadedModels();
  await assert.rejects(
    () => loadEmbeddings(configFor("ollama")),
    (error: Error) => /is not installed/.test(error.message) && /pnpm add @langchain\/ollama/.test(error.message),
  );
});

test("openai refuses to construct without a key, before anything is imported", async (t) => {
  if (!await packageIsInstalled("@langchain/openai")) {
    t.skip("@langchain/openai is not installed. Run: pnpm add @langchain/openai");
    return;
  }
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });

  resetLoadedModels();
  await assert.rejects(() => loadChatModel(configFor("openai")), /OPENAI_API_KEY is required/);
});

test("the memoized client is per process, and resettable", async (t) => {
  if (!await packageIsInstalled("@langchain/ollama")) {
    t.skip("@langchain/ollama is not installed. Run: pnpm add @langchain/ollama");
    return;
  }
  const config = configFor("ollama");
  resetLoadedModels();
  const first = await loadEmbeddings(config);
  const second = await loadEmbeddings(config);
  assert.equal(first, second, "constructing a client per query would be waste");

  resetLoadedModels();
  const third = await loadEmbeddings(config);
  assert.notEqual(first, third);
});
