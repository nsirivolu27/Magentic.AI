import assert from "node:assert/strict";
import test from "node:test";
import { createLnkzRestClient } from "../src/client.js";

test("the REST client refuses to start without both relay settings", () => {
  assert.throws(() => createLnkzRestClient({} as NodeJS.ProcessEnv), /LNKZ_BASE_URL and LNKZ_API_KEY are required/);
  assert.throws(() => createLnkzRestClient({ LNKZ_BASE_URL: "http://relay" } as NodeJS.ProcessEnv), /LNKZ_BASE_URL and LNKZ_API_KEY are required/);
  assert.throws(() => createLnkzRestClient({ LNKZ_API_KEY: "secret" } as NodeJS.ProcessEnv), /LNKZ_BASE_URL and LNKZ_API_KEY are required/);
});

test("REST calls carry the API key and never expose it in REST errors", async () => {
  let received: Request | undefined;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    received = new Request(input, init);
    return new Response(JSON.stringify({ error: "bad request" }), { status: 502, headers: { "content-type": "application/json" } });
  };
  const client = createLnkzRestClient({ LNKZ_BASE_URL: "http://relay.example/base", LNKZ_API_KEY: "secret-value" } as NodeJS.ProcessEnv, fetchImpl);
  await assert.rejects(() => client.request("GET", "/health"), (error: Error) => {
    assert.match(error.message, /HTTP 502/);
    assert.equal(error.message.includes("secret-value"), false);
    return true;
  });
  assert.equal(received?.url, "http://relay.example/base/health");
  assert.equal(received?.headers.get("authorization"), "Bearer secret-value");
});