import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { chatConfiguration } from "../workbench/chat-config.js";
import { ollamaRequest } from "../workbench/ollama-request.js";

test("Ollama transport cancels while waiting for response headers", { timeout: 10000 }, async () => {
  let seen!: () => void;
  const received = new Promise<void>(resolve => { seen = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    response.on("close", closed);
    seen();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const controller = new AbortController();
    const pending = ollamaRequest(controller.signal)(`http://127.0.0.1:${address.port}/api/chat`, { method: "POST", body: "{}" });
    const rejected = assert.rejects(pending);
    await received;
    controller.abort();
    await Promise.all([rejected, disconnected]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Ollama transport preserves streamed response text and errors", { timeout: 10000 }, async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(503, { "Content-Type": "application/x-ndjson" });
    response.write('{"error":');
    response.end('"busy"}\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await ollamaRequest(AbortSignal.timeout(5000))(`http://127.0.0.1:${address.port}/api/chat`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await response.text(), '{"error":"busy"}\n');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("stopping an Ollama request closes its connection before the first token", { timeout: 15000 }, async t => {
  const specifier = "@langchain/ollama";
  try { await import(specifier); }
  catch { t.skip("Optional Ollama adapter is not installed"); return; }
  let seen!: (body: Record<string, unknown>) => void;
  const requestSeen = new Promise<Record<string, unknown>>(resolve => { seen = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/api/tags") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "fixture" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    response.on("close", closed);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.flushHeaders();
    seen(JSON.parse(body));
  });
  const saved = { MAGENTIC_LLM_PROVIDER: process.env.MAGENTIC_LLM_PROVIDER, MAGENTIC_LLM_CHAT_MODEL: process.env.MAGENTIC_LLM_CHAT_MODEL, MAGENTIC_LLM_BASE_URL: process.env.MAGENTIC_LLM_BASE_URL };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.MAGENTIC_LLM_PROVIDER = "ollama";
    process.env.MAGENTIC_LLM_CHAT_MODEL = "fixture";
    process.env.MAGENTIC_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
    const model = await chatConfiguration()!.loadModel("fixture", { maxOutputTokens: 1024 });
    const controller = new AbortController();
    const format = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    const pending = model.invoke("Read the fixture", { signal: controller.signal, format });
    const rejected = assert.rejects(pending);
    const body = await requestSeen;
    assert.deepEqual(body.format, format, "structured decoding reaches Ollama");
    assert.equal((body.options as { num_predict: number }).num_predict, 1024);
    controller.abort();
    await Promise.all([rejected, disconnected]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
