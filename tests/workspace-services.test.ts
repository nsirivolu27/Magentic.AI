import assert from "node:assert/strict";
import test from "node:test";
import { workspaceConsole, workspaceTab } from "../workbench/workspace-console.js";
import { workspaceTools, workspaceWorkflow, workspaceReadiness, workspaceAccess, workspaceServiceView } from "../workbench/workspace-services.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { deploymentReport } from "../workbench/deployment-report.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { stageNodes } from "../workbench/units.js";

function snapshot(): WorkbenchSnapshot {
  return { workspaceId: "one", actor: "operator", roles: ["admin"], canAuthor: true, demo: false,
    workflow: DEFAULT_WORKFLOW, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: false },
    pipelines: memoryPipelines().snapshot("one"), studio: memoryModelStudio().snapshot("one") };
}

test("console deep links select one view, retain controls context and reject unknown tabs", () => {
  const s = snapshot();
  const query = new URLSearchParams("tab=tools&controls=slack");
  const html = workspaceConsole(s, false, query);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /href="#\/workspace\?tab=tools" aria-current="page">Tools/);
  assert.match(html, /href="#\/workspace\?tab=tools">Close controls/);
  assert.equal(workspaceTab(new URLSearchParams("tab=<script>")), "work");
  assert.match(workspaceServiceView(s, false, new URLSearchParams("tab=unknown")), /id="operations-queue"/);
  assert.doesNotMatch(workspaceServiceView(s, false, query), /id="operations-queue"/);
});

test("tool search filters services and escapes user supplied search text", () => {
  const html = workspaceTools("  mCp  ");
  assert.match(html, /MCP tools/);
  assert.doesNotMatch(html, /class="team-service" href="#\/studio"/);
  assert.match(workspaceTools('"><img src=x>'), /&quot;&gt;&lt;img/);
  assert.doesNotMatch(workspaceTools('"><img src=x>'), /<img/);
  assert.match(workspaceTools("no-such-tool"), /No tools match/);
});

test("workflow overview uses the approved release model and never leaks a foreign assistant", () => {
  const s = snapshot();
  const stage = s.pipelines!.config.stages[0]!;
  stage.assistantId = "00000000-0000-4000-8000-000000000001";
  stage.model = "unapproved-preference";
  s.studio!.profiles.push({ id: stage.assistantId, workspaceId: "another", name: "Foreign profile",
    releaseId: "release", instructions: "private", status: "active", createdBy: "owner", createdAt: "now", updatedAt: "now" });
  s.deployment = deploymentReport({ workspaceId: "one", mode: "local", pipeline: s.pipelines!,
    requiredApprovals: 2, scheduler: true, modelConfigured: true, repositoryWorker: true, repositoryAttached: true });
  const reportStage = s.deployment.stages[0]!;
  reportStage.model = "approved-model";
  reportStage.release = { id: "release", version: 1, hash: "hash", artifact: "development" };
  let html = workspaceWorkflow(s);
  assert.match(html, /approved-model/);
  assert.doesNotMatch(html, /unapproved-preference|Foreign profile/);
  delete reportStage.release;
  html = workspaceWorkflow(s);
  assert.match(html, /Inspect approved release/);
  assert.doesNotMatch(html, /approved-model|unapproved-preference/);
});

test("workflow settings expose assignment controls only to administrators", () => {
  const s = snapshot();
  const stage = s.pipelines!.config.stages[0]!;
  stage.name = "<img src=x>";
  stage.bot = { kind: "planner", maxSteps: 3, timeoutSeconds: 45 };
  stage.approval = true;
  let html = workspaceWorkflow(s);
  assert.match(html, /3 steps · 45s/);
  assert.match(html, /Review required/);
  assert.match(html, /Configure/);
  assert.match(html, /&lt;img src=x&gt;/);
  s.roles = ["approver"];
  html = workspaceWorkflow(s);
  assert.match(html, /View canvas/);
  assert.doesNotMatch(html, />Configure<|>Open canvas</);
});

test("readiness distinguishes missing reports, blockers and unverified live operation", () => {
  const s = snapshot();
  assert.match(workspaceReadiness(s), /Readiness unavailable/);
  s.deployment = deploymentReport({ workspaceId: "one", mode: "local", pipeline: s.pipelines!,
    requiredApprovals: 2, scheduler: true, modelConfigured: true, repositoryWorker: true, repositoryAttached: true });
  assert.match(workspaceReadiness(s), /Needs live validation/);
  s.deployment.stages[0]!.blockers = ["<model unavailable>"];
  const html = workspaceReadiness(s);
  assert.match(html, /1 blocker\(s\)/);
  assert.match(html, /&lt;model unavailable&gt;/);
  assert.match(html, /data-deployment-refresh/);
  assert.match(html, /does not provision cloud infrastructure/);
});

test("access view distinguishes company membership from a local owner", () => {
  const s = snapshot();
  s.actor = "<operator>";
  assert.match(workspaceAccess(s, true), /href="\/companies"/);
  const local = workspaceAccess(s, false);
  assert.doesNotMatch(local, /href="\/companies"/);
  assert.match(local, /company sign-in is not active/);
  assert.match(local, /&lt;operator&gt;/);
  assert.match(local, /Reviewer coverage has not been verified/);
});

test("repository agents keep their execution label in the stage editor and workflow map", () => {
  const s = snapshot();
  const stage = s.pipelines!.config.stages[0]!;
  stage.bot = { kind: "planner", maxSteps: 3, timeoutSeconds: 45 };
  const html = workflowPage(s, stage.id).body;
  assert.match(html, /Repository agent/);
  assert.doesNotMatch(html, /Done by hand/);
  assert.match(stageNodes(s)[0]!.note, /Repository agent/);
  assert.equal(stageNodes(s)[0]!.state, "pending");
  stage.bot.kind = "manual";
  assert.match(workflowPage(s, stage.id).body, /Done by hand/);
});

