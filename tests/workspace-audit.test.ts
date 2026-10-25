import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { buildWorkspaceAudit, renderWorkspaceAudit, verifyAny, verifyWorkspaceAudit, type WorkspaceAudit } from "../workbench/audit-package.js";
import { memoryPipelines, type PipelineRun } from "../workbench/pipeline.js";
import { activityPage } from "../workbench/review-views.js";
import { createWorkbenchServer } from "../workbench/server.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

/**
 * The workspace audit is every run's package plus the definition log under
 * one bundle hash, and the Activity page shows run events beside definition
 * events so the audit trail is the whole workspace.
 */

const definitionEvent = { workspaceId: "one", agentName: "docs-agent", action: "approved" as const, actor: "sam.reviewer", at: "2026-10-20T10:00:00.000Z", definitionHash: "a".repeat(64), note: "Reviewed the template." };

function twoRuns(): { runs: PipelineRun[]; engine: ReturnType<typeof memoryPipelines> } {
  const engine = memoryPipelines();
  const first = engine.execute("one", "owner", ["admin", "author"], { action: "start", requestId: randomUUID(), title: "Access request answer", brief: "Use the SOP." }, 1).runs[0]!;
  engine.execute("one", "owner", ["admin", "author"], { action: "complete", runId: first.id, expectedRevision: first.revision, note: "Intake recorded." }, 1);
  engine.execute("one", "owner", ["admin", "author"], { action: "start", requestId: randomUUID(), title: "Onboarding checklist", brief: "Draft it." }, 1);
  return { runs: engine.snapshot("one").runs, engine };
}

test("the bundle carries every run and the definition log, verifies clean, and names a tampered run", () => {
  const { runs } = twoRuns();
  const bundle = buildWorkspaceAudit(runs, [definitionEvent], { workspaceId: "one", actor: "owner", now: new Date("2026-10-25T00:00:00Z"), handling: "CUI" });
  assert.equal(bundle.runs.length, 2);
  assert.equal(bundle.runs[0]!.run.title, "Access request answer");
  assert.equal(bundle.runs[0]!.handling, "CUI");
  assert.deepEqual(bundle.definitionEvents[0], { agentName: "docs-agent", action: "approved", actor: "sam.reviewer", at: definitionEvent.at, definitionHash: definitionEvent.definitionHash, note: "Reviewed the template." });
  const clean = verifyWorkspaceAudit(bundle);
  assert.deepEqual(clean.problems, []);
  assert.match(clean.summary, /Workspace one: 2 runs/);
  assert.equal(verifyAny(bundle).ok, true);
  assert.equal(verifyAny(bundle.runs[0]).ok, true);

  const tampered = structuredClone(bundle) as WorkspaceAudit; tampered.runs[0]!.stages[0]!.output = "Intake recorded, then changed.";
  const result = verifyWorkspaceAudit(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => /bundle hash does not match/.test(problem)));
  assert.ok(result.problems.some(problem => /^Run Access request answer: Stage 1 .*output text does not match/.test(problem)));

  const foreign = structuredClone(bundle) as WorkspaceAudit; foreign.runs[1]!.workspaceId = "two";
  assert.ok(verifyWorkspaceAudit(foreign).problems.some(problem => /belongs to workspace two/.test(problem)));
  assert.match(verifyAny({ kind: "magentic-workspace-audit" }).problems[0]!, /Not a workspace audit/);
});

test("the readable bundle lists runs, definition events and each run's record", () => {
  const { runs } = twoRuns();
  const text = renderWorkspaceAudit(buildWorkspaceAudit(runs, [definitionEvent], { workspaceId: "one", actor: "owner", handling: "CUI" }));
  assert.ok(text.startsWith("CUI\n\n# Workspace audit: one"));
  assert.match(text, /\| Access request answer \| running \|/);
  assert.match(text, /approved docs-agent · hash a{16}/);
  assert.match(text, /## Audit package: Onboarding checklist/);
  assert.ok(text.trimEnd().endsWith("CUI"));
});

test("the Activity page shows run events with links and offers the workspace export", () => {
  const { runs } = twoRuns();
  const snapshot = { workspaceId: "one", actor: "owner", roles: ["admin"], canAuthor: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [definitionEvent], demo: false,
    pipelines: { config: runs[0]!.config, version: 1, runs, storage: "memory", jiraDelivery: "preview" } } as unknown as WorkbenchSnapshot;
  const page = activityPage(snapshot);
  assert.match(page.body, /started run <strong>Onboarding checklist<\/strong>/);
  assert.match(page.body, /recorded handoff on <strong>Access request answer<\/strong>/);
  assert.match(page.body, new RegExp(`href="#/desk/${runs[0]!.id}"`));
  assert.match(page.body, /approved agent <strong>docs-agent<\/strong>/);
  assert.match(page.actions!, /scope=workspace&amp;format=markdown" download/);
  assert.match(page.actions!, /scope=workspace&amp;format=json" download/);
  // A project filter keeps the page about Model Studio only.
  const filtered = activityPage(snapshot, "project-x");
  assert.doesNotMatch(filtered.body, /Onboarding checklist/);
  assert.equal(filtered.actions, undefined);
});

test("the server serves the workspace bundle to members, with the definition log and the marking", async t => {
  const { engine } = twoRuns();
  const audit = memoryAudit([definitionEvent]);
  const context = { store: memoryStore(), audit, members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["admin"] }]) };
  const server = createWorkbenchServer({ context, pipelines: engine, assets: new Map(), handling: "CUI//SP-PRVCY",
    authenticate: async request => request.headers.authorization === "owner" ? { workspaceId: "one", actor: "owner" } : undefined });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const get = (actor: string, query: string) => fetch(`http://127.0.0.1:${address.port}/api/audit-package?${query}`, { headers: { Authorization: actor } });
  assert.equal((await get("", "scope=workspace")).status, 401);
  const json = await get("owner", "scope=workspace");
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-disposition")!, /workspace-audit-one\.json/);
  const bundle = await json.json() as WorkspaceAudit;
  assert.equal(bundle.runs.length, 2); assert.equal(bundle.definitionEvents.length, 1); assert.equal(bundle.handling, "CUI//SP-PRVCY");
  assert.equal(verifyAny(bundle).ok, true);
  const markdown = await (await get("owner", "scope=workspace&format=markdown")).text();
  assert.match(markdown, /^CUI\/\/SP-PRVCY\n\n# Workspace audit: one/);
});
