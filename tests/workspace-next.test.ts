import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { deploymentReport } from "../workbench/deployment-report.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { workspaceNextAction, workspaceNextPanel } from "../workbench/workspace-next.js";

function snapshot(): WorkbenchSnapshot {
  const pipelines = memoryPipelines();
  const pipeline = pipelines.snapshot("one");
  pipeline.config.stages = [{ ...pipeline.config.stages[0]!, approval: true,
    bot: { kind: "planner", maxSteps: 2, timeoutSeconds: 30 } }];
  const deployment = deploymentReport({ workspaceId: "one", mode: "local", requiredApprovals: 2,
    pipeline, scheduler: true, modelConfigured: true, repositoryWorker: true, repositoryAttached: true });
  return { workspaceId: "one", actor: "owner", roles: ["admin"], canAuthor: true,
    demo: false, workflow: DEFAULT_WORKFLOW, records: [], audit: [], mcp: { agents: [], withheld: [] },
    chat: { configured: true }, pipelines: pipeline, deployment };
}

function withRun() {
  const data = snapshot();
  const engine = memoryPipelines();
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config: data.pipelines!.config }, 2);
  data.pipelines = engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Documentation task", brief: "Review the reference." }, 2);
  return data;
}

test("next action resumes an existing run even when the current configuration changed", () => {
  const data = withRun();
  const run = data.pipelines!.runs[0]!;
  const before = structuredClone(data);
  assert.equal(workspaceNextAction(data).kind, "resume");
  assert.equal(workspaceNextAction(data).href, "#/tasks/" + run.id);
  assert.deepEqual(data, before);
  for (const state of ["paused", "blocked"] as const) {
    run.status = state;
    assert.equal(workspaceNextAction(data).kind, "resume");
  }
});

test("independent review is suggested only to an eligible reviewer", () => {
  const data = withRun();
  const run = data.pipelines!.runs[0]!;
  run.stages[0]!.status = "awaiting_review";
  run.stages[0]!.outputBy = "writer";
  assert.equal(workspaceNextAction(data).kind, "waiting");
  data.actor = "reviewer"; data.roles = ["approver"]; data.canAuthor = false;
  assert.equal(workspaceNextAction(data).kind, "review");
  run.stages[0]!.approvals.push("reviewer");
  assert.equal(workspaceNextAction(data).kind, "waiting");
  data.actor = "writer";
  assert.equal(workspaceNextAction(data).kind, "waiting");
});

test("foreign runs and reports cannot direct workspace actions", () => {
  const data = withRun();
  data.pipelines!.runs[0]!.workspaceId = "two";
  data.deployment!.workspaceId = "two";
  const next = workspaceNextAction(data);
  assert.equal(next.kind, "setup");
  assert.equal(next.href, "#/workspace?tab=readiness");
  assert.doesNotMatch(workspaceNextPanel(data), /Documentation task/);
});

test("new work requires current configuration checks and surfaces stage blockers", () => {
  const data = snapshot();
  assert.equal(workspaceNextAction(data).kind, "test");
  assert.match(workspaceNextAction(data).detail, /Test the actual model/);
  data.deployment!.workflow!.version++;
  assert.equal(workspaceNextAction(data).kind, "setup");
  data.deployment!.workflow!.version--;
  data.deployment!.stages[0]!.blockers = ["The assistant release could not be verified."];
  assert.equal(workspaceNextAction(data).kind, "blocked");
  assert.equal(workspaceNextAction(data).href, "#/workflows/" + data.pipelines!.config.stages[0]!.id);
  data.roles = ["author"];
  assert.equal(workspaceNextAction(data).action, "View stage blocker");
  delete data.deployment;
  assert.equal(workspaceNextAction(data).kind, "setup");
  delete data.pipelines;
  assert.equal(workspaceNextAction(data).kind, "blocked");
});

test("review-only users never get setup or execution actions", () => {
  const data = snapshot();
  data.roles = ["approver"]; data.canAuthor = false;
  assert.equal(workspaceNextAction(data).kind, "waiting");
  assert.equal(workspaceNextAction(data).action, "View team work");
});

test("manual workflows suggest assignment to admins without requiring authors to configure agents", () => {
  const data = snapshot();
  data.pipelines!.config.stages[0]!.bot!.kind = "manual";
  assert.equal(workspaceNextAction(data).href, "#/canvas");
  data.roles = ["author"];
  assert.equal(workspaceNextAction(data).href, "#/tasks/new");
});

test("completed runs are not resumed and workspace content is escaped", () => {
  const data = withRun();
  data.pipelines!.runs[0]!.title = '<img src=x onerror="bad()">';
  assert.match(workspaceNextPanel(data), /&lt;img/);
  assert.doesNotMatch(workspaceNextPanel(data), /<img/);
  for (const state of ["complete", "cancelled"] as const) {
    data.pipelines!.runs[0]!.status = state;
    assert.notEqual(workspaceNextAction(data).kind, "resume");
  }
});
