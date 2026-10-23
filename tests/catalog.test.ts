import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, resolve } from "../catalog/load.js";
import { agentSchema, toPublicAgent } from "../catalog/schema.js";
import { lnkzToolNames } from "../mcp.js";

const SHIPPED = "agents";

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "lnkz-agents-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(directory, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return directory;
}

const valid = {
  name: "reader",
  title: "Reader",
  description: "Reads.",
  version: "1.0.0",
  tools: ["list_conversations", "get_conversation"],
  instructions: "Read only.",
};

// ------------------------------------------------------------------ the tool universe

test("the tool universe is read from the build, not from a list someone typed", () => {
  const names = lnkzToolNames();
  assert.ok(names.length > 20, "the adapter registers a lot of tools and all of them should be here");
  assert.ok(names.includes("create_handoff"));
  assert.ok(names.includes("search_conversations"));
  assert.deepEqual([...names], [...names].sort(), "sorted, so a diff of this list is readable");
  assert.equal(new Set(names).size, names.length, "no duplicates");
});

// ------------------------------------------------------------------ the shipped agents

test("every shipped agent loads against the real tool surface", () => {
  const catalog = loadCatalog({ directory: SHIPPED, allowWrites: true });
  const names = catalog.entries.map((entry) => entry.definition.name);
  assert.deepEqual(names, ["conversation-relay", "handoff-desk", "research-reader"]);
  for (const entry of catalog.entries) {
    assert.ok(entry.activeTools.size > 0);
    assert.equal(entry.endpoint, `/mcp/${entry.definition.name}`);
  }
});

test("the reader agent exposes nothing that changes anything", () => {
  const catalog = loadCatalog({ directory: SHIPPED, allowWrites: true });
  const reader = catalog.byName.get("research-reader");
  assert.ok(reader);
  assert.equal(reader.writesAllowed, false, "it never asked for write, so it never gets it");
  for (const forbidden of [
    "save_conversation", "append_messages", "delete_conversation", "import_conversation",
    "import_from_url", "create_handoff", "redeem_handoff", "continue_handoff",
    "continue_from_link", "revoke_handoff", "export_training_dataset", "prepare_publish",
  ]) {
    assert.equal(reader.activeTools.has(forbidden), false, `${forbidden} must not be on the reader`);
  }
});

test("the handoff desk cannot save, delete or export a dataset", () => {
  const desk = loadCatalog({ directory: SHIPPED, allowWrites: true }).byName.get("handoff-desk");
  assert.ok(desk);
  assert.equal(desk.writesAllowed, true);
  for (const forbidden of ["save_conversation", "delete_conversation", "export_training_dataset", "import_conversation"]) {
    assert.equal(desk.activeTools.has(forbidden), false);
  }
  assert.ok(desk.activeTools.has("create_handoff"));
});

// ------------------------------------------------------------------ the scope ceiling

test("a read-only deployment strips write from every agent that asked for it", () => {
  const catalog = loadCatalog({ directory: SHIPPED, allowWrites: false });
  for (const entry of catalog.entries) {
    assert.equal(entry.writesAllowed, false, `${entry.definition.name} must not keep write on a read-only host`);
  }
  const relay = catalog.byName.get("conversation-relay");
  assert.ok(relay);
  assert.deepEqual(toPublicAgent(relay).scopes, ["read"], "the listing says read, so nobody plans around a write it will not get");
});

// ------------------------------------------------------------------ what fails, and when

test("an agent requiring a tool this build does not register fails at boot, naming the file", () => {
  const directory = directoryWith({ "bad.json": { ...valid, tools: ["list_conversations", "summon_a_demon"] } });
  assert.throws(
    () => loadCatalog({ directory, allowWrites: true }),
    (error: Error) => /summon_a_demon/.test(error.message) && /bad\.json/.test(error.message) && /optionalTools/.test(error.message),
  );
});

test("two definitions claiming one name are refused", () => {
  const directory = directoryWith({
    "a.json": valid,
    "b.json": { ...valid, title: "Other" },
  });
  assert.throws(() => loadCatalog({ directory, allowWrites: true }), /claim the name "reader"/);
});

test("malformed JSON is refused with the file named", () => {
  const directory = directoryWith({ "broken.json": "{ not json" });
  assert.throws(() => loadCatalog({ directory, allowWrites: true }), /broken\.json is not valid JSON/);
});

test("a definition that fails validation says which field", () => {
  const directory = directoryWith({ "bad.json": { ...valid, version: "one" } });
  assert.throws(() => loadCatalog({ directory, allowWrites: true }), /version: Versions are semantic/);
});

test("an unknown field is refused rather than ignored", () => {
  // A typo in a key would otherwise mean a setting that looks applied and is not.
  const parsed = agentSchema.safeParse({ ...valid, scope: ["write"] });
  assert.equal(parsed.success, false);
});

test("a definition cannot name a relay or carry a key", () => {
  for (const smuggled of [{ baseUrl: "https://elsewhere.test" }, { apiKey: "secret" }, { relay: "x" }]) {
    assert.equal(agentSchema.safeParse({ ...valid, ...smuggled }).success, false);
  }
});

test("a missing directory is an error rather than an empty catalog", () => {
  assert.throws(() => loadCatalog({ directory: join(tmpdir(), "lnkz-does-not-exist-9f2a"), allowWrites: true }), /could not be read/);
});

// ------------------------------------------------------------------ optional tools

test("an optional tool this build lacks is reported, not fatal", () => {
  const directory = directoryWith({
    "reader.json": { ...valid, optionalTools: ["semantic_search", "ask_conversations"] },
  });
  const entry = loadCatalog({ directory, allowWrites: true, known: ["list_conversations", "get_conversation"] }).byName.get("reader");
  assert.ok(entry);
  assert.deepEqual([...entry.unavailableTools], ["semantic_search", "ask_conversations"]);
  assert.equal(entry.activeTools.size, 2);
});

test("an optional tool this build has is registered like any other", () => {
  const definition = agentSchema.parse({ ...valid, optionalTools: ["semantic_search"] });
  const entry = resolve(definition, new Set(["list_conversations", "get_conversation", "semantic_search"]), true);
  assert.ok(entry.activeTools.has("semantic_search"));
  assert.deepEqual([...entry.unavailableTools], []);
});

// ------------------------------------------------------------------ the public listing

test("the public listing carries only the fields it is allowed to", () => {
  // Asserted as an allowlist rather than a search for suspicious words,
  // because the failure being guarded against is a field added later that
  // nobody thought to look for.
  const allowed = new Set([
    "id", "object", "title", "description", "category", "version", "publisher",
    "homepage", "endpoint", "scopes", "tools", "unavailableTools", "instructions",
  ]);
  const catalog = loadCatalog({ directory: SHIPPED, allowWrites: true });
  for (const entry of catalog.entries) {
    const published = toPublicAgent(entry);
    for (const key of Object.keys(published)) {
      assert.ok(allowed.has(key), `${key} is published and was never reviewed for publication`);
    }
    const serialized = JSON.stringify(published);
    // Environment variable names rather than the word "bearer", which the
    // instructions legitimately use to tell a model how to treat a token.
    assert.equal(/LNKZ_[A-Z_]+|OPENAI_API_KEY/.test(serialized), false, "no credential variable named");
    assert.equal(/https?:\/\//.test(serialized.replace(published.homepage ?? "\u0000", "")), false, "no URL but a declared homepage");
  }
});

test("a read-only deployment publishes the tool list it will actually serve", () => {
  // The listing is what someone plans around. Promising sixteen tools and
  // registering eleven is the kind of gap that gets debugged rather than read.
  const open = loadCatalog({ directory: SHIPPED, allowWrites: true }).byName.get("conversation-relay");
  const locked = loadCatalog({ directory: SHIPPED, allowWrites: false }).byName.get("conversation-relay");
  assert.ok(open && locked);
  assert.ok(locked.activeTools.size < open.activeTools.size);
  for (const write of ["save_conversation", "create_handoff", "append_messages", "revoke_handoff", "redeem_handoff"]) {
    assert.ok(open.activeTools.has(write));
    assert.equal(locked.activeTools.has(write), false, `${write} is still advertised on a read-only host`);
  }
  assert.ok(locked.activeTools.has("list_conversations"));
});
