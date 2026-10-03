import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { memoryPipelines, type PipelineEngine } from "../workbench/pipeline.js";
import { assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";
import { applyWorkflowTemplate } from "../workbench/workflow-templates.js";
import { createScheduler, type SchedulerPersistence, type ScheduledJob } from "../workbench/scheduler.js";
import type { AgentModel } from "../workbench/chat.js";

/**
 * The scheduler is the part that makes assistants work on their own.
 *
 * When a running workflow sits on a stage staffed by an assistant, a job is
 * queued; the job runs with the assistant's binding, taken fresh, and its
 * result is attached to the stage as a draft. People still complete and
 * approve stages. These tests drive that with a fake model, so what is
 * checked is the scheduling, the binding rules and the handoff, not prose.
 */

const W = "scheduler-workspace";
type Roles = ("author" | "approver" | "admin")[];
const notes = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [
  { role: "user", content: `Client: Acme. Ask ${index}: leads land in the wrong queue.` },
  { role: "assistant", content: `What we did: rebuilt the assignment rule ${index}. Next step: confirm with the client.` },
] })).join("\n");

function liveAssistant() {
  const studio = memoryModelStudio({ now: () => "2026-09-28T09:00:00.000Z" });
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  let s: StudioSnapshot = exec("priya", ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery", purpose: "Answer delivery questions." });
  const project = s.projects[0]!;
  s = exec("priya", ["author"], { action: "register_dataset", projectId: project.id, name: "Case notes", source: { kind: "inline", text: notes(80) } });
  s = exec("priya", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = exec("priya", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = exec("priya", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("priya", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("priya", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = exec("priya", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = exec("marco", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("dana", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("priya", ["author"], { action: "assign_profile", name: "Northwind delivery bot", releaseId: release.id, instructions: "Name the client, say what we did in numbered steps, end with 'Next step:'." });
  return { studio, exec, profile: s.profiles[0]!, release };
}

/** A model that answers with what the scheduler asked for, and remembers the prompts. */
function fakeModel(reply: (prompt: string) => string) {
  const prompts: string[] = [];
  const model: AgentModel = { async invoke(prompt) { prompts.push(prompt); return { content: reply(prompt) }; } };
  return { prompts, load: async (name: string) => { loaded.push(name); return model; } };
}
const loaded: string[] = [];

function fixture(persistence?: SchedulerPersistence, reply = (_: string) => JSON.stringify({ type: "draft", text: "1. Client: Acme. 2. Current rule keys on State only. Next step: confirm queues with the client." })) {
  const { studio, exec, profile, release } = liveAssistant();
  const assistants = studioAssistants(studio);
  const engine: PipelineEngine = memoryPipelines(assistantGuards(assistants));
  let p = applyWorkflowTemplate(engine, W, "leo", ["admin"], "salesforce-agency", 2);
  p = engine.execute(W, "leo", ["admin"], { action: "configure", expectedVersion: p.version, config: { ...p.config, stages: p.config.stages.map((stage) => ["discovery", "qa"].includes(stage.id) ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  const model = fakeModel(reply);
  const scheduler = createScheduler({ pipelines: engine, assistants, loadModel: model.load, now: () => "2026-09-28T10:00:00.000Z", ...(persistence ? { persistence } : {}) });
  const start = (title = "Lead routing for Acme") => engine.execute(W, "priya", ["author"], { action: "start", requestId: randomUUID(), title, brief: "Web form leads must reach the right regional queue." }, 2).runs[0]!;
  const run = (id: string) => engine.snapshot(W).runs.find((item) => item.id === id)!;
  const act = (id: string, actor: string, roles: Roles, action: string, note?: string) => engine.execute(W, actor, roles, { action, runId: id, expectedRevision: run(id).revision, ...(note ? { note } : {}) }, 2);
  return { studio, exec, engine, scheduler, profile, release, model, start, run, act };
}

test("a stage staffed by an assistant is queued once, drafted with the assistant's binding, and never completed by the scheduler", async () => {
  const f = fixture();
  const first = f.start();
  // Intake is by hand: nothing to schedule yet.
  await f.scheduler.tick(W);
  assert.deepEqual(f.scheduler.snapshot(W).jobs, []);
  f.act(first.id, "priya", ["author"], "complete", "Acme wants leads routed by country and product interest.");
  // Discovery is the assistant's: one job, run to a draft.
  await f.scheduler.tick(W);
  const [job] = f.scheduler.snapshot(W).jobs as [ScheduledJob];
  assert.equal(job.status, "ready");
  assert.equal(job.stageId, "discovery");
  assert.equal(job.assistant, "Northwind delivery bot");
  assert.equal(job.model, "llama3.1:8b");
  assert.equal(loaded.at(-1), "llama3.1:8b", "the assistant's release decides the model");
  const prompt = f.model.prompts[0]!;
  assert.match(prompt, /You are Northwind delivery bot, an approved assistant \(release v1 · Delivery assistant\)/);
  assert.match(prompt, /Name the client, say what we did in numbered steps/);
  assert.match(prompt, /Stage: Discovery/);
  assert.match(prompt, /Request: Lead routing for Acme/);
  assert.match(prompt, /Intake: Acme wants leads routed by country and product interest\./, "completed outputs are handed to the next stage");
  // The draft sits on the stage; the stage is still active and the run did not move.
  const after = f.run(first.id);
  assert.equal(after.current, 1);
  assert.equal(after.stages[1]!.status, "active");
  assert.match(after.stages[1]!.draft?.text ?? "", /^1\. Client: Acme/);
  assert.equal(after.stages[1]!.draft?.by, "Northwind delivery bot");
  assert.equal(after.stages[1]!.draft?.jobId, job.id);
  assert.match(after.events.at(-1)!.detail, /Draft prepared by Northwind delivery bot/);
  // Ticking again schedules nothing new: the stage already has its job.
  await f.scheduler.tick(W);
  assert.equal(f.scheduler.snapshot(W).jobs.length, 1);
  assert.equal(f.model.prompts.length, 1);
  // The owner completes the stage with the draft, like any output; the next stage is design, by hand and gated.
  f.act(first.id, "priya", ["author"], "complete", after.stages[1]!.draft!.text);
  assert.equal(f.run(first.id).current, 2);
  await f.scheduler.tick(W);
  assert.equal(f.scheduler.snapshot(W).jobs.length, 1, "design is not staffed by an assistant");
});

test("a job runs with a fresh binding: a retired release fails it with the reason and nothing advances", async () => {
  const f = fixture();
  const run = f.start();
  f.act(run.id, "priya", ["author"], "complete", "Intake done.");
  f.exec("leo", ["admin"], { action: "retire_release", releaseId: f.release.id, note: "Replaced." });
  await f.scheduler.tick(W);
  const [job] = f.scheduler.snapshot(W).jobs as [ScheduledJob];
  assert.equal(job.status, "failed");
  assert.match(job.error, /disabled|retired/);
  assert.equal(f.model.prompts.length, 0, "no model call without a usable assistant");
  assert.equal(f.run(run.id).stages[1]!.draft, undefined);
  assert.equal(f.run(run.id).current, 1);
  // A failed job is retried only on request.
  await f.scheduler.tick(W);
  assert.equal(f.scheduler.snapshot(W).jobs.length, 1);
  f.scheduler.retry(W, job.id);
  assert.equal(f.scheduler.snapshot(W).jobs[0]!.status, "queued");
});

test("a run that moves on or stops before its draft is ready cancels the job, and a bad model answer fails it", async () => {
  const f = fixture(undefined, (prompt: string) => prompt.includes("Request: Broken") ? JSON.stringify({ type: "tool", name: "list_project_files" }) : JSON.stringify({ type: "draft", text: "Draft." }));
  const moving = f.start("Moving on");
  f.act(moving.id, "priya", ["author"], "complete", "Intake.");
  // The job is queued, but before it runs the run is cancelled.
  f.scheduler.enqueue(W);
  assert.equal(f.scheduler.snapshot(W).jobs[0]!.status, "queued");
  f.act(moving.id, "priya", ["author"], "cancel", "Client withdrew.");
  await f.scheduler.tick(W);
  assert.equal(f.scheduler.snapshot(W).jobs[0]!.status, "cancelled");
  assert.match(f.scheduler.snapshot(W).jobs[0]!.error, /no longer active/);
  // A model that returns nothing usable fails the job; the stage keeps no draft.
  const broken = f.start("Broken");
  f.act(broken.id, "priya", ["author"], "complete", "Intake.");
  await f.scheduler.tick(W);
  const job = f.scheduler.snapshot(W).jobs.find((item) => item.runId === broken.id)!;
  assert.equal(job.status, "failed");
  assert.match(job.error, /did not return a draft/);
  assert.equal(f.run(broken.id).stages[1]!.draft, undefined);
});

test("jobs are persisted and a job left running by a crash is failed on restart, not resumed as if it finished", async () => {
  const stored = new Map<string, ScheduledJob[]>();
  const persistence: SchedulerPersistence = { read: (workspace) => stored.get(workspace), commit: (workspace, jobs) => { stored.set(workspace, structuredClone(jobs)); } };
  const f = fixture(persistence);
  const run = f.start();
  f.act(run.id, "priya", ["author"], "complete", "Intake.");
  await f.scheduler.tick(W);
  assert.equal(stored.get(W)![0]!.status, "ready");
  // Simulate a crash mid job: the stored record says running. A new scheduler must not trust it.
  const { finishedAt: _finished, ...crashed } = stored.get(W)![0]!;
  stored.set(W, [{ ...crashed, status: "running" }]);
  const again = createScheduler({ pipelines: f.engine, assistants: studioAssistants(f.studio), loadModel: f.model.load, persistence });
  const [job] = again.snapshot(W).jobs as [ScheduledJob];
  assert.equal(job.status, "failed");
  assert.match(job.error, /interrupted/);
});
