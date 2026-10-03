import assert from "node:assert/strict";
import test from "node:test";
import { hashDefinition, isServable, validApprovers, type RegistryRecord } from "../registry/record.js";
import { memoryStore, TRANSITIONS } from "../registry/store.js";
import { loadRegistryCatalog } from "../registry/catalog.js";
import type { AgentDefinition } from "../catalog/schema.js";

const KNOWN = new Set(["list_conversations", "get_conversation", "save_conversation"]);

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "reader",
    title: "Reader",
    description: "Reads conversations.",
    category: "general",
    version: "1.0.0",
    tools: ["list_conversations", "get_conversation"],
    optionalTools: [],
    scopes: ["read"],
    instructions: "Read only.",
    publisher: "magentic",
    ...overrides,
  };
}

function record(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  const def = overrides.definition ?? definition();
  return {
    workspaceId: "agency-a",
    definition: def,
    status: "draft",
    author: "nihal",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    approvals: [],
    ...overrides,
  };
}

function signed(def: AgentDefinition, approvers: string[]): RegistryRecord {
  return record({
    definition: def,
    status: "approved",
    approvals: approvers.map((approver) => ({
      approver,
      at: "2026-09-19T01:00:00.000Z",
      definitionHash: hashDefinition(def),
    })),
  });
}

test("the same definition hashes the same whatever the key order", () => {
  const a = definition();
  const b = { ...definition(), name: "reader" };
  assert.equal(hashDefinition(a), hashDefinition(b));
});

test("any change to a definition changes its hash", () => {
  const before = hashDefinition(definition());
  const after = hashDefinition(definition({ instructions: "Read only. And summarize." }));
  assert.notEqual(before, after);
});

test("a draft is never servable", () => {
  assert.equal(isServable(record()), false);
});

test("an approved record with a matching signature is servable", () => {
  assert.equal(isServable(signed(definition(), ["approver-1"])), true);
});

test("editing after approval makes the record unservable without touching its status", () => {
  const original = definition();
  const stale = signed(original, ["approver-1"]);
  // The approval still says "approved", but it was signed on other content.
  const edited: RegistryRecord = { ...stale, definition: definition({ scopes: ["read", "write"] }) };
  assert.equal(edited.status, "approved");
  assert.equal(isServable(edited), false, "a signature must not carry over to edited content");
  assert.deepEqual(validApprovers(edited), []);
});

test("two signatures are required when the deployment asks for two", () => {
  const one = signed(definition(), ["approver-1"]);
  assert.equal(isServable(one, 2), false);
  const two = signed(definition(), ["approver-1", "approver-2"]);
  assert.equal(isServable(two, 2), true);
});

test("one person signing twice is one signature", () => {
  const def = definition();
  const twice = signed(def, ["approver-1", "approver-1"]);
  assert.deepEqual(validApprovers(twice), ["approver-1"]);
  assert.equal(isServable(twice, 2), false, "self-approval must not satisfy two-person review");
});

test("only approved records reach the catalog, and the rest say why", async () => {
  const store = memoryStore([
    signed(definition(), ["approver-1"]),
    record({ definition: definition({ name: "drafty" }) }),
  ]);
  const catalog = await loadRegistryCatalog(store, "agency-a", { allowWrites: true, known: [...KNOWN] });
  assert.deepEqual(catalog.entries.map((entry) => entry.definition.name), ["reader"]);
  assert.deepEqual(catalog.withheld.map((item) => [item.name, item.reason]), [["drafty", "not-approved"]]);
});

test("a record from another workspace is not served", async () => {
  const store = memoryStore([
    { ...signed(definition(), ["approver-1"]), workspaceId: "agency-b" },
  ]);
  const catalog = await loadRegistryCatalog(store, "agency-a", { allowWrites: true, known: [...KNOWN] });
  assert.equal(catalog.entries.length, 0);
  assert.equal(catalog.withheld.length, 0, "another workspace's record is absent, not withheld");
});

test("a record naming a tool this build lacks is withheld, not thrown", async () => {
  const store = memoryStore([signed(definition({ tools: ["no_such_tool"] }), ["approver-1"])]);
  const catalog = await loadRegistryCatalog(store, "agency-a", { allowWrites: true, known: [...KNOWN] });
  assert.equal(catalog.entries.length, 0);
  assert.equal(catalog.withheld[0]?.reason, "missing-tools");
});

test("the deployment scope ceiling still applies to an approved agent", async () => {
  const writer = signed(definition({ name: "writer", scopes: ["read", "write"], tools: ["save_conversation"] }), ["approver-1"]);
  const store = memoryStore([writer]);
  const readOnly = await loadRegistryCatalog(store, "agency-a", { allowWrites: false, known: [...KNOWN] });
  assert.equal(readOnly.entries[0]?.writesAllowed, false, "approval cannot widen what the deployment allows");
});

test("the store round-trips and lists per workspace", async () => {
  const store = memoryStore();
  await store.put(record());
  assert.equal((await store.get("agency-a", "reader"))?.author, "nihal");
  assert.equal(await store.get("agency-b", "reader"), undefined);
  await store.remove("agency-a", "reader");
  assert.deepEqual(await store.list("agency-a"), []);
});

test("approved records cannot go back to draft directly", () => {
  assert.deepEqual(TRANSITIONS.approved, ["retired"]);
  assert.equal(TRANSITIONS.retired.length, 0);
});
