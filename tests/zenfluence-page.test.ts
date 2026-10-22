import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { connectionState, zenfluencePage } from "../workbench/zenfluence-view.js";
import { createZenfluenceDirectory, zenfluenceConfigSchema } from "../workbench/zenfluence.js";

const connection = { workspaceId: "workspace", site: "https://example.atlassian.net", project: "KAN", spaceId: "123",
  emailSetting: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", tokenSetting: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY" };

test("Zenfluence accepts the local workspace name as well as a company UUID", () => {
  assert.equal(zenfluenceConfigSchema.safeParse({ connections: [connection] }).success, true);
  assert.equal(zenfluenceConfigSchema.safeParse({ connections: [{ ...connection, workspaceId: randomUUID() }] }).success, true);
  for (const bad of ["", "../x", "a b", "x".repeat(101)]) {
    assert.equal(zenfluenceConfigSchema.safeParse({ connections: [{ ...connection, workspaceId: bad }] }).success, false, bad);
  }
});

test("Zenfluence summary names the missing settings and never their values", () => {
  const directory = createZenfluenceDirectory({ connections: [connection] }, name => name.includes("EMAIL") ? "person@example.invalid" : undefined);
  const summary = directory("workspace")!.summary();
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.settings, { email: { name: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", configured: true }, token: { name: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY", configured: false } });
  assert.doesNotMatch(JSON.stringify(summary), /example\.invalid/);
});

test("Zenfluence page shows one state at a time with the step that leaves it", () => {
  // Not configured: the workspace id and the file setting are the next step.
  const setup = zenfluencePage({ configured: false, workspaceId: "workspace" }, undefined, "", [], false).body;
  assert.equal(connectionState({ configured: false }, ""), "setup");
  assert.match(setup, /Not connected/); assert.match(setup, /<code>workspace<\/code>/); assert.match(setup, /MAGENTIC_ZENFLUENCE_FILE/);
  assert.doesNotMatch(setup, /id="zenfluence-read"/);
  // Configured without credentials: the missing setting is named.
  const credentials = zenfluencePage({ configured: true, ready: false, site: "https://example.atlassian.net", project: "KAN", spaceId: "123",
    settings: { email: { name: "MAGENTIC_ATLASSIAN_EMAIL_COMPANY", configured: true }, token: { name: "MAGENTIC_ATLASSIAN_TOKEN_COMPANY", configured: false } } }, undefined, "", [], false).body;
  assert.match(credentials, /Credentials needed/); assert.match(credentials, /MAGENTIC_ATLASSIAN_TOKEN_COMPANY/); assert.doesNotMatch(credentials, /MAGENTIC_ATLASSIAN_EMAIL_COMPANY/);
  assert.doesNotMatch(credentials, /id="zenfluence-read"/);
  // Ready: the read form is offered and nothing claims a write.
  const ready = zenfluencePage({ configured: true, ready: true, site: "https://example.atlassian.net", project: "KAN", spaceId: "123" }, undefined, "", [], false).body;
  assert.match(ready, /status-ok/); assert.match(ready, /id="zenfluence-read"/); assert.match(ready, /Read only/);
  // Error: announced, with the refresh control still available.
  const failed = zenfluencePage(undefined, undefined, "Atlassian read failed (HTTP 502).", [], false).body;
  assert.match(failed, /role="alert"/); assert.match(failed, /HTTP 502/); assert.match(failed, /data-zenfluence-refresh/);
  // Loading: no form, no claim.
  assert.match(zenfluencePage(undefined, undefined, "", [], true).body, /Checking/);
});

test("Zenfluence source panel attaches only when a workflow is open", () => {
  const source = { kind: "confluence" as const, id: "456", title: "Runbook", text: "Approved documentation", revision: "3",
    url: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=456", contentHash: "0".repeat(64), retrievedAt: new Date().toISOString(), truncated: true };
  const summary = { configured: true, ready: true, project: "KAN" };
  const without = zenfluencePage(summary, source, "", [], false).body;
  assert.match(without, /Start a workflow to attach/); assert.doesNotMatch(without, /id="zenfluence-attach"/); assert.match(without, /truncated at 4,500/);
  const run = { id: randomUUID(), title: "Release notes", status: "active", revision: 1 } as unknown as Parameters<typeof zenfluencePage>[3][number];
  const withRun = zenfluencePage(summary, source, "", [run], false).body;
  assert.match(withRun, /id="zenfluence-attach"/); assert.match(withRun, /Release notes/);
});
