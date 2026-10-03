import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { memoryPipelines, PipelineError } from "../workbench/pipeline.js";
import { assistantDirectory, assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";
import { applyWorkflowTemplate, WORKFLOW_TEMPLATES, WORKFLOW_TEMPLATE_LIST } from "../workbench/workflow-templates.js";
import { createScheduler } from "../workbench/scheduler.js";
import { runEditorRequest, validateEditorProposal } from "../workbench/editor-session.js";
import { agenticUnits, unitUsage } from "../workbench/units.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { AgentModel } from "../workbench/chat.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

/**
 * Second customer story: a software team shipping a change.
 *
 * Story → Design → Build → Review → Release. The team's assistant is
 * trained on its own pull request notes. The scheduler drafts the design,
 * the developer builds in the editor under the same assistant, people hold
 * both gates, and every stage transition becomes a Jira preview. Token
 * counts are recorded on the way so the team can see what the assistant
 * cost. As with the agency story, this file is the specification.
 */

const W = "orbit-engineering";
type Roles = ("author" | "approver" | "admin")[];

/** Pull request notes the way the team writes them: what changed, why, how it was checked. */
const PR_NOTES = [
  ["lead routing", "Route web leads by country and product interest instead of state.", "Added a routing table keyed on country and product; unit tests cover the catch all."],
  ["rate limiter", "Public API returned 500 under burst load.", "Token bucket per client key; 429 with Retry-After; load test at 5x peak passes."],
  ["audit log", "Admin actions were not attributable.", "Every admin mutation writes an audit row with actor, before and after; migration backfills last 30 days."],
  ["dark mode", "Contrast failed accessibility review.", "Tokens for surface and text colours; automated contrast check in CI."],
];
function prNote(index: number): string {
  const [topic, why, what] = PR_NOTES[index % PR_NOTES.length]!;
  return JSON.stringify({ messages: [
    { role: "user", content: `Change ${index} (${topic}): ${why}` },
    { role: "assistant", content: `What changed: ${what} Checked by: CI green and one reviewer. Risk: low.` },
  ] });
}
const notes = (count: number) => Array.from({ length: count }, (_, index) => prNote(index)).join("\n");

const TEAM_VOICE = "You are Orbit's delivery assistant. Write the way our pull request notes read: what changed, why, how it was checked, and the risk in one word. Never claim a check ran unless it is recorded. Never propose a change to a file you have not read.";

function liveTeam() {
  const studio = memoryModelStudio({ now: () => "2026-09-29T09:00:00.000Z" });
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  let s: StudioSnapshot = exec("maya", ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "coding-assistant", purpose: "Draft designs and build changes the way the team does." });
  const project = s.projects[0]!;
  s = exec("maya", ["author"], { action: "register_dataset", projectId: project.id, name: "PR notes", source: { kind: "inline", text: notes(80) } });
  s = exec("maya", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = exec("maya", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = exec("maya", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("maya", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("maya", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = exec("maya", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = exec("noah", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("ada", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("maya", ["author"], { action: "assign_profile", name: "Orbit delivery bot", releaseId: release.id, instructions: TEAM_VOICE });
  const profile = s.profiles[0]!;
  const resolve = studioAssistants(studio);
  const engine = memoryPipelines(assistantGuards(resolve));
  const snapshot = () => studio.snapshot(W);
  return { studio, exec, engine, profile, release, resolve, snapshot, directory: assistantDirectory(studio) };
}

function snapshotWith(studio: StudioSnapshot, pipelines: WorkbenchSnapshot["pipelines"], extra: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  return { studio, ...(pipelines ? { pipelines } : {}), workspaceId: W, actor: "maya", roles: ["author"], workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, canAuthor: true,
    records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: true, provider: "ollama", model: "m" }, ...extra };
}

/** A committed repository with one source file, the way the extension sees a workspace folder. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "orbit-repo-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "routing.ts"), "export function route(lead: { state: string }): string {\n  return lead.state === \"CA\" ? \"west\" : \"default\";\n}\n");
  execFileSync("git", ["add", "routing.ts"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  return root;
}

test("the software delivery template gates design, review and release, builds in the editor, and files under ENG", () => {
  const template = WORKFLOW_TEMPLATES["software-delivery"]!;
  assert.ok(template, "the template exists");
  assert.deepEqual(template.stages.map((stage) => stage.id), ["story", "design", "build", "review", "release"]);
  assert.deepEqual(template.stages.filter((stage) => stage.approval).map((stage) => stage.id), ["design", "review", "release"]);
  assert.equal(template.stages.find((stage) => stage.id === "build")!.bot?.kind, "coder", "build is a supervised coding stage the editor can run");
  assert.deepEqual(template.jira, { enabled: true, project: "ENG", issueType: "Story" });
  assert.ok(WORKFLOW_TEMPLATE_LIST.some((item) => item.id === "software-delivery"), "the Workflows page offers it");
});

test("a story moves from design draft to release with the assistant drafting, the editor building and people holding the gates", async () => {
  const { engine, profile, snapshot, directory, exec, release, resolve } = liveTeam();
  let p = applyWorkflowTemplate(engine, W, "sam", ["admin"], "software-delivery", 2);
  p = engine.execute(W, "sam", ["admin"], { action: "configure", expectedVersion: p.version, config: { ...p.config,
    stages: p.config.stages.map((stage) => stage.id === "design" || stage.id === "build" ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  assert.deepEqual(agenticUnits(snapshotWith(snapshot(), p))[0]!.stages.map((stage) => stage.id), ["design", "build"]);

  // The story is written by hand and filed in Jira.
  p = engine.execute(W, "maya", ["author"], { action: "start", requestId: randomUUID(), title: "Route leads by country", brief: "Web leads must reach the regional team for their country, not their state.", issueKey: "ENG-7" }, 2);
  let run = p.runs[0]!;
  assert.equal(run.jira[0]!.action, "update_issue");
  const act = (actor: string, roles: Roles, action: string, note?: string) => {
    p = engine.execute(W, actor, roles, { action, runId: run.id, expectedRevision: run.revision, ...(note ? { note } : {}) }, 2); run = p.runs[0]!; return run;
  };
  act("maya", ["author"], "complete", "Story: as a sales lead I want web leads routed by country so the right team calls first.");
  assert.equal(run.current, 1, "design is active");

  // The scheduler drafts the design under the assistant and records what it cost.
  const drafting: AgentModel = { async invoke(prompt) {
    assert.match(prompt, /Orbit delivery bot/); assert.match(prompt, /Stage: Design/);
    return { content: JSON.stringify({ type: "draft", text: "What changes: routing keyed on country with a catch all. Why: state is the wrong grain. Checked by: unit tests on the table. Risk: low." }), usage: { promptTokens: 640, completionTokens: 58 } };
  } };
  const scheduler = createScheduler({ pipelines: engine, assistants: resolve, loadModel: async () => drafting, now: () => "2026-09-29T09:10:00.000Z" });
  await scheduler.tick(W);
  const job = scheduler.snapshot(W).jobs[0]!;
  assert.equal(job.status, "ready"); assert.deepEqual(job.usage, { promptTokens: 640, completionTokens: 58 });
  run = engine.snapshot(W).runs[0]!;
  assert.match(run.stages[1]!.draft!.text, /^What changes:/);
  assert.equal(run.stages[1]!.draft!.by, "Orbit delivery bot");
  assert.deepEqual(unitUsage(snapshotWith(snapshot(), engine.snapshot(W), { schedule: scheduler.snapshot(W) }), profile.id), { promptTokens: 640, completionTokens: 58 });

  // The owner completes design with the draft; the gate needs two reviewers who are not the owner.
  act("maya", ["author"], "complete", run.stages[1]!.draft!.text);
  assert.equal(run.stages[1]!.status, "awaiting_review");
  assert.throws(() => act("maya", ["author", "approver"], "approve"), /cannot approve/);
  act("noah", ["approver"], "approve"); act("ada", ["approver"], "approve");
  assert.equal(run.current, 2, "build is active");

  // Build happens in the editor, under the same assistant binding the workflow uses.
  const root = repository();
  const binding = directory.get(W, profile.id);
  assert.equal(binding.name, "Orbit delivery bot");
  const prompts: string[] = [];
  const building: AgentModel = { async invoke(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "routing.ts" } }), usage: { promptTokens: 900, completionTokens: 30 } };
    return { content: JSON.stringify({ type: "result", summary: "What changed: route() keys on country with a default team. Checked by: not yet run. Risk: low.",
      changes: [{ path: "routing.ts", content: "export function route(lead: { country: string }): string {\n  const teams: Record<string, string> = { US: \"north-america\", DE: \"europe\" };\n  return teams[lead.country] ?? \"default\";\n}\n" }] }), usage: { promptTokens: 1200, completionTokens: 140 } };
  } };
  const proposal = await runEditorRequest(root, { mode: "edit", prompt: "Implement the approved design for lead routing.", assistant: binding }, building, "ignored", new AbortController().signal);
  assert.match(prompts[0]!, /You are Orbit delivery bot, an approved assistant \(release v1 · Delivery assistant\)/);
  assert.equal(proposal.changes.length, 1);
  assert.deepEqual(proposal.usage, { promptTokens: 2100, completionTokens: 170 }, "the editor reports what the build cost across its model calls");
  validateEditorProposal(proposal);
  // The person applies the proposal and completes build with the assistant's summary; nothing was applied by the model.
  assert.match(readFileSync(join(root, "routing.ts"), "utf8"), /lead\.state/, "the file is untouched until a person applies the change");
  writeFileSync(join(root, "routing.ts"), proposal.changes[0]!.after);
  act("maya", ["author"], "complete", proposal.summary);
  assert.equal(run.current, 3, "review is active");
  assert.equal(run.jira.at(-1)!.status, "In Review");

  // Review and release are gated the same way; the last transition files Done.
  // The owner records the review outcome; the reviewers themselves sign the gate.
  act("maya", ["author"], "complete", "Review by noah and ada: diff matches the design; catch all covered by tests.");
  act("ada", ["approver"], "approve"); act("noah", ["approver"], "approve");
  assert.equal(run.current, 4, "release is active");
  act("sam", ["admin"], "complete", "Deployed build 412 to production; monitored for one hour.");
  act("noah", ["approver"], "approve"); act("ada", ["approver"], "approve");
  assert.equal(run.status, "complete");
  assert.equal(run.jira.at(-1)!.status, "Done");

  // Retiring the release stops the next story at the first staffed stage.
  exec("sam", ["admin"], { action: "retire_release", releaseId: release.id, note: "v2 coming." });
  assert.throws(() => engine.execute(W, "maya", ["author"], { action: "start", requestId: randomUUID(), title: "Next story", brief: "After retirement." }, 2),
    (error: unknown) => error instanceof PipelineError && /Stage "Design"/.test(error.message));
  assert.throws(() => directory.get(W, profile.id), /retired|disabled/, "the editor takes the binding fresh, so its next request is refused too");
  await scheduler.close();
});
