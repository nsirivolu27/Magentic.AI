import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfile } from "../profiles.js";
import { LnkzClient } from "../client.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const profiles = JSON.stringify([{ name: "team", baseUrl: "https://relay.example", apiKeyEnv: "TEAM_KEY", workspaceId }]);

test("profiles resolve secrets by reference and never silently fall back", () => {
  const env = { LNKZ_PROFILES_JSON: profiles, LNKZ_PROFILE: "team", TEAM_KEY: "team-secret", LNKZ_API_KEY: "wrong-key" };
  assert.equal(resolveProfile(env).apiKey, "team-secret");
  assert.throws(() => resolveProfile({ ...env, LNKZ_PROFILE: "typo" }), /no fallback/);
  assert.throws(() => resolveProfile({ ...env, TEAM_KEY: "" }), /missing/);
  assert.throws(() => resolveProfile({ ...env, LNKZ_PROFILES_JSON: "team-secret" }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /team-secret/); return true;
  });
});

test("profile calls assert workspace before writes and reject absent or mismatched response identity", async () => {
  let identity: string | undefined = workspaceId;
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("x-lnkz-expected-workspace-id"), workspaceId);
    assert.equal(init?.redirect, "error");
    return Response.json({ workspace: { id: workspaceId } }, { headers: identity ? { "x-lnkz-workspace-id": identity } : {} });
  };
  const client = new LnkzClient("https://relay.example", "key", fetchImpl, workspaceId);
  await client.workspace();
  identity = undefined;
  await assert.rejects(client.workspace(), /does not match/);
  identity = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(client.workspace(), /does not match/);
});
