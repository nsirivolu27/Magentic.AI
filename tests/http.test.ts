import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createAdapterHttpServer } from "../http.js";

/**
 * The hosted adapter's front door.
 *
 * The tools are covered in mcp.test.ts through an in-memory transport. What is
 * only reachable over HTTP is the part that decides who gets in, and that is
 * the part where hosting an adapter differs from running one as a subprocess:
 * a hosted adapter holds no key, so every request has to carry its own.
 */
async function hosted() {
  const server = createAdapterHttpServer({ baseUrl: "https://relay.example.com" });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
};

test("a request without a key is refused, with a challenge saying what to send", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(INITIALIZE),
  });

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
  const body = await response.json() as { error?: string };
  assert.match(body.error ?? "", /Authorization: Bearer/);
});

test("a malformed Authorization header is not treated as a key", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  for (const header of ["", "Bearer", "Bearer   ", "Basic abc123", "abc123"]) {
    const response = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: header },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(response.status, 401, `"${header}" was accepted as a bearer key`);
  }
});

test("GET and DELETE are refused, because this server keeps no session", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(`${server.base}/mcp`, {
      method,
      headers: { authorization: "Bearer a-caller-key" },
    });
    assert.equal(response.status, 405, `${method} was not refused`);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("health answers without a key and names the relay, carrying nothing else", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, { ok: true, relay: "https://relay.example.com" });
});

test("an oversized body is refused before it is parsed", async (t) => {
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer a-caller-key" },
    body: JSON.stringify({ ...INITIALIZE, padding: "x".repeat(1_100_000) }),
  });

  assert.equal(response.status, 413);
});

test("unknown paths are a plain 404 rather than a JSON-RPC error", async (t) => {
  // A 404 from the wrong path should not look like a protocol failure, or the
  // client reports a broken MCP server instead of a wrong URL.
  const server = await hosted();
  t.after(() => server.close());

  const response = await fetch(`${server.base}/`, { headers: { authorization: "Bearer a-caller-key" } });
  assert.equal(response.status, 404);
  const body = await response.json() as Record<string, unknown>;
  assert.equal("jsonrpc" in body, false);
});

test("the configuration refuses an empty relay url rather than defaulting", async () => {
  assert.throws(() => createAdapterHttpServer({ baseUrl: "   " }), /LNKZ_BASE_URL is required/);
});
