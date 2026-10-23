import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { deploymentReport, type DeploymentInputs, type DeploymentReport } from "../workbench/deployment-report.js";
import { deploymentPage } from "../workbench/deployment-view.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";
import { memoryModelStudio, type ModelStudio, type StudioCommand } from "../workbench/studio/engine.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "../workbench/server.js";

function inputs(): DeploymentInputs {
  const pipeline = memoryPipelines().snapshot("one");
  pipeline.config.stages = [{ ...pipeline.config.stages[0]!, bot: { kind: "manual", maxSteps: 2, timeoutSeconds: 30 } }];
  return { workspaceId: "one", mode: "local", requiredApprovals: 2, pipeline,
    scheduler: true, modelConfigured: true, repositoryWorker: true, repositoryAttached: true };
}
function approved(studio: ModelStudio) {
  const run = (command: StudioCommand) => studio.execute("one", "author", ["author"], command, 2);
  const project = run({ action: "create_project", name: "Docs", purpose: "Answer from references.", recipeId: "coding-assistant" }).projects[0]!;
  const text = Array.from({ length: 50 }, (_, i) => JSON.stringify({ messages: [
    { role: "user", content: "Explain module " + i }, { role: "assistant", content: "Module " + i + " follows the reference." },
  ] })).join("\n");
  const dataset = run({ action: "register_dataset", projectId: project.id, name: "References", source: { kind: "inline", text } }).datasets[0]!;
  run({ action: "validate_dataset", datasetId: dataset.id });
  const config = run({ action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" }).configs[0]!;
  const job = run({ action: "create_job", configId: config.id }).jobs[0]!;
  run({ action: "record_job", jobId: job.id });
  const evaluation = run({ action: "run_evaluation", jobId: job.id }).evaluations[0]!;
  const release = run({ action: "request_release", evaluationId: evaluation.id }).releases[0]!;
  for (const actor of ["reviewer-one", "reviewer-two"]) studio.execute("one", actor, ["approver"],
    { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }, 2);
  return run({ action: "assign_profile", releaseId: release.id, name: "Documentation assistant" }).profiles[0]!;
}

test("configuration checks never certify deployment, provider health or reviewer coverage", () => {
  const input = inputs();
  input.modelConfigured = false;
  const report = deploymentReport(input);
  assert.equal(report.status, "needs-validation");
  assert.equal(report.stages[0]!.execution, "manual");
  assert.match(report.remainingChecks.join(" "), /No provider was contacted/);
  assert.match(report.remainingChecks.join(" "), /Team coverage has not been verified/);
  assert.match(report.remainingChecks.join(" "), /in memory/);
  delete input.pipeline;
  assert.equal(deploymentReport(input).status, "blocked");
});

test("company repository execution remains blocked even if worker flags are present", () => {
  const input = inputs();
  input.pipeline!.config.stages[0]!.bot!.kind = "planner";
  input.mode = "company";
  assert.match(deploymentReport(input).stages[0]!.blockers.join(" "), /isolated worker/);
  input.mode = "local"; input.repositoryAttached = false;
  assert.match(deploymentReport(input).stages[0]!.blockers.join(" "), /Attach a repository/);
  input.repositoryAttached = true; input.modelConfigured = false;
  assert.match(deploymentReport(input).stages[0]!.blockers.join(" "), /model connection/);
});

test("a report checks approved releases afresh and never resolves a foreign workspace profile", () => {
  const studio = memoryModelStudio();
  const profile = approved(studio);
  const input = inputs(); input.studio = studio;
  input.pipeline!.config.stages[0]!.assistantId = profile.id;
  const report = deploymentReport(input);
  assert.equal(report.status, "needs-validation");
  assert.equal(report.stages[0]!.release!.artifact, "development");
  assert.match(report.remainingChecks.join(" "), /no trained weights/);
  assert.equal(deploymentReport({ ...input, workspaceId: "two" }).status, "blocked");
  studio.execute("one", "admin", ["admin"], { action: "retire_release", releaseId: profile.releaseId, note: "Replaced" }, 2);
  assert.equal(deploymentReport(input).status, "blocked");
  assert.equal(deploymentReport(input).stages[0]!.release, undefined);
});

test("reports fingerprint workflow changes but omit instructions, context and raw resolver errors", () => {
  const input = inputs();
  input.pipeline!.config.stages[0]!.instructions = "private-instructions-marker";
  input.pipeline!.config.stages[0]!.context = "private-document-marker";
  const first = deploymentReport(input);
  input.pipeline!.config.stages[0]!.instructions += " revised";
  assert.notEqual(first.workflow!.hash, deploymentReport(input).workflow!.hash);
  input.pipeline!.config.stages[0]!.assistantId = "00000000-0000-4000-8000-000000000001";
  input.studio = { resolveProfile() { throw new Error("secret-error-marker"); } };
  const json = JSON.stringify(deploymentReport(input));
  assert.doesNotMatch(json, /private-instructions-marker|private-document-marker|secret-error-marker/);
  assert.match(json, /could not be verified/);
});

test("the deployment view escapes workspace content and exposes working stage links", () => {
  const input = inputs();
  input.pipeline!.config.name = "<img onerror=alert(1)>";
  input.pipeline!.config.stages[0]!.name = "<script>bad</script>";
  const html = deploymentPage(deploymentReport(input)).body;
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(html.includes('#/workflows/' + input.pipeline!.config.stages[0]!.id));
  assert.match(html, /not a deployment/);
  assert.match(html, /Needs live validation/);
});

test("the report API checks membership, scopes reads and refreshes retirement without modifying workflows", async t => {
  const studio = memoryModelStudio();
  const profile = approved(studio);
  const pipelines = memoryPipelines(assistantGuards(studioAssistants(studio)));
  const config = inputs().pipeline!.config;
  config.stages[0]!.assistantId = profile.id;
  pipelines.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const before = pipelines.snapshot("one");
  const server = createWorkbenchServer({
    assets: new Map(), studio, pipelines,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW, members: memoryMembers([
      { workspaceId: "one", actor: "member", roles: ["author"] },
      { workspaceId: "two", actor: "foreign", roles: ["author"] },
    ]) },
    authenticate: async request => {
      const actor = request.headers.authorization?.replace("Bearer ", "");
      return actor ? { workspaceId: actor === "foreign" ? "two" : "one", actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port + "/api/deployment-report";
  const get = (actor: string, suffix = "") => fetch(url + suffix, { headers: { Authorization: "Bearer " + actor } });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await get("removed")).status, 403);
  assert.equal((await get("member", "?workspaceId=two")).status, 400);
  const response = await get("member"); assert.equal(response.status, 200);
  const first = await response.json() as DeploymentReport;
  assert.equal(first.workspaceId, "one");
  assert.equal(first.stages[0]!.release!.id, profile.releaseId);
  const other = await (await get("foreign")).json() as DeploymentReport;
  assert.equal(other.workspaceId, "two");
  assert.ok(other.stages.every(stage => stage.release?.id !== profile.releaseId));
  studio.execute("one", "admin", ["admin"], { action: "retire_release", releaseId: profile.releaseId, note: "Withdraw" }, 2);
  const later = await (await get("member")).json() as DeploymentReport;
  assert.equal(later.stages[0]!.release, undefined);
  assert.match(later.stages[0]!.blockers.join(" "), /could not be verified/);
  assert.deepEqual(pipelines.snapshot("one"), before);
});
