import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { accountsSchema, clerkActor } from "../workbench/accounts.js";

test("Clerk issuance skew is bounded and does not extend expiry or skip other claims", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = accountsSchema.parse({ clerk: { issuer: "https://test.clerk.accounts.dev", publishableKey: "pk_test_fixture",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), authorizedParties: ["https://portal.example"] }, members: [], companies: {} });
  const now = 1800000000;
  const token = (changes: Record<string, unknown> = {}) => {
    const content = [{ alg: "RS256" }, { iss: config.clerk.issuer, azp: "https://portal.example", sub: "user_member",
      sid: "sess_fixture", iat: now + 1, nbf: now - 10, exp: now + 60, ...changes }]
      .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return content + "." + sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url");
  };
  assert.equal(clerkActor(token(), config, now * 1000), "user_member");
  assert.equal(clerkActor(token({ iat: now + 5 }), config, now * 1000), "user_member");
  for (const changes of [{ iat: now + 6 }, { iat: "invalid" }, { iat: now - 60, exp: now },
    { nbf: now + 1 }, { sts: "pending" }, { iss: "https://other.example" }, { azp: "https://other.example" }]) {
    assert.equal(clerkActor(token(changes), config, now * 1000), undefined);
  }
});
