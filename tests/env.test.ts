import assert from "node:assert/strict";
import test from "node:test";
import { renamedSettings, resetDeprecationWarnings, setting } from "../env.js";

test("the new name is read", () => {
  assert.equal(setting("MAGENTIC_SCOPES", { MAGENTIC_SCOPES: "read" }), "read");
});

test("the pre-rename name still works", () => {
  resetDeprecationWarnings();
  assert.equal(setting("MAGENTIC_SCOPES", { LNKZ_MCP_SCOPES: "read" }), "read");
});

test("the new name wins when both are set", () => {
  resetDeprecationWarnings();
  assert.equal(setting("MAGENTIC_SCOPES", { MAGENTIC_SCOPES: "write", LNKZ_MCP_SCOPES: "read" }), "write");
});

test("an empty new name falls through to the old one", () => {
  resetDeprecationWarnings();
  assert.equal(setting("MAGENTIC_SCOPES", { MAGENTIC_SCOPES: "", LNKZ_MCP_SCOPES: "read" }), "read");
});

test("an unset setting is undefined", () => {
  assert.equal(setting("MAGENTIC_SCOPES", {}), undefined);
});

test("a setting with no old name is read straight through", () => {
  assert.equal(setting("MAGENTIC_LEGACY_URIS", { MAGENTIC_LEGACY_URIS: "0" }), "0");
  assert.equal(setting("MAGENTIC_LEGACY_URIS", {}), undefined);
});

test("using an old name warns once, naming its replacement", () => {
  resetDeprecationWarnings();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    setting("MAGENTIC_SCOPES", { LNKZ_MCP_SCOPES: "read" });
    setting("MAGENTIC_SCOPES", { LNKZ_MCP_SCOPES: "read" });
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.equal(written.length, 1, "one warning per variable, not one per read");
  const warning = written[0];
  assert.ok(warning, "the deprecation warning must not be empty");
  assert.match(warning, /LNKZ_MCP_SCOPES is deprecated; rename it to MAGENTIC_SCOPES\./);
});

test("every renamed setting maps a MAGENTIC_ name to an LNKZ_ name", () => {
  const entries = Object.entries(renamedSettings());
  assert.ok(entries.length > 0);
  for (const [current, old] of entries) {
    assert.ok(current.startsWith("MAGENTIC_"), `${current} should be a MAGENTIC_ name`);
    assert.ok(old.startsWith("LNKZ_"), `${old} should be an LNKZ_ name`);
  }
});

test("the relay's own settings are not renamed", () => {
  // LNKZ_BASE_URL and LNKZ_API_KEY address the relay this server talks to,
  // and LNKZ_MCP_TARGETS is configured there. They belong to LNKZ.
  const old = Object.values(renamedSettings());
  assert.equal(old.includes("LNKZ_BASE_URL"), false);
  assert.equal(old.includes("LNKZ_API_KEY"), false);
  assert.equal(old.includes("LNKZ_MCP_TARGETS"), false);
});
