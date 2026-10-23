import assert from "node:assert/strict";
import test from "node:test";
import { LnkzApiError, LnkzClient } from "../client.js";

test("startup fails closed when either required setting is missing", () => {
  assert.throws(() => LnkzClient.fromEnv({}), /LNKZ_BASE_URL is required/);
  assert.throws(() => LnkzClient.fromEnv({ LNKZ_BASE_URL: "https://lnkz.example" }), /LNKZ_API_KEY is required/);
  assert.throws(
    () => LnkzClient.fromEnv({ LNKZ_BASE_URL: "file:///tmp/lnkz", LNKZ_API_KEY: "secret" }),
    /must use http or https/,
  );
});

test("REST calls use the configured base URL and bearer key", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ stats: { conversations: 0, messages: 0, providers: [], activeHandoffs: 0, events: 0 } });
  };
  const client = new LnkzClient("https://lnkz.example/", "test-api-key", fetchImpl);

  await client.stats();

  assert.equal(capturedUrl, "https://lnkz.example/api/stats");
  assert.equal(capturedAuthorization, "Bearer test-api-key");
});

test("API failures expose the relay message without exposing the API key", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
  const client = new LnkzClient("https://lnkz.example", "never-print-this-key", fetchImpl);

  await assert.rejects(client.stats(), (error: unknown) => {
    assert.ok(error instanceof LnkzApiError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "Unauthorized");
    assert.doesNotMatch(error.message, /never-print-this-key/);
    return true;
  });
});
