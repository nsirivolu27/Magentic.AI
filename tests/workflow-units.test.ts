import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryPipelines, DEFAULT_PIPELINE, PipelineError, type PipelineConfig } from "../workbench/pipeline.js";
import { memoryModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";

/**
 * A workflow stage can be staffed by a Model Studio assistant. The binding
 * follows the chat rules exactly: only an active assistant on an approved,
 * validly signed release can be bound, started with, or resolved for a bot.
 * These tests drive a studio to a live assistant and then retire it.
 */

const W = "units-workspace";
const dataset = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [
  { role: "user", content: `Q${index}` }, { role: "assistant", content: `A${index}` },
] })).join("\n");

function liveAssistant() {
  const studio = memoryModelStudio({ now: () => "2026-09-27T12:00:00.000Z" });
  const exec = (actor: string, roles: ("author" | "approver" | "admin")[], command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  let s: StudioSnapshot = exec("alex", ["author"], { action: "create_project", name: "Repo helper", recipeId: "coding-assistant", purpose: "Answer repo questions." });
  const project = s.projects[0]!;
  s = exec("alex", ["author"], { action: "register_dataset", projectId: project.id, name: "Pairs", source: { kind: "inline", text: dataset(60) } });
  s = exec("alex", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = exec("alex", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = exec("alex", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("alex", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("alex", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = exec("alex", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = exec("sam", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("jordan", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("alex", ["author"], { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const profile = s.profiles[0]!;
  const retire = () => exec("taylor", ["admin"], { action: "retire_release", releaseId: release.id, note: "Superseded." });
  return { studio, profile, retire };
}

const staffed = (assistantId: string | undefined): PipelineConfig => ({ ...DEFAULT_PIPELINE, stages: DEFAULT_PIPELINE.stages.map((stage, index) => index === 1 && assistantId ? { ...stage, assistantId } : stage) });

test("a stage can only be bound to an assistant that can answer right now", () => {
  const { studio, profile, retire } = liveAssistant();
  const resolve = studioAssistants(studio);
  const engine = memoryPipelines(assistantGuards(resolve));
  // Unknown assistant: refused with the stage named.
  assert.throws(() => engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 1, config: staffed(randomUUID()) }, 2),
    (error: unknown) => error instanceof PipelineError && error.status === 409 && /Stage "Planning": Chatbot profile not found/.test(error.message));
  // A live assistant binds, and the binding survives in the snapshot.
  const bound = engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 1, config: staffed(profile.id) }, 2);
  assert.equal(bound.config.stages[1]!.assistantId, profile.id);
  // The resolver hands the bot runtime the release's model and the assistant's instructions.
  const unit = resolve(W, profile.id);
  assert.equal(unit.name, "Repo bot");
  assert.equal(unit.model, "qwen2.5-coder:7b");
  assert.match(unit.release, /^v1 · Repo helper$/);
  assert.ok(unit.instructions.length > 0);
  // A run can start while the assistant is usable.
  const started = engine.execute(W, "alex", ["author"], { action: "start", requestId: randomUUID(), title: "Ship the thing", brief: "Do it properly." }, 2);
  assert.equal(started.runs[0]!.config.stages[1]!.assistantId, profile.id);
  // Once the release is retired, nothing new can start on that stage and the binding cannot be re-saved.
  retire();
  assert.throws(() => resolve(W, profile.id), (error: unknown) => error instanceof PipelineError && /retired|disabled/.test(error.message));
  assert.throws(() => engine.execute(W, "alex", ["author"], { action: "start", requestId: randomUUID(), title: "Another", brief: "Try again." }, 2),
    (error: unknown) => error instanceof PipelineError && /Stage "Planning"/.test(error.message));
  assert.throws(() => engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 2, config: staffed(profile.id) }, 2), PipelineError);
  // Unbinding the stage is always allowed.
  const freed = engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 2, config: staffed(undefined) }, 2);
  assert.equal(freed.config.stages[1]!.assistantId, undefined);
});

test("without a Model Studio, a bound stage is refused rather than run by hand", () => {
  const engine = memoryPipelines();
  assert.throws(() => engine.execute(W, "admin", ["admin"], { action: "configure", expectedVersion: 1, config: staffed(randomUUID()) }, 2),
    (error: unknown) => error instanceof PipelineError && /Model Studio is not configured/.test(error.message));
});

// ------------------------------------------------ the editor as a standalone client

import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { getWorkbenchAssistant, listWorkbenchAssistants, readWorkbenchToken, workbenchEndpoint, workbenchTokenFile } from "../workbench/editor-assistants.js";
import { runEditorRequest } from "../workbench/editor-session.js";

test("the editor extension lists usable assistants over the pipeline MCP and runs with one's binding", async (t) => {
  const { studio, profile, retire } = liveAssistant();
  const engine = memoryPipelines(assistantGuards(studioAssistants(studio)));
  const server = createWorkbenchServer({ assets: new Map(), pipelines: engine, studio,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW, members: memoryMembers([{ workspaceId: W, actor: "alex", roles: ["author", "admin"] }]) },
    authenticate: async (req) => req.headers.authorization === "Bearer secret-token" ? { workspaceId: W, actor: "alex" } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  // The token comes from the workbench data directory, and only a loopback address is ever called.
  const dir = mkdtempSync(join(tmpdir(), "magentic-token-"));
  writeFileSync(join(dir, "mcp-token"), "secret-token\n");
  assert.equal(workbenchTokenFile({ MAGENTIC_WORKSPACES_DIR: dir }, "linux"), join(dir, "mcp-token"));
  const token = await readWorkbenchToken(join(dir, "mcp-token"));
  assert.throws(() => workbenchEndpoint("http://example.com:4173"), /loopback/);
  assert.equal(workbenchEndpoint(url).pathname, "/api/pipeline-mcp");
  await assert.rejects(listWorkbenchAssistants(url, "wrong-token"), /refused the token|Unauthorized|401/i);
  const listed = await listWorkbenchAssistants(url, token);
  assert.deepEqual(listed.map((item) => [item.name, item.usable, item.release, item.project]), [["Repo bot", true, "v1", "Repo helper"]]);
  const binding = await getWorkbenchAssistant(url, token, profile.id);
  assert.equal(binding.name, "Repo bot");
  assert.equal(binding.model, "qwen2.5-coder:7b");
  // The editor request runs under the assistant: its model on the record, its name and instructions in the prompt.
  const root = mkdtempSync(join(tmpdir(), "magentic-editor-"));
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  writeFileSync(join(root, "answer.txt"), "original");
  execFileSync("git", ["add", "answer.txt"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: root, windowsHide: true });
  let prompt = "";
  const model = { async invoke(text: string) { prompt = text; return { content: JSON.stringify({ type: "result", summary: "Answer", changes: [] }) }; } };
  await runEditorRequest(root, { mode: "ask", prompt: "Explain", assistant: binding }, model, "ignored-local-model", new AbortController().signal);
  assert.match(prompt, /You are Repo bot, an approved assistant \(release v1 · Repo helper\)/);
  assert.match(prompt, new RegExp(binding.instructions.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Retire the release: the listing says why, and the binding is refused.
  retire();
  const after = await listWorkbenchAssistants(url, token);
  assert.equal(after[0]!.usable, false);
  assert.match(after[0]!.reason, /disabled|retired/);
  await assert.rejects(getWorkbenchAssistant(url, token, profile.id), /disabled|retired/);
});

test("the editor reads an assistant's learning schedule and can ask for a cycle over the same MCP", async (t) => {
  const { studio, profile } = liveAssistant();
  const { createLearningSchedule } = await import("../workbench/learning-schedule.js");
  const { getWorkbenchLearning, runWorkbenchLearning } = await import("../workbench/editor-assistants.js");
  const learning = createLearningSchedule({ studio });
  const server = createWorkbenchServer({ assets: new Map(), pipelines: memoryPipelines(), studio, learning,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW, members: memoryMembers([{ workspaceId: W, actor: "alex", roles: ["author", "admin"] }]) },
    authenticate: async (req) => req.headers.authorization === "Bearer secret-token" ? { workspaceId: W, actor: "alex" } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const listed = await listWorkbenchAssistants(url, "secret-token");
  assert.ok(listed[0]!.projectId, "the listing names the project so the editor can ask about its schedule");
  const before = await getWorkbenchLearning(url, "secret-token", listed[0]!.projectId);
  assert.deepEqual(before.schedules, []);
  learning.set(W, "alex", ["author"], { projectId: listed[0]!.projectId, cadence: "weekly" });
  const run = await runWorkbenchLearning(url, "secret-token", listed[0]!.projectId);
  assert.equal(run.status, "stopped");
  assert.match(run.summary, /Nothing new/, "the fixture's content is already trained and released");
  const after = await getWorkbenchLearning(url, "secret-token", listed[0]!.projectId);
  assert.equal(after.schedules[0]!.cadence, "weekly");
  assert.equal(after.runs.length, 2, "the scheduled first cycle and the manual one");
  assert.equal(profile.name, "Repo bot");
});
