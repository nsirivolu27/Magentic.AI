import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotRuntime, type BotRuntime } from "../workbench/bot-runtime.js";
import { DEFAULT_PIPELINE, memoryPipelines, pipelineSchema } from "../workbench/pipeline.js";
import { applyChanges, listProjectFiles, projectPath, readProjectFile, treeDigest } from "../workbench/bot-project.js";
import type { AgentModel, ChatConfiguration } from "../workbench/chat.js";
import { botTimeline } from "../workbench/bot-view.js";

const owner = "local-owner";
const roles = ["author", "admin"] as const;
async function idle(runtime: BotRuntime, workspace = "one") {
  const until = Date.now() + 20_000;
  while (runtime.busy(workspace) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runtime.busy(workspace), false, "bot must settle within its bounded test deadline");
  return runtime.snapshot(workspace).attempts.at(-1)!;
}
function codingModel(after = 'export const answer = 42;\n'): AgentModel {
  let count = 0;
  return { async invoke() {
    return { content: JSON.stringify(++count % 2 ? { type: "tool", name: "read_project_file", arguments: { path: "answer.ts" } }
      : { type: "result", summary: "Corrected the answer. Run configured checks before accepting.", changes: [{ path: "answer.ts", content: after }] }) };
  } };
}
function fixture(model: AgentModel = codingModel(), gated = false, checks = [{ executable: "node", args: ["--eval", "process.exit(0)"] }]) {
  const directory = mkdtempSync(join(tmpdir(), "magentic-bots-"));
  const repo = join(directory, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo], { windowsHide: true });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo, windowsHide: true });
  writeFileSync(join(repo, "answer.ts"), "export const answer = 0;\n");
  execFileSync("git", ["add", "answer.ts"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo, windowsHide: true });
  const pipelines = memoryPipelines();
  pipelines.execute("one", owner, roles, { action: "configure", expectedVersion: 1, config: { ...DEFAULT_PIPELINE,
    stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: gated, model: "test-model", bot: { kind: "coder", maxSteps: 3, timeoutSeconds: 15 } }] } }, 2);
  const run = pipelines.execute("one", owner, roles, { action: "start", requestId: randomUUID(), title: "Implement answer", brief: "Return forty-two." }, 2).runs[0]!;
  const configuration: ChatConfiguration = { provider: "test", model: "test-model", loadModel: async () => model };
  const data = join(directory, "data");
  const runtime = createBotRuntime(data, pipelines, configuration);
  const act = (raw: unknown, workspace = "one", actor = owner, actorRoles: readonly ("author" | "admin" | "approver")[] = roles) => runtime.execute(workspace, actor, actorRoles, raw, 2);
  return { directory, repo, data, pipelines, runtime, run, configuration, act,
    attach: () => act({ action: "attach", project: { root: repo, checks } }),
    start: (requestId = randomUUID()) => act({ action: "start", runId: run.id, expectedRevision: run.revision, requestId }),
    async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("coding bot proposes, applies in its own checkout, validates and hands off through the existing gate", { timeout: 60_000 }, async () => {
  const f = fixture(codingModel(), true);
  try {
    await f.attach(); const requestId = randomUUID(); await f.start(requestId);
    const attempt = await idle(f.runtime);
    assert.equal(attempt.status, "ready", attempt.error);
    assert.equal(attempt.calls, 2); assert.equal(attempt.tokenUsage, null);
    assert.equal(readFileSync(join(f.repo, "answer.ts"), "utf8"), "export const answer = 0;\n");
    assert.equal(readFileSync(join(attempt.checkout, "answer.ts"), "utf8"), "export const answer = 0;\n");
    await f.start(requestId); assert.equal(f.runtime.snapshot("one").attempts.length, 1);
    const input = { attemptId: attempt.id, expectedHash: attempt.proposalHash };
    await assert.rejects(f.act({ action: "accept", ...input }), /Apply/);
    await assert.rejects(f.act({ action: "apply", ...input, expectedHash: "changed" }), /result changed/);
    await f.act({ action: "apply", ...input });
    assert.equal(readFileSync(join(attempt.checkout, "answer.ts"), "utf8"), "export const answer = 42;\n");
    await assert.rejects(f.act({ action: "accept", ...input }), /check must pass/);
    await f.act({ action: "checks", ...input });
    await f.act({ action: "accept", ...input });
    const run = f.pipelines.snapshot("one").runs[0]!;
    assert.equal(run.stages[0]!.status, "awaiting_review");
    assert.match(run.stages[0]!.output, /Proposal:/);
    assert.throws(() => f.pipelines.execute("one", owner, roles, { action: "approve", runId: run.id, expectedRevision: run.revision }, 2), /cannot approve/);
    assert.equal(readFileSync(join(f.repo, "answer.ts"), "utf8"), "export const answer = 0;\n");
    const html = botTimeline(f.runtime.snapshot("one"), run);
    assert.match(html, /coder bot/); assert.match(html, /Tokens and cost: unavailable/);
  } finally { await f.close(); }
});

test("reviewer bot cannot turn a model response into a file proposal", async () => {
  const f = fixture();
  try {
    const config = f.pipelines.snapshot("one").config;
    config.stages[0]!.bot!.kind = "reviewer";
    f.pipelines.execute("one", owner, roles, { action: "configure", expectedVersion: 2, config }, 2);
    const reviewRun = f.pipelines.execute("one", owner, roles, { action: "start", requestId: randomUUID(), title: "Review answer", brief: "Inspect only." }, 2).runs[0]!;
    await f.attach(); await f.act({ action: "start", runId: reviewRun.id, expectedRevision: 1, requestId: randomUUID() });
    const attempt = await idle(f.runtime);
    assert.equal(attempt.status, "failed"); assert.deepEqual(attempt.changes, []);
    assert.equal(f.pipelines.snapshot("one").runs[0]!.stages[0]!.status, "active");
  } finally { await f.close(); }
});

test("other workspaces and actors cannot operate an attempt, and stale file proposals are refused", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.act({ action: "attach", project: { root: f.repo, checks: [] } }, "one", "writer", ["author"]), /admin/);
    await f.attach();
    await assert.rejects(f.act({ action: "start", runId: f.run.id, expectedRevision: 1, requestId: randomUUID() }, "one", "other", ["author"]), /owner/);
    await f.start(); const attempt = await idle(f.runtime);
    const input = { action: "apply", attemptId: attempt.id, expectedHash: attempt.proposalHash };
    await assert.rejects(f.act(input, "two"), /not found/);
    writeFileSync(join(attempt.checkout, "answer.ts"), "developer edit\n");
    await assert.rejects(f.act(input), /file changed/);
    assert.equal(readFileSync(join(attempt.checkout, "answer.ts"), "utf8"), "developer edit\n");
  } finally { await f.close(); }
});

test("validation failures and edits after validation cannot be accepted", async () => {
  const f = fixture(codingModel(), false, [{ executable: "node", args: ["--eval", "process.exit(3)"] }]);
  try {
    await f.attach(); await f.start(); const attempt = await idle(f.runtime);
    const input = { attemptId: attempt.id, expectedHash: attempt.proposalHash };
    await f.act({ action: "apply", ...input }); await f.act({ action: "checks", ...input });
    assert.equal(f.runtime.snapshot("one").attempts[0]!.checks[0]!.exitCode, 3);
    await assert.rejects(f.act({ action: "accept", ...input }), /check must pass/);
    assert.equal(f.pipelines.snapshot("one").runs[0]!.current, 0);
  } finally { await f.close(); }
  const passing = fixture();
  try {
    await passing.attach(); await passing.start(); const attempt = await idle(passing.runtime);
    const input = { attemptId: attempt.id, expectedHash: attempt.proposalHash };
    await passing.act({ action: "apply", ...input }); await passing.act({ action: "checks", ...input });
    writeFileSync(join(attempt.checkout, "other.ts"), "new unchecked source\n");
    await assert.rejects(passing.act({ action: "accept", ...input }), /changed after validation/);
  } finally { await passing.close(); }
});

test("cancellation settles providers that ignore AbortSignal without advancing the workflow", async () => {
  const f = fixture({ invoke: () => new Promise(() => {}) });
  try {
    await f.attach(); await f.start();
    const attempt = f.runtime.snapshot("one").attempts[0]!;
    await f.act({ action: "cancel", attemptId: attempt.id, expectedHash: "" });
    const stopped = await idle(f.runtime);
    assert.equal(stopped.status, "cancelled");
    assert.equal(f.pipelines.snapshot("one").runs[0]!.revision, 1);
  } finally { await f.close(); }
});

test("attempts survive restart and an unfinished record is recovered as interrupted", async () => {
  const f = fixture();
  try {
    await f.attach(); await f.start(); const attempt = await idle(f.runtime);
    await f.runtime.close();
    const file = join(f.data, readdirSync(f.data).find(name => name.endsWith(".json"))!);
    const data = JSON.parse(readFileSync(file, "utf8")); data.attempts[0].status = "running";
    writeFileSync(file, JSON.stringify(data));
    const reopened = createBotRuntime(f.data, f.pipelines, f.configuration);
    try {
      assert.equal(reopened.snapshot("one").attempts[0]!.id, attempt.id);
      assert.equal(reopened.snapshot("one").attempts[0]!.status, "interrupted");
      assert.equal(reopened.snapshot("one").busy, false);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("project tools reject traversal, metadata, secrets and hard links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-project-tools-"));
  try {
    writeFileSync(join(directory, "visible.ts"), "safe");
    for (const path of ["../outside", "/absolute", ".git/config", ".env", "src/../../outside", "C:/outside", "NUL", "NUL.txt", "a:stream", "folder./file", "node_modules/pkg/code.js"]) assert.throws(() => projectPath(directory, path));
    const outside = join(directory, "original.txt"); writeFileSync(outside, "private");
    linkSync(outside, join(directory, "linked.ts"));
    assert.throws(() => readProjectFile(directory, "linked.ts"), /Linked/);
    assert.throws(() => applyChanges(directory, [{ path: "visible.ts", before: "stale", after: "changed" }]), /changed/);
    assert.equal(readFileSync(join(directory, "visible.ts"), "utf8"), "safe");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bot policy is strict, bounded and backward compatible with existing stages", () => {
  assert.ok(pipelineSchema.safeParse(DEFAULT_PIPELINE).success);
  for (const bot of [{ kind: "coder", maxSteps: 0, timeoutSeconds: 15 }, { kind: "coder", maxSteps: 1, timeoutSeconds: 999 }, { kind: "coder", maxSteps: 1, timeoutSeconds: 15, shell: true }]) {
    assert.equal(pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], bot }] }).success, false);
  }
});

test("validation fingerprints include files beyond the 300-item model listing", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 305; index++) writeFileSync(join(f.repo, `file-${String(index).padStart(3, "0")}.ts`), "a");
    assert.equal((await listProjectFiles(f.repo)).length, 300);
    const before = await treeDigest(f.repo);
    writeFileSync(join(f.repo, "file-304.ts"), "b");
    assert.notEqual(await treeDigest(f.repo), before);
  } finally { await f.close(); }
});
