import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { buildAuditPackage, renderAuditPackage, verifyAuditPackage } from "../workbench/audit-package.js";
import { HANDLING_SETTING, handlingBannerHtml, handlingMarkingSchema, loadHandlingMarking } from "../workbench/handling-marking.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";

/**
 * A handling marking set by the operator reaches every page snapshot and
 * every audit package, and an invalid one stops the server instead of
 * showing something wrong.
 */

test("the setting is read once, validated, and absent means no banner", () => {
  assert.equal(loadHandlingMarking(() => undefined), undefined);
  assert.equal(loadHandlingMarking(() => "   "), undefined);
  const names: string[] = [];
  assert.equal(loadHandlingMarking(name => { names.push(name); return "CUI//SP-PRVCY"; }), "CUI//SP-PRVCY");
  assert.deepEqual(names, [HANDLING_SETTING]);
  assert.equal(loadHandlingMarking(() => " CUI "), "CUI");
  for (const bad of ["cui", "CUI<script>", "C".repeat(81), "/CUI"]) assert.throws(() => loadHandlingMarking(() => bad), /MAGENTIC_HANDLING_MARKING/, bad);
  assert.equal(handlingMarkingSchema.safeParse("CUI//SP-PRVCY/LIMITED DISSEM").success, true);
});

test("the banner escapes its text and names its position", () => {
  const html = handlingBannerHtml("CUI (TEST)", "bottom");
  assert.match(html, /class="handling-banner"/);
  assert.match(html, /aria-label="Handling marking, bottom of page"/);
  assert.match(html, /<span>CUI \(TEST\)<\/span>/);
  assert.match(handlingBannerHtml("A&B", "top"), /A&amp;B/);
});

test("the marking reaches the workspace snapshot and the audit package in both forms", async t => {
  const engine = memoryPipelines();
  const run = engine.execute("one", "owner", ["admin", "author"], { action: "start", requestId: randomUUID(), title: "Marked work", brief: "Handle with care." }, 1).runs[0]!;
  const context = { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["admin"] }]) };
  const server = createWorkbenchServer({ context, pipelines: engine, assets: new Map(), handling: "CUI//SP-PRVCY",
    authenticate: async request => request.headers.authorization === "owner" ? { workspaceId: "one", actor: "owner" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const get = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: "owner" } });
  const snapshot = await (await get("/api/workspace")).json() as { handling?: string };
  assert.equal(snapshot.handling, "CUI//SP-PRVCY");
  const pkg = await (await get(`/api/audit-package?run=${run.id}`)).json() as { handling?: string };
  assert.equal(pkg.handling, "CUI//SP-PRVCY");
  assert.equal(verifyAuditPackage(pkg).ok, true);
  const text = await (await get(`/api/audit-package?run=${run.id}&format=markdown`)).text();
  assert.ok(text.startsWith("CUI//SP-PRVCY\n\n# Audit package"));
  assert.ok(text.trimEnd().endsWith("CUI//SP-PRVCY"));
  // A package produced without a marking carries none, and a marking added afterwards breaks the hash.
  const plain = buildAuditPackage(run, { workspaceId: "one", actor: "owner" });
  assert.equal(plain.handling, undefined);
  assert.doesNotMatch(renderAuditPackage(plain), /CUI/);
  assert.equal(verifyAuditPackage({ ...plain, handling: "CUI" }).ok, false);
});

test("without a marking the snapshot carries no handling field", async t => {
  const context = { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["admin"] }]) };
  const server = createWorkbenchServer({ context, assets: new Map(), authenticate: async () => ({ workspaceId: "one", actor: "owner" }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const snapshot = await (await fetch(`http://127.0.0.1:${address.port}/api/workspace`)).json() as Record<string, unknown>;
  assert.equal("handling" in snapshot, false);
});
