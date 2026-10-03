import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { recipeFor } from "../workbench/studio/recipes.js";
import { memoryPipelines, PipelineError } from "../workbench/pipeline.js";
import { assistantDirectory, assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";
import { applyWorkflowTemplate, WORKFLOW_TEMPLATES } from "../workbench/workflow-templates.js";
import { agenticUnits, runNodes, stageNodes } from "../workbench/units.js";
import { workflowPage } from "../workbench/workflow-view.js";
import { homeView } from "../workbench/home-view.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

/**
 * One customer story, end to end: a Salesforce consulting agency.
 *
 * The agency trains an assistant on its own case notes, in its own wording,
 * approves it, and staffs its delivery workflow with it. Every step below
 * goes through the same engines the pages use, so this file is both the
 * specification of the scenario and the proof that the pieces connect.
 */

const W = "northwind-agency";
type Roles = ("author" | "approver" | "admin")[];

/** The agency's case notes, as its consultants write them. Turned into chat records without changing the wording. */
const CASE_NOTES = [
  ["Acme", "leads from the web form land in the wrong queue", "Rebuilt the lead assignment rule to key on Country and Product Interest; added a catch all queue."],
  ["Globex", "opportunity stage names differ between two record types", "Aligned the sales process on both record types and migrated open opportunities with a data loader job."],
  ["Initech", "reps cannot see cases owned by other regions", "Changed the Case sharing setting to public read only and added a region based sharing rule."],
  ["Umbrella", "duplicate contacts after the marketing import", "Turned on duplicate rules for Contact with a matching rule on email and last name, then merged the existing pairs."],
];
function caseNote(index: number): string {
  const [client, ask, done] = CASE_NOTES[index % CASE_NOTES.length]!;
  return JSON.stringify({ messages: [
    { role: "user", content: `Client: ${client}. Ask ${index}: ${ask}.` },
    { role: "assistant", content: `What we did: ${done} Next step: confirm with the client in the weekly call.` },
  ] });
}
const notes = (count: number) => Array.from({ length: count }, (_, index) => caseNote(index)).join("\n");

/** The agency's own wording for how the assistant should talk. */
const AGENCY_VOICE = "You are Northwind Cloud's delivery assistant. Answer the way our consultants write: name the client, say what we did in numbered steps, and end with 'Next step:'. Never invent org configuration; ask for the org, the object and the requirement first. Never ask for or repeat credentials or client data.";

function agency() {
  const studio = memoryModelStudio({ now: () => "2026-09-28T09:00:00.000Z" });
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  return { studio, exec };
}

function snapshotWith(studio: StudioSnapshot, pipelines: WorkbenchSnapshot["pipelines"], actor = "priya", roles: Roles = ["author"]): WorkbenchSnapshot {
  return { studio, ...(pipelines ? { pipelines } : {}), workspaceId: W, actor, roles, workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, canAuthor: true,
    records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: true, provider: "ollama", model: "m" } };
}

test("the Salesforce delivery recipe is a use case an agency can start from", () => {
  const recipe = recipeFor("salesforce-delivery");
  assert.equal(recipe.title, "Salesforce delivery");
  assert.equal(recipe.datasetShape, "messages", "case notes are conversations: the ask and what was done");
  assert.equal(recipe.thresholds.secretHygiene, 1, "client credentials must never reach a release");
  assert.match(recipe.profileInstructions, /org configuration|Salesforce/);
  assert.match(recipe.profileInstructions, /credentials/);
});

test("the agency trains an assistant on its own case notes, in its own wording", () => {
  const { studio, exec } = agency();
  let s = exec("priya", ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery", purpose: "Answer delivery questions from our own implementation notes." });
  const project = s.projects[0]!;
  // A note that leaks a client login is caught by validation and blocks training.
  const leaked = notes(20) + "\n" + JSON.stringify({ messages: [{ role: "user", content: "Client: Acme. Ask: reset the integration user." }, { role: "assistant", content: "Done. Integration user security token: 8kLm2QpX9vRt4Yw7Zb1Nc3Hd, keep it handy." }] });
  s = exec("priya", ["author"], { action: "register_dataset", projectId: project.id, name: "Case notes, draft", source: { kind: "inline", text: leaked } });
  s = exec("priya", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  assert.equal(s.datasets[0]!.status, "rejected");
  assert.ok((s.datasets[0]!.validation?.secretFindings ?? 0) >= 1, "the leaked token is counted, never shown");
  assert.throws(() => exec("priya", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" }));
  // The clean notes pass, in the consultants' own format.
  s = exec("priya", ["author"], { action: "register_dataset", projectId: project.id, name: "Case notes, Q3", source: { kind: "inline", text: notes(80) } });
  s = exec("priya", ["author"], { action: "validate_dataset", datasetId: s.datasets[1]!.id });
  assert.equal(s.datasets[1]!.status, "valid");
  assert.equal(s.datasets[1]!.validation?.records, 80);
  s = exec("priya", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[1]!.id, provider: "local-dev" });
  s = exec("priya", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("priya", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  assert.equal(s.jobs[0]!.status, "succeeded");
  s = exec("priya", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  assert.equal(s.evaluations[0]!.passed, true, "80 clean, distinct notes clear the readiness suite");
  s = exec("priya", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  // Two other people sign; the requester cannot.
  assert.throws(() => exec("priya", ["author", "approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }));
  s = exec("marco", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("dana", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  assert.equal(s.releases[0]!.status, "approved");
  // The assistant speaks in the agency's wording, and the binding carries it.
  s = exec("priya", ["author"], { action: "assign_profile", name: "Northwind delivery bot", releaseId: release.id, instructions: AGENCY_VOICE });
  const profile = s.profiles[0]!;
  const binding = studioAssistants(studio)(W, profile.id);
  assert.equal(binding.instructions, AGENCY_VOICE);
  assert.equal(binding.model, "llama3.1:8b");
  assert.equal(binding.release, "v1 · Delivery assistant");
  assert.deepEqual(assistantDirectory(studio).list(W).map((item) => [item.name, item.usable]), [["Northwind delivery bot", true]]);
});

/** The story up to a live assistant, shared by the workflow tests below. */
function liveAgency() {
  const { studio, exec } = agency();
  let s = exec("priya", ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery", purpose: "Answer delivery questions." });
  const project = s.projects[0]!;
  s = exec("priya", ["author"], { action: "register_dataset", projectId: project.id, name: "Case notes, Q3", source: { kind: "inline", text: notes(80) } });
  s = exec("priya", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = exec("priya", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = exec("priya", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("priya", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("priya", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = exec("priya", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = exec("marco", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("dana", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("priya", ["author"], { action: "assign_profile", name: "Northwind delivery bot", releaseId: release.id, instructions: AGENCY_VOICE });
  const profile = s.profiles[0]!;
  const engine = memoryPipelines(assistantGuards(studioAssistants(studio)));
  return { studio, exec, engine, profile, release, snapshot: () => studio.snapshot(W) };
}

test("the Salesforce agency workflow template gates design, QA, UAT and go live, and the assistant staffs discovery and QA", () => {
  const { engine, profile, snapshot } = liveAgency();
  const template = WORKFLOW_TEMPLATES["salesforce-agency"]!;
  assert.equal(template.name, "Salesforce delivery");
  assert.equal(template.jira.project, "SFDC");
  assert.deepEqual(template.stages.map((stage) => stage.id), ["intake", "discovery", "design", "build", "qa", "uat", "golive"]);
  assert.deepEqual(template.stages.filter((stage) => stage.approval).map((stage) => stage.id), ["design", "qa", "uat", "golive"], "client facing handoffs need a second person");
  // Only an admin applies a template; it replaces the workflow definition, not open runs.
  assert.throws(() => applyWorkflowTemplate(engine, W, "priya", ["author"], "salesforce-agency", 2), PipelineError);
  let p = applyWorkflowTemplate(engine, W, "leo", ["admin"], "salesforce-agency", 2);
  assert.equal(p.config.name, "Salesforce delivery");
  assert.equal(p.version, 2);
  // Staff discovery and QA with the agency's assistant.
  const staffed = { ...p.config, stages: p.config.stages.map((stage) => ["discovery", "qa"].includes(stage.id) ? { ...stage, assistantId: profile.id } : stage) };
  p = engine.execute(W, "leo", ["admin"], { action: "configure", expectedVersion: p.version, config: staffed }, 2);
  const view = snapshotWith(snapshot(), p, "leo", ["admin"]);
  const nodes = stageNodes(view);
  assert.deepEqual(nodes.map((node) => `${node.id}:${node.state}`), ["intake:pending", "discovery:linked", "design:pending", "build:pending", "qa:linked", "uat:pending", "golive:pending"]);
  assert.equal(nodes[1]!.value, "Northwind delivery bot");
  assert.deepEqual(agenticUnits(view)[0]!.stages.map((stage) => stage.name), ["Discovery", "QA"]);
  const page = workflowPage(view, "discovery");
  assert.equal(page.title, "Salesforce delivery");
  assert.match(page.actions ?? "", /2 of 7 stages staffed/);
  assert.match(page.body, /Agentic unit.*Northwind delivery bot/s);
  assert.match(homeView(view), /Salesforce delivery/);
});

test("a client request moves through the agency workflow with the assistant working discovery and reviewers holding the gates", () => {
  const { engine, profile, snapshot } = liveAgency();
  let p = applyWorkflowTemplate(engine, W, "leo", ["admin"], "salesforce-agency", 2);
  p = engine.execute(W, "leo", ["admin"], { action: "configure", expectedVersion: p.version, config: { ...p.config, stages: p.config.stages.map((stage) => stage.id === "discovery" ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  p = engine.execute(W, "priya", ["author"], { action: "start", requestId: randomUUID(), title: "Lead routing for Acme", brief: "Web form leads must reach the right regional queue.", issueKey: "SFDC-42" }, 2);
  let run = p.runs[0]!;
  assert.equal(run.issueKey, "SFDC-42");
  assert.equal(run.jira[0]!.action, "update_issue");
  const act = (actor: string, roles: Roles, action: string, note?: string) => {
    p = engine.execute(W, actor, roles, { action, runId: run.id, expectedRevision: run.revision, ...(note ? { note } : {}) }, 2); run = p.runs[0]!; return run;
  };
  // Intake is done by the account manager by hand; discovery then sits with the assistant.
  act("priya", ["author"], "complete", "Acme wants leads routed by country and product interest.");
  assert.equal(run.current, 1);
  let view = snapshotWith(snapshot(), p);
  assert.equal(agenticUnits(view)[0]!.working, 1);
  assert.equal(stageNodes(view)[1]!.state, "active");
  assert.deepEqual(runNodes(run).slice(0, 3).map((node) => node.value), ["Done", "Working", "Waiting"]);
  // Discovery output hands off to design, which is gated: the owner cannot approve, two reviewers can.
  act("priya", ["author"], "complete", "Current assignment rule keys on State only; 3 queues; 2 record types.");
  act("priya", ["author"], "complete", "Design: assignment rule on Country and Product Interest, catch all queue, rollback plan.");
  assert.equal(run.stages[2]!.status, "awaiting_review");
  assert.throws(() => act("priya", ["author", "approver"], "approve"), /cannot approve/);
  act("marco", ["approver"], "approve");
  assert.equal(run.current, 2, "one signature is not enough");
  act("dana", ["approver"], "approve");
  assert.equal(run.current, 3, "design approved; build is active");
  assert.equal(run.jira.at(-1)!.status, "In Progress");
  view = snapshotWith(snapshot(), p);
  assert.deepEqual(runNodes(run).map((node) => node.state).slice(0, 4), ["linked", "linked", "linked", "active"]);
  assert.equal(agenticUnits(view)[0]!.working, 0, "the assistant's stage is behind us");
});

test("retiring the agency assistant's release stops new runs on its stages but leaves an open run alone", () => {
  const { engine, exec, profile, release } = liveAgency();
  let p = applyWorkflowTemplate(engine, W, "leo", ["admin"], "salesforce-agency", 2);
  p = engine.execute(W, "leo", ["admin"], { action: "configure", expectedVersion: p.version, config: { ...p.config, stages: p.config.stages.map((stage) => stage.id === "discovery" ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  p = engine.execute(W, "priya", ["author"], { action: "start", requestId: randomUUID(), title: "Open run", brief: "Started while the assistant was live." }, 2);
  const open = p.runs[0]!;
  exec("leo", ["admin"], { action: "retire_release", releaseId: release.id, note: "Replaced by v2." });
  assert.throws(() => engine.execute(W, "priya", ["author"], { action: "start", requestId: randomUUID(), title: "New run", brief: "After retirement." }, 2), /Stage "Discovery"/);
  p = engine.execute(W, "priya", ["author"], { action: "complete", runId: open.id, expectedRevision: open.revision, note: "Intake done." }, 2);
  assert.equal(p.runs.find((run) => run.id === open.id)!.current, 1, "the open run keeps moving with the staffing it started with");
});

// ------------------------------------------------------------- the scheduler

import { createScheduler } from "../workbench/scheduler.js";
import type { AgentModel } from "../workbench/chat.js";

test("with the scheduler, the delivery bot drafts Discovery and QA on its own and people keep the gates", async () => {
  const { studio, engine, profile, snapshot } = liveAgency();
  let p = applyWorkflowTemplate(engine, W, "leo", ["admin"], "salesforce-agency", 2);
  p = engine.execute(W, "leo", ["admin"], { action: "configure", expectedVersion: p.version, config: { ...p.config, stages: p.config.stages.map((stage) => ["discovery", "qa"].includes(stage.id) ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  // The model answers in the agency's wording, as the assistant was instructed.
  const prompts: string[] = [];
  const model: AgentModel = { async invoke(prompt) {
    prompts.push(prompt);
    const stage = /Stage: ([^.]+)\./.exec(prompt)?.[1];
    return { content: JSON.stringify({ type: "draft", text: `Client: Acme. What we did (${stage}): 1. Reviewed the assignment rule. 2. Listed the three queues. Next step: confirm with the client.` }) };
  } };
  const scheduler = createScheduler({ pipelines: engine, assistants: studioAssistants(studio), loadModel: async () => model });
  p = engine.execute(W, "priya", ["author"], { action: "start", requestId: randomUUID(), title: "Lead routing for Acme", brief: "Web form leads must reach the right regional queue.", issueKey: "SFDC-42" }, 2);
  let run = p.runs[0]!;
  const act = (actor: string, roles: Roles, action: string, note?: string) => { p = engine.execute(W, actor, roles, { action, runId: run.id, expectedRevision: run.revision, ...(note ? { note } : {}) }, 2); run = p.runs[0]!; };
  const refresh = () => { run = engine.snapshot(W).runs[0]!; };
  act("priya", ["author"], "complete", "Acme wants leads routed by country and product interest.");
  // Discovery: the bot drafts; the draft carries the agency's voice and the intake output was handed over.
  await scheduler.tick(W); refresh();
  assert.equal(run.stages[1]!.status, "active", "the scheduler never completes a stage");
  assert.match(run.stages[1]!.draft!.text, /^Client: Acme\. What we did \(Discovery\).*Next step:/);
  assert.match(prompts[0]!, /Intake: Acme wants leads routed/);
  assert.match(prompts[0]!, /name the client, say what we did in numbered steps/);
  let view = snapshotWith(snapshot(), engine.snapshot(W));
  assert.equal(agenticUnits(view)[0]!.working, 1);
  // The owner uses the draft. Design is by hand and gated; the scheduler has nothing to do there.
  act("priya", ["author"], "complete", run.stages[1]!.draft!.text);
  assert.equal(run.stages[1]!.output, run.stages[1]!.draft!.text);
  await scheduler.tick(W);
  assert.equal(scheduler.snapshot(W).jobs.length, 1);
  act("priya", ["author"], "complete", "Design: assignment rule on Country and Product Interest, catch all queue, rollback plan.");
  act("marco", ["approver"], "approve"); act("dana", ["approver"], "approve");
  act("priya", ["author"], "complete", "Built in the sandbox: assignment rule, catch all queue, deployment package.");
  // QA: the bot drafts again, from everything completed so far; the QA gate still needs two reviewers.
  await scheduler.tick(W); refresh();
  assert.equal(scheduler.snapshot(W).jobs.length, 2);
  assert.match(run.stages[4]!.draft!.text, /\(QA\)/);
  assert.match(prompts[1]!, /Build: Built in the sandbox/);
  act("priya", ["author"], "complete", run.stages[4]!.draft!.text);
  assert.equal(run.stages[4]!.status, "awaiting_review");
  assert.throws(() => act("priya", ["author", "approver"], "approve"), /cannot approve/);
  act("marco", ["approver"], "approve"); act("dana", ["approver"], "approve");
  assert.equal(run.current, 5, "QA approved; client UAT is active and by hand");
  await scheduler.tick(W);
  assert.equal(scheduler.snapshot(W).jobs.length, 2, "nothing queued for a stage done by a person");
  view = snapshotWith(snapshot(), engine.snapshot(W));
  assert.deepEqual(runNodes(run).map((node) => node.state), ["linked", "linked", "linked", "linked", "linked", "active", "pending"]);
  await scheduler.close();
});

// ------------------------------------------------------- the learning schedule

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileModelStudio } from "../workbench/studio/engine.js";
import { createLearningSchedule, folderImports } from "../workbench/learning-schedule.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";

test("the agency's assistant keeps learning: weekly notes dropped in the import folder become a release request, set up and read over the MCP", async (t) => {
  // A file backed studio: the agency drops its exported case notes in the import folder every week.
  const dir = mkdtempSync(join(tmpdir(), "magentic-agency-"));
  const imports = join(dir, "import");
  let week = 0;
  const now = () => new Date(Date.UTC(2026, 8, 28 + week * 7, 9)).toISOString();
  const studio = fileModelStudio(join(dir, "studio"), imports, { now });
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  const project = exec("priya", ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery", purpose: "Answer delivery questions." }).projects[0]!;
  const learning = createLearningSchedule({ studio, imports: folderImports(imports), now });
  const server = createWorkbenchServer({ assets: new Map(), pipelines: memoryPipelines(), studio, learning,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, members: memoryMembers([{ workspaceId: W, actor: "priya", roles: ["author"] }, { workspaceId: W, actor: "marco", roles: ["approver"] }]) },
    authenticate: async (req) => { const actor = req.headers.authorization?.replace(/^Bearer /, ""); return actor ? { workspaceId: W, actor } : undefined; },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const mcp = async (who: string) => { const client = new Client({ name: "agency-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/pipeline-mcp`), { requestInit: { headers: { Authorization: `Bearer ${who}` } } }) as unknown as Parameters<typeof client.connect>[0]); return client; };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => { const response = await client.callTool({ name, arguments: args }) as { content: { text?: string }[]; isError?: boolean }; return { ...JSON.parse(response.content[0]!.text ?? "{}"), isError: response.isError ?? false }; };
  // A reviewer cannot set a schedule; the author sets a weekly one over the MCP.
  const marco = await mcp("marco");
  assert.match((await call(marco, "set_learning_schedule", { projectId: project.id, cadence: "weekly", pattern: "case-notes-*.jsonl" })).error, /Authors and admins/);
  const priya = await mcp("priya");
  const schedule = await call(priya, "set_learning_schedule", { projectId: project.id, cadence: "weekly", pattern: "case-notes-*.jsonl" });
  assert.equal(schedule.owner, "priya");
  // Week 1: notes arrive; the due schedule imports, validates, trains, evaluates and asks for a release.
  // (The server already ticked once after the MCP call, before the file existed: that cycle found nothing new.)
  writeFileSync(join(imports, "case-notes-week-1.jsonl"), notes(80));
  learning.set(W, "priya", ["author"], { projectId: project.id, cadence: "weekly", pattern: "case-notes-*.jsonl" });
  learning.tick(W);
  const runs = learning.snapshot(W).runs;
  assert.equal(runs.at(-1)!.status, "complete");
  assert.match(runs.at(-1)!.summary, /Release v1 requested/);
  let s = studio.snapshot(W);
  assert.equal(s.releases[0]!.status, "pending_approval");
  assert.equal(s.profiles.length, 0, "no assistant changes until people approve and assign");
  const read = await call(priya, "get_learning_schedule", { projectId: project.id });
  assert.equal(read.schedules[0].cadence, "weekly");
  assert.deepEqual(read.runs.at(-1).steps.map((step: { step: string; outcome: string }) => `${step.step}:${step.outcome}`), ["import:done", "validate:done", "train:done", "evaluate:done", "release:done"]);
  // Reviewers approve; the assistant is created from the release the schedule asked for.
  const release = s.releases[0]!;
  exec("marco", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  exec("dana", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("priya", ["author"], { action: "assign_profile", name: "Northwind delivery bot", releaseId: release.id, instructions: AGENCY_VOICE });
  // Week 2: new notes, a new candidate compared against the approved release, a v2 request; the live assistant is untouched.
  week = 1;
  writeFileSync(join(imports, "case-notes-week-2.jsonl"), notes(90));
  const second = learning.tick(W);
  assert.equal(second.length, 1, "weekly means once a week");
  assert.match(second[0]!.summary, /Release v2 requested/);
  assert.deepEqual(learning.tick(W), [], "and not twice");
  s = studio.snapshot(W);
  assert.equal(s.evaluations.at(-1)!.baseline.source, "release", "the candidate is measured against what people approved");
  assert.equal(s.profiles[0]!.releaseId, release.id, "the assistant still answers with v1 until v2 is approved and assigned");
  // Running it again by hand right away finds nothing new and does not stack releases.
  const manual = await call(priya, "run_learning_now", { projectId: project.id });
  assert.equal(manual.status, "stopped");
  assert.match(manual.summary, /Nothing new/);
  assert.equal(studio.snapshot(W).releases.length, 2);
  await priya.close(); await marco.close();
});
