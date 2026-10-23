import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { atomicJson } from "../bot-project.js";
import { hashRelease, hashTrainingConfig, sha256, studioStateSchema, validApproversOf, type StudioState } from "./schema.js";

/**
 * Durable storage for the Model Studio.
 *
 * One JSON document per workspace, rewritten whole on every commit, with the
 * same temp file, fsync and rename sequence the workspace store uses. Dataset
 * content is kept out of the document: each dataset is a separate file named
 * by its content hash, so the document stays small and a dataset is never
 * duplicated.
 *
 * This store does not take its own writer lock. It lives under the local
 * application's data directory and relies on the application holding the
 * workspace writer lock for the whole process, as the bot runtime does.
 */

export const STUDIO_STORAGE_VERSION = 1;

export class StudioStorageError extends Error {}

export interface StudioPersistence {
  read(workspace: string): StudioState | undefined;
  /** Returning means the state is durable. Throwing means nothing changed. */
  commit(workspace: string, state: StudioState): void;
}

export interface DatasetFiles {
  /** Keep a copy of this content. The name is its hash, so identical content is stored once. */
  store(text: string): { file: string; bytes: number; contentHash: string };
  /** Copy a file from the import directory into managed storage. */
  importFile(path: string): { file: string; bytes: number; contentHash: string };
  read(file: string): string;
}

const documentSchema = studioStateSchema.extend({
  storageVersion: z.number().int(),
  workspaceId: z.string().min(1),
}).strict();

// ------------------------------------------------------------------ coherence

/**
 * Rules that need the whole document.
 *
 * A file can satisfy every per-record schema and still describe something
 * the engine could never have produced: a job for a config that does not
 * exist, an approved release with one signature, a release whose hash no
 * longer matches the artifact it claims to bind. Those are what a
 * hand-edited or half-written file looks like, and acting on one would mean
 * serving an unapproved model or trusting an approval that was signed over
 * different content.
 */
export function assertStudioCoherent(state: StudioState, workspace: string): void {
  const fail = (message: string): never => {
    throw new StudioStorageError(`Model Studio data for ${workspace} is not internally consistent: ${message}`);
  };
  const byId = <T extends { id: string }>(items: T[], what: string): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of items) {
      if (map.has(item.id)) fail(`two ${what} share id ${item.id}.`);
      map.set(item.id, item);
    }
    return map;
  };

  const projects = byId(state.projects, "projects");
  const datasets = byId(state.datasets, "datasets");
  const configs = byId(state.configs, "configs");
  const jobs = byId(state.jobs, "jobs");
  const evaluations = byId(state.evaluations, "evaluations");
  const releases = byId(state.releases, "releases");
  byId(state.profiles, "profiles");

  for (const project of projects.values()) {
    if (project.workspaceId !== workspace) fail(`project ${project.id} belongs to ${project.workspaceId}.`);
  }
  for (const dataset of datasets.values()) {
    if (!projects.has(dataset.projectId)) fail(`dataset ${dataset.id} points at a missing project.`);
    if (dataset.file !== `${dataset.contentHash}.jsonl`) fail(`dataset ${dataset.id} is stored under a different hash.`);
    if (dataset.validation && dataset.validation.contentHash !== dataset.contentHash) fail(`dataset ${dataset.id} carries a validation of different content.`);
    if (dataset.status === "valid" && !dataset.validation?.passed) fail(`dataset ${dataset.id} is valid without a passing validation.`);
    if (dataset.status === "rejected" && dataset.validation?.passed !== false) fail(`dataset ${dataset.id} is rejected without a failed validation.`);
  }
  for (const config of configs.values()) {
    const dataset = datasets.get(config.datasetId);
    if (!dataset) fail(`config ${config.id} points at a missing dataset.`);
    if (dataset!.projectId !== config.projectId) fail(`config ${config.id} uses a dataset from another project.`);
    const expected = hashTrainingConfig({ projectId: config.projectId, datasetId: config.datasetId, datasetHash: dataset!.contentHash,
      provider: config.provider, baseModel: config.baseModel, hyperparameters: config.hyperparameters });
    if (config.hash !== expected) fail(`config ${config.id} has a hash that does not match its content.`);
  }
  for (const job of jobs.values()) {
    const config = configs.get(job.configId);
    if (!config) fail(`job ${job.id} points at a missing config.`);
    if (config!.projectId !== job.projectId) fail(`job ${job.id} belongs to a different project than its config.`);
    if (config!.provider !== job.provider) fail(`job ${job.id} names a different provider than its config.`);
    if ((job.status === "succeeded") !== Boolean(job.artifact)) fail(`job ${job.id} is ${job.status} ${job.artifact ? "with" : "without"} an artifact.`);
    if (job.status !== "running" && !job.finishedAt) fail(`job ${job.id} is ${job.status} with no finish time.`);
  }
  for (const evaluation of evaluations.values()) {
    const job = jobs.get(evaluation.jobId);
    if (!job) fail(`evaluation ${evaluation.id} points at a missing job.`);
    if (job!.status !== "succeeded") fail(`evaluation ${evaluation.id} was run on a job that did not succeed.`);
    if (job!.projectId !== evaluation.projectId) fail(`evaluation ${evaluation.id} belongs to a different project than its job.`);
    if (evaluation.baseline.releaseId && !releases.has(evaluation.baseline.releaseId)) fail(`evaluation ${evaluation.id} compares against a missing release.`);
    const passed = evaluation.comparison.length > 0 && evaluation.comparison.every((row) => row.passed);
    if (evaluation.passed !== passed) fail(`evaluation ${evaluation.id} records a verdict its comparison does not support.`);
  }
  for (const release of releases.values()) {
    const job = jobs.get(release.jobId);
    const evaluation = evaluations.get(release.evaluationId);
    if (!job || !evaluation) fail(`release ${release.id} points at a missing job or evaluation.`);
    if (evaluation!.jobId !== job!.id) fail(`release ${release.id} pairs an evaluation with a job it did not evaluate.`);
    if (job!.projectId !== release.projectId) fail(`release ${release.id} belongs to a different project than its job.`);
    if (!evaluation!.passed) fail(`release ${release.id} was requested from a failed evaluation.`);
    const config = configs.get(job!.configId)!;
    const expected = hashRelease({ projectId: release.projectId, jobId: job!.id, configHash: config.hash, artifact: job!.artifact!,
      evaluationId: evaluation!.id, metrics: evaluation!.metrics, passed: evaluation!.passed });
    if (release.contentHash !== expected) fail(`release ${release.id} has a hash that does not match what it binds.`);
    // The rules approvals were checked against when they were made must
    // still hold in the file, or an approval could be smuggled in by editing.
    const approvers = new Set<string>();
    for (const approval of release.approvals) {
      if (approvers.has(approval.actor)) fail(`release ${release.id} records ${approval.actor} twice.`);
      approvers.add(approval.actor);
    }
    if (release.status === "approved" && validApproversOf(release).length < release.requiredApprovals) {
      fail(`release ${release.id} is approved with ${validApproversOf(release).length} of ${release.requiredApprovals} valid approvals.`);
    }
    if ((release.status === "rejected" || release.status === "retired") && !release.decision) fail(`release ${release.id} is ${release.status} with no decision recorded.`);
  }
  for (const profile of state.profiles) {
    if (profile.workspaceId !== workspace) fail(`profile ${profile.id} belongs to ${profile.workspaceId}.`);
    if (!releases.has(profile.releaseId)) fail(`profile ${profile.id} points at a missing release.`);
  }
}

// ---------------------------------------------------------------- memory mode

export function memoryStudioStore(): StudioPersistence {
  const states = new Map<string, StudioState>();
  return {
    read(workspace) {
      const state = states.get(workspace);
      return state ? structuredClone(state) : undefined;
    },
    commit(workspace, state) {
      studioStateSchema.parse(state);
      assertStudioCoherent(state, workspace);
      states.set(workspace, structuredClone(state));
    },
  };
}

export function memoryDatasetFiles(): DatasetFiles {
  const files = new Map<string, string>();
  return {
    store(text) {
      const contentHash = sha256(text);
      const file = `${contentHash}.jsonl`;
      files.set(file, text);
      return { file, bytes: Buffer.byteLength(text, "utf8"), contentHash };
    },
    importFile() {
      throw new StudioStorageError("Importing a file needs file storage. Paste the records instead.");
    },
    read(file) {
      const text = files.get(file);
      if (text === undefined) throw new StudioStorageError("The dataset content is no longer available.");
      return text;
    },
  };
}

// ------------------------------------------------------------------ file mode

/** One file name per workspace, sanitized plus a hash of the exact name. Same scheme as the workspace store. */
function fileNameFor(workspace: string): string {
  const trimmed = workspace.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || trimmed.length > 100) {
    throw new StudioStorageError(`"${workspace}" is not a usable workspace name.`);
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
  return `${safe}-${sha256(trimmed).slice(0, 32)}.json`;
}

export function fileStudioStore(directory: string): StudioPersistence {
  mkdirSync(directory, { recursive: true });
  return {
    read(workspace) {
      const path = join(directory, fileNameFor(workspace));
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new StudioStorageError(`Model Studio data for ${workspace} could not be read.`, { cause });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        throw new StudioStorageError(`Model Studio data for ${workspace} is not valid JSON. The file at ${path} was left untouched.`, { cause });
      }
      const envelope = z.object({ storageVersion: z.number().int() }).safeParse(parsed);
      if (envelope.success && envelope.data.storageVersion !== STUDIO_STORAGE_VERSION) {
        throw new StudioStorageError(`Model Studio data for ${workspace} has storage version ${envelope.data.storageVersion}; this build reads version ${STUDIO_STORAGE_VERSION}.`);
      }
      const document = documentSchema.safeParse(parsed);
      if (!document.success) {
        const detail = document.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
        throw new StudioStorageError(`Model Studio data for ${workspace} is not a valid document. ${detail}. The file at ${path} was left untouched.`);
      }
      if (document.data.workspaceId !== workspace) throw new StudioStorageError(`Model Studio data at ${path} is labelled ${document.data.workspaceId}, not ${workspace}.`);
      const { storageVersion: _version, workspaceId: _workspace, ...state } = document.data as unknown as StudioState & { storageVersion: number; workspaceId: string };
      assertStudioCoherent(state, workspace);
      return state;
    },
    commit(workspace, state) {
      const document = { storageVersion: STUDIO_STORAGE_VERSION, workspaceId: workspace, ...state };
      const checked = documentSchema.safeParse(document);
      if (!checked.success) throw new StudioStorageError(`Refusing to write Model Studio data for ${workspace}: ${checked.error.issues[0]?.message ?? "invalid document"}.`);
      assertStudioCoherent(state, workspace);
      try {
        atomicJson(join(directory, fileNameFor(workspace)), document);
      } catch (cause) {
        throw new StudioStorageError(`Model Studio data for ${workspace} could not be saved. No change was made.`, { cause });
      }
    },
  };
}

/**
 * Dataset content on disk.
 *
 * Managed copies live under <directory>/datasets. Imports are only accepted
 * from <importDirectory>, resolved through symlinks, so a request from the
 * browser cannot name an arbitrary file on the machine and have the server
 * copy it into training data.
 */
export function fileDatasetFiles(directory: string, importDirectory: string): DatasetFiles {
  const managed = join(directory, "datasets");
  mkdirSync(managed, { recursive: true });
  mkdirSync(importDirectory, { recursive: true });
  const importRoot = realpathSync(importDirectory);

  function keep(text: string) {
    const contentHash = sha256(text);
    const file = `${contentHash}.jsonl`;
    const path = join(managed, file);
    try {
      statSync(path);
    } catch {
      atomicText(path, text);
    }
    return { file, bytes: Buffer.byteLength(text, "utf8"), contentHash };
  }

  return {
    store: keep,
    importFile(requested) {
      let real: string;
      try {
        real = realpathSync(resolve(importRoot, requested));
      } catch {
        throw new StudioStorageError(`No file named ${requested} in the dataset import folder.`);
      }
      // Containment is checked on the resolved path, so neither ".." nor a
      // symlink inside the folder can reach outside it.
      const inside = relative(importRoot, real);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
        throw new StudioStorageError("Datasets can only be imported from the dataset import folder.");
      }
      const info = statSync(real);
      if (!info.isFile()) throw new StudioStorageError("The import path is not a file.");
      if (info.size > 20 * 1024 * 1024) throw new StudioStorageError("Dataset files larger than 20 MB are refused.");
      return keep(readFileSync(real, "utf8"));
    },
    read(file) {
      if (!/^[0-9a-f]{64}\.jsonl$/.test(file)) throw new StudioStorageError("Not a managed dataset file.");
      try {
        return readFileSync(join(managed, file), "utf8");
      } catch (cause) {
        throw new StudioStorageError("The dataset content is missing from managed storage.", { cause });
      }
    },
  };
}

/** atomicJson serializes; dataset content is already text. Same temp, fsync, rename sequence. */
function atomicText(path: string, text: string): void {
  const temporary = `${path}.tmp-${sha256(`${Date.now()}:${Math.random()}`).slice(0, 8)}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
