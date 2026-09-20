import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registryDirectory, requiredApprovals, resolveCatalog } from "../registry/source.js";
import { hashDefinition, type RegistryRecord } from "../registry/record.js";

const HERE = import.meta.url;

function approvedRecord(workspaceId: string, name: string, approvers: string[]): RegistryRecord {
  const definition = {
    name,
    title: "Reader",
    description: "Reads conversations.",
    category: "general",
    version: "1.0.0",
    tools: ["list_conversations"],
    optionalTools: [],
    scopes: ["read"] as ("read" | "write")[],
    instructions: "Read only.",
    publisher: "magentic",
  };
  return {
    workspaceId,
    definition,
    status: "approved",
    author: "nihal",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    approvals: approvers.map((approver) => ({
      approver,
      at: "2026-09-19T01:00:00.000Z",
      definitionHash: hashDefinition(definition),
    })),
  };
}

function seedRegistry(records: RegistryRecord[]): string {
  const directory = mkdtempSync(join(tmpdir(), "magentic-registry-"));
  for (const record of records) {
    const folder = join(directory, record.workspaceId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${record.definition.name}.json`), JSON.stringify(record, null, 2), "utf8");
  }
  return directory;
}

test("workspace mode is off unless a registry directory is named", async () => {
  assert.equal(registryDirectory({}), undefined);
  const resolved = await resolveCatalog(HERE, true, {});
  assert.equal(resolved.mode, "files", "the default must stay the behaviour every deployment has today");
  assert.deepEqual(resolved.withheld, []);
});

test("a registry with no workspace named refuses to start", async () => {
  const directory = seedRegistry([]);
  await assert.rejects(
    () => resolveCatalog(HERE, true, { MAGENTIC_REGISTRY_DIR: directory }),
    /MAGENTIC_WORKSPACE must name the workspace/,
  );
});

test("workspace mode serves approved records from the registry", async () => {
  const directory = seedRegistry([approvedRecord("agency-a", "reader", ["approver-1"])]);
  const resolved = await resolveCatalog(HERE, true, {
    MAGENTIC_REGISTRY_DIR: directory,
    MAGENTIC_WORKSPACE: "agency-a",
  });
  assert.equal(resolved.mode, "workspace");
  assert.equal(resolved.workspaceId, "agency-a");
  assert.deepEqual(resolved.catalog?.entries.map((entry) => entry.definition.name), ["reader"]);
});

test("another workspace's approved record is not served", async () => {
  const directory = seedRegistry([approvedRecord("agency-b", "reader", ["approver-1"])]);
  const resolved = await resolveCatalog(HERE, true, {
    MAGENTIC_REGISTRY_DIR: directory,
    MAGENTIC_WORKSPACE: "agency-a",
  });
  assert.equal(resolved.catalog?.entries.length, 0);
});

test("one signature does not satisfy a two signature deployment", async () => {
  const directory = seedRegistry([approvedRecord("agency-a", "reader", ["approver-1"])]);
  const resolved = await resolveCatalog(HERE, true, {
    MAGENTIC_REGISTRY_DIR: directory,
    MAGENTIC_WORKSPACE: "agency-a",
    MAGENTIC_REQUIRED_APPROVALS: "2",
  });
  assert.equal(resolved.catalog?.entries.length, 0);
  assert.equal(resolved.withheld[0]?.reason, "approvals-stale");
});

test("a nonsense approval count is refused rather than rounded", () => {
  assert.equal(requiredApprovals({}), 1);
  assert.equal(requiredApprovals({ MAGENTIC_REQUIRED_APPROVALS: "2" }), 2);
  assert.throws(() => requiredApprovals({ MAGENTIC_REQUIRED_APPROVALS: "0" }), /whole number from 1 to 10/);
  assert.throws(() => requiredApprovals({ MAGENTIC_REQUIRED_APPROVALS: "many" }), /whole number from 1 to 10/);
});
