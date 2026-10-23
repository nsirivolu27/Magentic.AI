import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModelStudio, fileModelStudio, memoryModelStudio, StudioError, type ModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { localDevProvider } from "../workbench/studio/provider.js";
import { memoryDatasetFiles, memoryStudioStore, StudioStorageError } from "../workbench/studio/store.js";
import type { StudioState } from "../workbench/studio/schema.js";

const W = "studio-workspace";
const AUTHOR = "alex";
const REVIEWER = "sam";
const SECOND = "jordan";
const ADMIN = "taylor";

/** Enough coding-assistant records to clear the recipe's coverage threshold. */
function goodDataset(count = 50): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [
    { role: "user", content: `How do I rename variable ${index}?` },
    { role: "assistant", content: `Use the rename refactor on variable ${index} and run the tests.` },
  ] })).join("\n");
}

function run(studio: ModelStudio, actor: string, roles: ("author" | "approver" | "admin")[], command: Record<string, unknown>, approvals = 2): StudioSnapshot {
  return studio.execute(W, actor, roles, command, approvals);
}

function refuse(status: number, pattern: RegExp, action: () => unknown): void {
  try { action(); } catch (error) {
    assert.ok(error instanceof StudioError, `expected a StudioError, got ${(error as Error).message}`);
    assert.equal(error.status, status, error.message);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected the command to be refused");
}

/** The whole slice up to an approved release, returning the ids each step produced. */
function journey(studio: ModelStudio, text = goodDataset()) {
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "Repo helper", recipeId: "coding-assistant", purpose: "Answer repo questions." });
  const project = s.projects[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "Q&A pairs", source: { kind: "inline", text } });
  const dataset = s.datasets[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: dataset.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" });
  const config = s.configs[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: config.id });
  const job = s.jobs[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: job.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: job.id });
  const evaluation = s.evaluations[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: evaluation.id });
  const release = s.releases[0]!;
  s = run(studio, REVIEWER, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = run(studio, SECOND, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash, note: "Looks right." });
  return { snapshot: s, project, dataset, config, job, evaluation, release: s.releases[0]! };
}

test("the vertical slice runs from project to chat profile with persisted, hashed records", () => {
  const studio = memoryModelStudio({ now: () => "2026-09-25T12:00:00.000Z" });
  const { snapshot, release, job, evaluation } = journey(studio);

  assert.equal(snapshot.datasets[0]!.status, "valid");
  assert.equal(snapshot.datasets[0]!.validation?.records, 50);
  assert.equal(job.status, "running", "a job starts running");
  assert.equal(snapshot.jobs[0]!.status, "succeeded");
  assert.equal(snapshot.jobs[0]!.artifact?.label, "development", "the dev provider never claims trained weights");
  assert.match(snapshot.jobs[0]!.artifact!.note, /No model weights were trained/);
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.baseline.source, "recipe");
  assert.deepEqual(evaluation.metrics, { recordValidity: 1, uniqueness: 1, secretHygiene: 1, coverage: 1 });
  assert.equal(release.status, "approved");
  assert.equal(release.approvals.length, 2);
  assert.equal(release.version, 1);

  const withProfile = run(studio, AUTHOR, ["author"], { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const profile = withProfile.profiles[0]!;
  assert.equal(profile.status, "active");
  assert.match(profile.instructions, /help engineers/, "instructions default to the recipe");

  const resolved = studio.resolveProfile(W, profile.id);
  assert.equal(resolved.release.id, release.id);
  assert.equal(resolved.job.artifact?.label, "development");

  const actions = withProfile.events.map((event) => `${event.entity}:${event.action}`);
  assert.deepEqual(actions, ["project:created", "dataset:registered", "dataset:validated", "config:configured", "job:started", "job:succeeded",
    "evaluation:passed", "release:requested", "release:signed", "release:approved", "profile:assigned"]);
  for (const event of withProfile.events) assert.doesNotMatch(event.detail, /rename variable/, "audit events never carry dataset content");
});

test("steps cannot be skipped", () => {
  const studio = memoryModelStudio();
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "it-support" });
  const project = s.projects[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "inline", text: goodDataset(5) } });
  const dataset = s.datasets[0]!;
  refuse(409, /Validate the dataset/, () => run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" }));
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: dataset.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" });
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: s.configs[0]!.id });
  const job = s.jobs[0]!;
  refuse(409, /succeeded job/, () => run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: job.id }));
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: job.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: job.id });
  // Five records against a 100-record recipe: coverage fails the threshold.
  const evaluation = s.evaluations[0]!;
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.comparison.find((row) => row.metric === "coverage")?.passed, false);
  refuse(409, /passed evaluation/, () => run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: evaluation.id }));
});

test("a rejected dataset blocks training and names line numbers, not content", () => {
  const studio = memoryModelStudio();
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  const project = s.projects[0]!;
  const text = [goodDataset(3), JSON.stringify({ messages: [{ role: "user", content: "key" }, { role: "assistant", content: "AKIAABCDEFGHIJKLMNOP is the key" }] }), "not json"].join("\n");
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "inline", text } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  const dataset = s.datasets[0]!;
  assert.equal(dataset.status, "rejected");
  assert.equal(dataset.validation?.secretFindings, 1);
  assert.deepEqual(dataset.validation?.issues.map((issue) => [issue.line, issue.code]), [[4, "secret"], [5, "invalid-json"]]);
  assert.doesNotMatch(JSON.stringify(dataset.validation), /AKIA/, "the credential never enters the record");
  assert.doesNotMatch(JSON.stringify(s.events), /AKIA/, "nor the audit trail");
  refuse(409, /Validate the dataset/, () => run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" }));
});

test("approvals need distinct approvers on the current hash, and the requester cannot sign", () => {
  const studio = memoryModelStudio();
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  const project = s.projects[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "inline", text: goodDataset() } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;

  refuse(403, /cannot approve it/, () => run(studio, AUTHOR, ["author", "approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }));
  refuse(403, /cannot approve it/, () => run(studio, AUTHOR, ["admin"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }), );
  refuse(403, /Approvers and admins/, () => run(studio, REVIEWER, ["author"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }));
  refuse(409, /changed/, () => run(studio, REVIEWER, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: "0".repeat(64) }));

  s = run(studio, REVIEWER, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  assert.equal(s.releases[0]!.status, "pending_approval", "one of two approvals");
  refuse(409, /already approved/, () => run(studio, REVIEWER, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }));
  refuse(409, /approved release/, () => run(studio, AUTHOR, ["author"], { action: "assign_profile", name: "Bot", releaseId: release.id }));

  s = run(studio, ADMIN, ["admin"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  assert.equal(s.releases[0]!.status, "approved", "an admin who did not request it counts as a distinct approver");
});

test("allowSelfApproval is a deployment policy, recorded on the release", () => {
  const studio = memoryModelStudio({ allowSelfApproval: true });
  let s = run(studio, AUTHOR, ["author", "approver"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: s.projects[0]!.id, name: "D", source: { kind: "inline", text: goodDataset() } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: s.projects[0]!.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id }, 1);
  const release = s.releases[0]!;
  assert.equal(release.allowSelfApproval, true);
  s = run(studio, AUTHOR, ["author", "approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash }, 1);
  assert.equal(s.releases[0]!.status, "approved");
});

test("retiring a release disables its profiles and the chat layer refuses them", () => {
  const studio = memoryModelStudio();
  const { release } = journey(studio);
  let s = run(studio, AUTHOR, ["author"], { action: "assign_profile", name: "Bot", releaseId: release.id });
  const profile = s.profiles[0]!;
  assert.ok(studio.resolveProfile(W, profile.id));
  refuse(403, /requester or an admin/, () => run(studio, REVIEWER, ["approver"], { action: "retire_release", releaseId: release.id, note: "Old." }));
  s = run(studio, ADMIN, ["admin"], { action: "retire_release", releaseId: release.id, note: "Superseded." });
  assert.equal(s.releases[0]!.status, "retired");
  assert.equal(s.profiles[0]!.status, "disabled");
  refuse(409, /disabled/, () => studio.resolveProfile(W, profile.id));
  refuse(404, /not found/, () => studio.resolveProfile(W, "00000000-0000-4000-8000-000000000000"));
});

test("a second release is compared against the approved one", () => {
  const studio = memoryModelStudio();
  const first = journey(studio);
  // A smaller dataset on the same project: coverage drops from 1 to 0.4,
  // which fails both the threshold and the regression check.
  let s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: first.project.id, name: "Smaller", source: { kind: "inline", text: goodDataset(20) } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[1]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: first.project.id, datasetId: s.datasets[1]!.id, provider: "local-dev" });
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: s.configs[1]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: s.jobs[1]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: s.jobs[1]!.id });
  const evaluation = s.evaluations[1]!;
  assert.equal(evaluation.baseline.source, "release");
  assert.equal(evaluation.baseline.releaseId, first.release.id);
  assert.equal(evaluation.baseline.metrics.coverage, 1);
  assert.equal(evaluation.passed, false);
});

test("the dev provider is deterministic and can be cancelled only before its first check", () => {
  const provider = localDevProvider({ now: () => "2026-01-01T00:00:00.000Z" });
  const config = { baseModel: "m", hyperparameters: { epochs: 2, learningRate: 0.0001, batchSize: 4 } };
  const dataset = { contentHash: "a".repeat(64), records: 10, bytes: 100 };
  const one = provider.startJob(config, dataset, "b".repeat(64));
  const two = provider.startJob(config, dataset, "b".repeat(64));
  assert.equal(one.providerJobId, two.providerJobId);
  assert.equal(provider.cancelJob(one.providerJobId).status, "cancelled");
  const three = provider.startJob(config, dataset, "c".repeat(64));
  assert.equal(provider.getJob(three.providerJobId).status, "succeeded");
  assert.equal(provider.cancelJob(three.providerJobId).status, "succeeded", "too late to cancel");
  assert.equal(provider.resolveArtifact(three.providerJobId)?.label, "development");
  assert.equal(provider.resolveArtifact(three.providerJobId)?.hash, provider.resolveArtifact(three.providerJobId)?.hash);
  assert.deepEqual(provider.validateConfiguration({ baseModel: "m", hyperparameters: { epochs: 12, learningRate: 0.5, batchSize: 1 } }).length, 2);
  assert.equal(provider.getJob("not-a-dev-job").status, "failed");
});

test("file mode survives a restart and refuses a file whose approval was edited in", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-"));
  const studio = fileModelStudio(directory, join(directory, "import"), { now: () => "2026-09-25T12:00:00.000Z" });
  const { release } = journey(studio);
  run(studio, AUTHOR, ["author"], { action: "assign_profile", name: "Bot", releaseId: release.id });

  const reopened = fileModelStudio(directory, join(directory, "import"));
  const snapshot = reopened.snapshot(W);
  assert.equal(snapshot.storage, "file");
  assert.equal(snapshot.releases[0]!.status, "approved");
  assert.equal(snapshot.profiles.length, 1);
  assert.ok(reopened.resolveProfile(W, snapshot.profiles[0]!.id));

  // Tamper: drop one signature but leave the release marked approved.
  const path = join(directory, `${W}-${createHash("sha256").update(W).digest("hex").slice(0, 32)}.json`);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.releases[0].approvals.pop();
  writeFileSync(path, JSON.stringify(document));
  const tampered = fileModelStudio(directory, join(directory, "import"));
  assert.throws(() => tampered.snapshot(W), (error: unknown) => error instanceof StudioStorageError && /approved with 1 of 2/.test((error as Error).message));
  refuse(409, /integrity check/, () => tampered.resolveProfile(W, snapshot.profiles[0]!.id));
});

test("file import is confined to the import folder", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-"));
  const importDirectory = join(directory, "import");
  const studio = fileModelStudio(directory, importDirectory);
  writeFileSync(join(directory, "outside.jsonl"), goodDataset(2));
  writeFileSync(join(importDirectory, "inside.jsonl"), goodDataset(2));
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  const project = s.projects[0]!;
  refuse(400, /import folder/, () => run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "file", path: "../outside.jsonl" } }));
  refuse(400, /import folder/, () => run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "file", path: join(directory, "outside.jsonl") } }));
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "D", source: { kind: "file", path: "inside.jsonl" } });
  assert.equal(s.datasets[0]!.bytes, Buffer.byteLength(goodDataset(2)));
});

test("a refused commit leaves the published state untouched", () => {
  const persistence = memoryStudioStore();
  let fail = false;
  const studio = createModelStudio({ storage: "memory", files: memoryDatasetFiles(), persistence: {
    read: persistence.read, commit(workspace, state) { if (fail) throw new Error("disk full"); persistence.commit(workspace, state); },
  } });
  run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  fail = true;
  assert.throws(() => run(studio, AUTHOR, ["author"], { action: "create_project", name: "Q", recipeId: "coding-assistant" }), /disk full/);
  assert.equal(studio.snapshot(W).projects.length, 1);
});

test("commands are strict and roles are enforced", () => {
  const studio = memoryModelStudio();
  assert.throws(() => run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant", extra: 1 }));
  assert.throws(() => run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "not-a-recipe" }));
  refuse(403, /Authors and admins/, () => run(studio, REVIEWER, ["approver"], { action: "create_project", name: "P", recipeId: "coding-assistant" }));
});

test("training and release requests re-derive their evidence and refuse edited results", () => {
  // A store that keeps whatever it is given, so a test can edit it the way a
  // hand-edited file would be edited, with every cross-record check still true.
  let saved: StudioState | undefined;
  const studio = createModelStudio({ storage: "memory", files: memoryDatasetFiles(), persistence: {
    read: () => (saved ? structuredClone(saved) : undefined),
    commit: (_workspace, state) => { saved = structuredClone(state); },
  } });
  let s = run(studio, AUTHOR, ["author"], { action: "create_project", name: "P", recipeId: "coding-assistant" });
  const project = s.projects[0]!;
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "Small", source: { kind: "inline", text: goodDataset(12) } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = run(studio, AUTHOR, ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = run(studio, AUTHOR, ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  assert.equal(s.evaluations[0]!.passed, false);

  // Edit the failed evaluation so it reads as passed.
  const evaluation = saved!.evaluations[0]!;
  evaluation.metrics.coverage = 1;
  evaluation.comparison = evaluation.comparison.map((row) => row.metric === "coverage" ? { ...row, value: 1, passed: true } : row);
  evaluation.passed = true;
  refuse(409, /the evaluation score changed after it was produced/, () => run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: evaluation.id }));

  // Lower the baseline instead of the score.
  evaluation.metrics.coverage = 0.24;
  evaluation.comparison = evaluation.comparison.map((row) => row.metric === "coverage" ? { ...row, value: 0.24, threshold: 0.2, passed: true } : row);
  evaluation.thresholds.coverage = 0.2;
  refuse(409, /the evaluation thresholds changed after it was produced/, () => run(studio, AUTHOR, ["author"], { action: "request_release", evaluationId: evaluation.id }));

  // A rejected dataset with a credential, edited to look valid, cannot be trained on.
  const leaky = [goodDataset(3), JSON.stringify({ messages: [{ role: "user", content: "key" }, { role: "assistant", content: "AKIAIOSFODNN7EXAMPLE" }] })].join("\n");
  s = run(studio, AUTHOR, ["author"], { action: "register_dataset", projectId: project.id, name: "Leaky", source: { kind: "inline", text: leaky } });
  s = run(studio, AUTHOR, ["author"], { action: "validate_dataset", datasetId: s.datasets[1]!.id });
  const dataset = saved!.datasets[1]!;
  assert.equal(dataset.status, "rejected");
  dataset.status = "valid";
  Object.assign(dataset.validation!, { passed: true, rejected: 0, secretFindings: 0, issues: [] });
  refuse(409, /the dataset validation changed after it was produced/, () => run(studio, AUTHOR, ["author"], { action: "configure_training", projectId: project.id, datasetId: dataset.id, provider: "local-dev" }));
  assert.equal(saved!.configs.length, 1, "nothing was saved for the refused configuration");
});
