import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsSchema } from "../workbench/accounts.js";
import { createCompanyAccess } from "../workbench/company-access.js";
import { fileWorkspaceStore } from "../workbench/storage.js";
import { workspaceDirectory } from "../workbench/workspace-directory.js";
import { createOntologyDirectory, ontologyConfigSchema } from "../workbench/ontology.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";

test("company ontology reads reject other companies before contacting Foundry", async () => {
  const path = mkdtempSync(join(tmpdir(), "company-ontology-"));
  const store = fileWorkspaceStore(path);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = accountsSchema.parse({ clerk: { issuer: "https://tenant.clerk.accounts.dev", publishableKey: "pk_test_fixture",
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), authorizedParties: ["https://portal.example"] }, members: [], companies: {} });
  const companies = createCompanyAccess(config, workspaceDirectory(path, store, "system"), async actor => [{
    id: "membership_" + actor, role: "org:admin", organization: { id: actor === "user_one" ? "org_one" : "org_two", name: "Company" },
  }]);
  const one = await companies.open("user_one", { organizationId: "org_one" });
  const two = await companies.open("user_two", { organizationId: "org_two" });
  let reads = 0;
  const ontology = createOntologyDirectory({ version: 1, workspaces: [{ workspaceId: one.workspaceId, mode: "foundry",
    ontology: "company-ontology", baseUrl: "https://foundry.example", tokenSetting: "MAGENTIC_FOUNDRY_TOKEN_COMPANY",
    objectTypes: [{ apiName: "Company", properties: ["name"] }] }] }, () => "fixture-token", (async () => {
    reads++; return Response.json({ __apiName: "Company", __primaryKey: "one", name: "Synthetic company", privateProperty: "must not reach the user" });
  }) as typeof fetch);
  const server = createWorkbenchServer({ assets: new Map(), accounts: config, companies, ontology,
    authenticate: companies.authenticate, context: { store: memoryStore(), audit: memoryAudit(), members: companies.members } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  function token(actor: string) {
    const now = Math.floor(Date.now() / 1000);
    const input = [{ alg: "RS256" }, { sub: actor, sid: "sess_fixture", iss: config.clerk.issuer,
      azp: "https://portal.example", iat: now, nbf: now - 1, exp: now + 60 }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return input + "." + sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url");
  }
  const call = (actor: string, workspace: string, extra = {}) => fetch(`http://127.0.0.1:${port}/api/ontology/reference`, {
    method: "POST", headers: { Authorization: `Bearer ${token(actor)}`, "Content-Type": "application/json", "X-Magentic-Workspace": workspace },
    body: JSON.stringify({ objectType: "Company", primaryKey: "one", ...extra }),
  });
  try {
    assert.equal((await call("user_two", one.workspaceId)).status, 403);
    assert.equal((await call("user_two", two.workspaceId)).status, 404);
    assert.equal((await call("user_one", one.workspaceId, { workspaceId: two.workspaceId })).status, 400);
    assert.equal(reads, 0);
    const response = await call("user_one", one.workspaceId);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Synthetic company/);
    assert.doesNotMatch(body, /privateProperty|fixture-token|must not reach/);
    assert.equal(reads, 1);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    store.close(); rmSync(path, { recursive: true, force: true });
  }
});

test("company ontology blueprint has matching datasets, keys and allowed link targets", () => {
  const base = "examples/ontology/company/";
  const blueprint = JSON.parse(readFileSync(base + "blueprint.json", "utf8"));
  const connection = ontologyConfigSchema.parse(JSON.parse(readFileSync(base + "connection.example.json", "utf8")));
  const config = connection.workspaces[0]!;
  assert.equal(config.mode, "foundry");
  if (config.mode !== "foundry") return;
  for (const type of blueprint.objectTypes) {
    const [header, row] = readFileSync(base + "data/" + type.apiName + ".csv", "utf8").trimEnd().split(/\r?\n/);
    const columns = header!.split(",");
    const values = row!.split(",");
    assert.deepEqual(columns, Object.keys(type.properties));
    assert.equal(columns.length, values.length);
    assert.ok(values[columns.indexOf(type.primaryKey)]);
    assert.deepEqual(config.objectTypes.find(item => item.apiName === type.apiName)?.properties, columns);
    for (const link of type.links) {
      const target = blueprint.objectTypes.find((item: { apiName: string }) => item.apiName === link.targetType);
      assert.ok(target);
      const [targetHeader, targetRow] = readFileSync(base + "data/" + target.apiName + ".csv", "utf8").trimEnd().split(/\r?\n/);
      assert.equal(values[columns.indexOf(link.foreignKey)], targetRow!.split(",")[targetHeader!.split(",").indexOf(target.primaryKey)]);
    }
  }
});
