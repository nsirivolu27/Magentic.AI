import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { buildAuditPackage, canonical, renderAuditPackage, verifyAuditPackage, type AuditPackage } from "../workbench/audit-package.js";
import { outputReview } from "../workbench/output-review.js";
import { memoryPipelines, type PipelineRun } from "../workbench/pipeline.js";
import { createWorkbenchServer } from "../workbench/server.js";

/**
 * An audit package is one run's chain of custody as a file. It must carry
 * every hash the run carries, verify clean when untouched, and name exactly
 * what changed when it was edited.
 */

function signedRun(): PipelineRun {
  const engine = memoryPipelines();
  const start = engine.execute("one", "owner", ["admin", "author"], { action: "start", requestId: randomUUID(), title: "Accessible service", brief: "Improve the flow.",
    materials: [{ id: randomUUID(), title: "Service requirements", content: "Every page must work with a keyboard." }] }, 1);
  let run = start.runs[0]!;
  // Walk the default workflow to its first review gate, then sign it as an independent reviewer.
  while (run.stages[run.current]!.status === "active") {
    run = engine.execute("one", "owner", ["admin", "author"], { action: "complete", runId: run.id, expectedRevision: run.revision, note: `Handoff for ${run.config.stages[run.current]!.name}: three user groups, one blocking defect.` }, 1).runs[0]!;
  }
  assert.equal(run.stages[run.current]!.status, "awaiting_review");
  gated = run.current;
  return engine.execute("one", "reviewer", ["approver"], { action: "approve", runId: run.id, expectedRevision: run.revision }, 1).runs[0]!;
}
let gated = 0;

test("a package carries every hash of the run and verifies clean", () => {
  const run = signedRun();
  const pkg = buildAuditPackage(run, { workspaceId: "one", actor: "owner", now: new Date("2026-10-22T00:00:00Z") });
  assert.equal(pkg.kind, "magentic-audit-package");
  assert.equal(pkg.stages[0]!.outputHash, run.stages[0]!.outputHash);
  assert.match(pkg.materials[0]!.contentHash, /^[0-9a-f]{64}$/);
  assert.match(pkg.packageHash, /^[0-9a-f]{64}$/);
  const result = verifyAuditPackage(pkg);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.match(result.summary, /Accessible service: \d+ stages, 1 signed/);
  // The same content always produces the same hash, whatever the key order.
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(pkg).reverse()))) as AuditPackage;
  assert.equal(verifyAuditPackage(reordered).ok, true);
});

test("every edit after the fact is named: output, draft, reference, signer, package", () => {
  const run = signedRun();
  const pkg = buildAuditPackage(run, { workspaceId: "one", actor: "owner" });
  assert.deepEqual(pkg.stages[gated]!.approvals, ["reviewer"]);

  const editedOutput = structuredClone(pkg); editedOutput.stages[0]!.output += " (changed)";
  const outputResult = verifyAuditPackage(editedOutput);
  assert.equal(outputResult.ok, false);
  assert.ok(outputResult.problems.some(problem => /Stage 1 .*output text does not match/.test(problem)));
  assert.ok(outputResult.problems.some(problem => /package hash does not match/.test(problem)));

  const editedReference = structuredClone(pkg); editedReference.materials[0]!.content = "Something else.";
  assert.ok(verifyAuditPackage(editedReference).problems.some(problem => /Reference 1 \(Service requirements\)/.test(problem)));

  const ownerSigned = structuredClone(pkg); ownerSigned.stages[gated]!.approvals = ["owner"];
  assert.ok(verifyAuditPackage(ownerSigned).problems.some(problem => /run owner owner appears as a signer/.test(problem)));
  const droppedEvent = structuredClone(pkg); droppedEvent.events = droppedEvent.events.filter(event => event.action !== "approved");
  assert.ok(verifyAuditPackage(droppedEvent).problems.some(problem => /no approval event names the output hash/.test(problem)));

  assert.match(verifyAuditPackage({ kind: "other" }).problems[0]!, /Not an audit package/);
  assert.match(verifyAuditPackage("text").problems[0]!, /Not an audit package/);
});

test("the readable form carries the same facts and tells the reader how to verify", () => {
  const run = signedRun();
  const pkg = buildAuditPackage(run, { workspaceId: "one", actor: "owner" });
  const text = renderAuditPackage(pkg);
  assert.match(text, /^# Audit package: Accessible service/);
  assert.match(text, new RegExp(`hash ${pkg.stages[0]!.outputHash}`));
  assert.match(text, new RegExp(`Package hash ${pkg.packageHash}`));
  assert.match(text, /Service requirements.*hash [0-9a-f]{64}/);
  assert.match(text, /audit:verify/);
  assert.match(text, /Signed by: reviewer/);
});

test("the run page links to both forms and the server serves them to members only", async t => {
  const engine = memoryPipelines();
  const run = engine.execute("one", "owner", ["admin", "author"], { action: "start", requestId: randomUUID(), title: "Public service", brief: "Use the source." }, 1).runs[0]!;
  const page = outputReview({ run, phase: 0, actor: "owner", roles: ["admin"], where: "desk" });
  assert.match(page, new RegExp(`/api/audit-package\\?run=${run.id}&amp;format=markdown" download`));
  assert.match(page, /format=json" download/);

  const context = { store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["admin"] }, { workspaceId: "two", actor: "other", roles: ["author"] }]) };
  const server = createWorkbenchServer({ context, pipelines: engine, assets: new Map(), authenticate: async request => {
    if (request.headers.authorization === "owner") return { workspaceId: "one", actor: "owner" };
    if (request.headers.authorization === "other") return { workspaceId: "two", actor: "other" };
    return undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const get = (actor: string, query: string) => fetch(`http://127.0.0.1:${address.port}/api/audit-package?${query}`, { headers: { Authorization: actor } });
  assert.equal((await get("", `run=${run.id}`)).status, 401);
  assert.equal((await get("other", `run=${run.id}`)).status, 404);
  assert.equal((await get("owner", "run=missing")).status, 404);
  const json = await get("owner", `run=${run.id}`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-disposition")!, /attachment; filename="audit-package-.*\.json"/);
  assert.equal(verifyAuditPackage(await json.json()).ok, true);
  const markdown = await get("owner", `run=${run.id}&format=markdown`);
  assert.match(markdown.headers.get("content-type")!, /text\/markdown/);
  assert.match(await markdown.text(), /^# Audit package: Public service/);
});
