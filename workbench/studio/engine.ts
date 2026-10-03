import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Role } from "../../registry/roles.js";
import type { StorageMode } from "../pipeline.js";
import { validateJsonl } from "./dataset.js";
import { compareMetrics, developmentEvaluator, type Evaluator } from "./evaluation.js";
import { listRecipes, recipeFor, type Recipe } from "./recipes.js";
import { localDevProvider, type TrainingProvider } from "./provider.js";
import {
  canonical, hashRelease, hashTrainingConfig, hyperparametersSchema, RECIPE_IDS, validApproversOf, emptyStudioState,
  type ChatbotProfile, type Dataset, type DatasetValidation, type EvaluationRun, type ModelProject, type ModelRelease, type StudioEvent, type StudioState,
  type TrainingConfig, type TrainingJob,
} from "./schema.js";
import { fileDatasetFiles, fileStudioStore, memoryDatasetFiles, memoryStudioStore, StudioStorageError, type DatasetFiles, type StudioPersistence } from "./store.js";

/**
 * The Model Studio engine.
 *
 * One synchronous command at a time, like the pipeline engine: read the
 * state, check who is asking and what they are allowed to do, check the
 * record is in a state that permits the step, make the change on a working
 * copy, commit, publish. A failed commit leaves the published state as it
 * was, so a caller never sees a half-applied step.
 *
 * The order of steps is enforced by what each command requires, not by a
 * flag. A config needs a valid dataset. A job needs a config. An evaluation
 * needs a succeeded job. A release needs a passed evaluation. A profile
 * needs an approved release. Skipping a step is not a state the data can
 * express.
 */

export class StudioError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const id = z.string().uuid();
const title = z.string().trim().min(1).max(120);
const note = z.string().trim().max(2_000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const studioCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_project"), name: title, recipeId: z.enum(RECIPE_IDS), purpose: z.string().trim().max(1_000).default("") }).strict(),
  z.object({ action: z.literal("archive_project"), projectId: id }).strict(),
  z.object({ action: z.literal("register_dataset"), projectId: id, name: title,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("inline"), text: z.string().min(1).max(48_000) }).strict(),
      z.object({ kind: z.literal("file"), path: z.string().trim().min(1).max(500) }).strict(),
    ]) }).strict(),
  z.object({ action: z.literal("validate_dataset"), datasetId: id }).strict(),
  z.object({ action: z.literal("configure_training"), projectId: id, datasetId: id, provider: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    baseModel: z.string().trim().min(1).max(200).optional(), hyperparameters: hyperparametersSchema.partial().optional() }).strict(),
  z.object({ action: z.literal("create_job"), configId: id }).strict(),
  z.object({ action: z.literal("record_job"), jobId: id }).strict(),
  z.object({ action: z.literal("cancel_job"), jobId: id }).strict(),
  z.object({ action: z.literal("run_evaluation"), jobId: id }).strict(),
  z.object({ action: z.literal("request_release"), evaluationId: id, note: note.optional() }).strict(),
  z.object({ action: z.literal("approve_release"), releaseId: id, expectedHash: hash, note: note.optional() }).strict(),
  z.object({ action: z.literal("reject_release"), releaseId: id, expectedHash: hash, note: note.min(1) }).strict(),
  z.object({ action: z.literal("retire_release"), releaseId: id, note: note.min(1) }).strict(),
  z.object({ action: z.literal("assign_profile"), name: title, releaseId: id, instructions: z.string().trim().min(1).max(4_000).optional() }).strict(),
  z.object({ action: z.literal("disable_profile"), profileId: id }).strict(),
]);
export type StudioCommand = z.infer<typeof studioCommandSchema>;

export interface StudioSnapshot extends StudioState {
  storage: StorageMode;
  recipes: Recipe[];
  providers: { id: string; label: string }[];
  evaluator: { id: string; note: string };
  allowSelfApproval: boolean;
}

/** Everything the chat layer needs to speak as a profile, checked. */
export interface ResolvedProfile {
  profile: ChatbotProfile;
  release: ModelRelease;
  project: ModelProject;
  recipe: Recipe;
  job: TrainingJob;
  config: TrainingConfig;
}

export interface ModelStudio {
  snapshot(workspace: string): StudioSnapshot;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number): StudioSnapshot;
  /** Throws a StudioError unless the profile may answer right now. */
  resolveProfile(workspace: string, profileId: string): ResolvedProfile;
}

export interface StudioOptions {
  persistence: StudioPersistence;
  files: DatasetFiles;
  storage: StorageMode;
  providers?: TrainingProvider[];
  evaluator?: Evaluator;
  /** Mirrors the registry policy. Off unless a deployment says otherwise. */
  allowSelfApproval?: boolean;
  now?: () => string;
}

export function memoryModelStudio(options: Partial<Omit<StudioOptions, "persistence" | "files" | "storage">> = {}): ModelStudio {
  return createModelStudio({ persistence: memoryStudioStore(), files: memoryDatasetFiles(), storage: "memory", ...options });
}

/** File mode. `directory` is the studio's own folder; imports come from `importDirectory`. */
export function fileModelStudio(directory: string, importDirectory: string, options: Partial<Omit<StudioOptions, "persistence" | "files" | "storage">> = {}): ModelStudio {
  return createModelStudio({ persistence: fileStudioStore(directory), files: fileDatasetFiles(directory, importDirectory), storage: "file", ...options });
}

const MAX_EVENTS = 500;

export function createModelStudio(options: StudioOptions): ModelStudio {
  const now = options.now ?? (() => new Date().toISOString());
  const providers = new Map((options.providers ?? [localDevProvider()]).map((provider) => [provider.id, provider]));
  const evaluator = options.evaluator ?? developmentEvaluator();
  const allowSelfApproval = options.allowSelfApproval ?? false;

  // Always from storage, never from a cache. Reading runs every cross-record
  // and hash check, so a file edited underneath a running process is caught
  // on the next request rather than served from memory as if it were sound.
  // The documents are small; the read is cheap.
  function load(workspace: string): StudioState {
    return options.persistence.read(workspace) ?? emptyStudioState();
  }

  function snapshot(workspace: string): StudioSnapshot {
    return {
      ...load(workspace), storage: options.storage, recipes: listRecipes(),
      providers: [...providers.values()].map((provider) => ({ id: provider.id, label: provider.label })),
      evaluator: { id: evaluator.id, note: evaluator.note }, allowSelfApproval,
    };
  }

  function execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, requiredApprovals: number): StudioSnapshot {
    const command = studioCommandSchema.parse(raw);
    const state = load(workspace);
    const at = now();
    const admin = roles.includes("admin");
    const author = admin || roles.includes("author");
    const approver = admin || roles.includes("approver");
    const record = (entity: StudioEvent["entity"], entityId: string, action: string, detail: string) => {
      state.events.push({ id: randomUUID(), at, actor, entity, entityId, action, detail: detail.slice(0, 500) });
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    };
    const find = <T extends { id: string }>(items: T[], itemId: string, what: string): T => {
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) throw new StudioError(404, `${what} not found in this workspace.`);
      return item;
    };
    // Events name the project so the activity list says what was acted on,
    // not only which kind of record.
    const nameOf = (projectId: string) => state.projects.find((project) => project.id === projectId)?.name ?? "Unknown project";
    const requireAuthor = () => { if (!author) throw new StudioError(403, "Authors and admins can do this."); };
    const requireApprover = () => { if (!approver) throw new StudioError(403, "Approvers and admins can do this."); };
    const activeProject = (projectId: string): ModelProject => {
      const project = find(state.projects, projectId, "Project");
      if (project.status !== "active") throw new StudioError(409, "This project is archived.");
      return project;
    };
    const providerFor = (providerId: string): TrainingProvider => {
      const provider = providers.get(providerId);
      if (!provider) throw new StudioError(400, `Provider ${providerId} is not available in this deployment.`);
      return provider;
    };

    /**
     * Re-derives an evaluation from its sources before anyone is asked to
     * sign it. The release hash protects what is approved from later edits;
     * this protects it from earlier ones. A saved file could carry an
     * evaluation or a dataset validation that was edited to pass, with every
     * cross-record check still consistent. So the dataset content is read
     * back and hashed, validated again, the evaluator run again, and the
     * verdict compared again. Any difference refuses the request.
     */
    const stale = (what: string, remedy = "Validate the dataset again, then train and evaluate.") => new StudioError(409, `Refused because ${what} changed after it was produced. ${remedy}`);
    /** Reads a dataset back, checks its hash, validates it again and compares with the saved result. */
    const verifyDataset = (dataset: Dataset, recipe: Recipe): DatasetValidation => {
      let text: string;
      try { text = options.files.read(dataset.file); }
      catch { throw new StudioError(409, `The content of ${dataset.name} is missing from managed storage.`); }
      const report = validateJsonl(text, recipe.datasetShape);
      const saved = dataset.validation;
      if (report.contentHash !== dataset.contentHash) throw stale("the dataset content");
      if (!saved || saved.passed !== report.passed || saved.records !== report.records || saved.rejected !== report.rejected
        || saved.duplicates !== report.duplicates || saved.secretFindings !== report.secretFindings) throw stale("the dataset validation");
      if (!report.passed) throw new StudioError(409, `${dataset.name} does not pass validation.`);
      return saved;
    };
    const verifyEvidence = (project: ModelProject, config: TrainingConfig, evaluation: EvaluationRun, artifact: NonNullable<TrainingJob["artifact"]>) => {
      const dataset = find(state.datasets, config.datasetId, "Dataset");
      const recipe = recipeFor(project.recipeId);
      const saved = verifyDataset(dataset, recipe);
      if (evaluation.evaluator !== evaluator.id) throw new StudioError(409, `This evaluation was produced by the ${evaluation.evaluator} evaluator, which this deployment does not run. Evaluate the job again.`);
      if (canonical(evaluation.thresholds) !== canonical(recipe.thresholds)) throw stale("the evaluation thresholds", "Run the evaluation again.");
      const baselineSource = evaluation.baseline.source === "release"
        ? state.evaluations.find((item) => item.id === state.releases.find((release) => release.id === evaluation.baseline.releaseId)?.evaluationId)?.metrics
        : recipe.baselineMetrics;
      if (!baselineSource || canonical(baselineSource) !== canonical(evaluation.baseline.metrics)) throw stale("the evaluation baseline", "Run the evaluation again.");
      const metrics = evaluator.evaluate({ recipe, config, validation: saved, artifact });
      if (canonical(metrics) !== canonical(evaluation.metrics)) throw stale("the evaluation score", "Run the evaluation again.");
      const verdict = compareMetrics(metrics, recipe.thresholds, evaluation.baseline.metrics);
      if (!verdict.passed || canonical(verdict.comparison) !== canonical(evaluation.comparison)) throw stale("the evaluation verdict", "Run the evaluation again.");
    };

    switch (command.action) {
      case "create_project": {
        requireAuthor();
        if (state.projects.some((project) => project.name.toLowerCase() === command.name.toLowerCase() && project.status === "active")) {
          throw new StudioError(409, "An active project with this name already exists.");
        }
        const project: ModelProject = { id: randomUUID(), workspaceId: workspace, name: command.name, recipeId: command.recipeId,
          purpose: command.purpose, owner: actor, status: "active", createdAt: at, updatedAt: at };
        state.projects.push(project);
        record("project", project.id, "created", `${project.name} · recipe ${command.recipeId}`);
        break;
      }

      case "archive_project": {
        requireAuthor();
        const project = activeProject(command.projectId);
        if (!admin && project.owner !== actor) throw new StudioError(403, "Only the project owner or an admin can archive it.");
        project.status = "archived"; project.updatedAt = at;
        record("project", project.id, "archived", project.name);
        break;
      }

      case "register_dataset": {
        requireAuthor();
        const project = activeProject(command.projectId);
        let stored: { file: string; bytes: number; contentHash: string };
        try {
          stored = command.source.kind === "inline" ? options.files.store(command.source.text) : options.files.importFile(command.source.path);
        } catch (error) {
          if (error instanceof StudioStorageError) throw new StudioError(400, error.message);
          throw error;
        }
        if (state.datasets.some((dataset) => dataset.projectId === project.id && dataset.contentHash === stored.contentHash)) {
          throw new StudioError(409, "This exact content is already registered for the project.");
        }
        const dataset: Dataset = { id: randomUUID(), projectId: project.id, name: command.name, format: "jsonl", file: stored.file,
          bytes: stored.bytes, contentHash: stored.contentHash, registeredBy: actor, registeredAt: at, status: "registered" };
        state.datasets.push(dataset);
        // Bytes and hash only. The record never says what is in the file.
        record("dataset", dataset.id, "registered", `${project.name} · ${dataset.name} · ${dataset.bytes} bytes · ${dataset.contentHash.slice(0, 16)}`);
        break;
      }

      case "validate_dataset": {
        requireAuthor();
        const dataset = find(state.datasets, command.datasetId, "Dataset");
        const project = activeProject(dataset.projectId);
        const text = options.files.read(dataset.file);
        const report = validateJsonl(text, recipeFor(project.recipeId).datasetShape);
        if (report.contentHash !== dataset.contentHash) throw new StudioError(409, "The stored dataset content no longer matches its registered hash. Register it again.");
        dataset.validation = { at, by: actor, passed: report.passed, records: report.records, rejected: report.rejected,
          duplicates: report.duplicates, secretFindings: report.secretFindings, issues: report.issues, contentHash: report.contentHash };
        dataset.status = report.passed ? "valid" : "rejected";
        record("dataset", dataset.id, report.passed ? "validated" : "rejected",
          `${project.name} · ${dataset.name} · ${report.records} records · ${report.rejected} rejected · ${report.duplicates} duplicates · ${report.secretFindings} credential findings`);
        break;
      }

      case "configure_training": {
        requireAuthor();
        const project = activeProject(command.projectId);
        const dataset = find(state.datasets, command.datasetId, "Dataset");
        if (dataset.projectId !== project.id) throw new StudioError(409, "That dataset belongs to another project.");
        if (dataset.status !== "valid") throw new StudioError(409, "Validate the dataset before configuring training.");
        const recipe = recipeFor(project.recipeId);
        // Training data is where a credential would do the most damage, so
        // the saved "valid" is not taken on trust: the content is checked again.
        verifyDataset(dataset, recipe);
        const provider = providerFor(command.provider);
        const hyperparameters = hyperparametersSchema.parse({ ...recipe.hyperparameters, ...command.hyperparameters });
        const baseModel = command.baseModel ?? recipe.baseModel;
        const problems = provider.validateConfiguration({ baseModel, hyperparameters });
        if (problems.length) throw new StudioError(400, problems.join(" "));
        const config: TrainingConfig = { id: randomUUID(), projectId: project.id, datasetId: dataset.id, provider: provider.id, baseModel, hyperparameters,
          hash: hashTrainingConfig({ projectId: project.id, datasetId: dataset.id, datasetHash: dataset.contentHash, provider: provider.id, baseModel, hyperparameters }),
          createdBy: actor, createdAt: at };
        state.configs.push(config);
        record("config", config.id, "configured", `${project.name} · ${provider.id} · ${baseModel} · ${hyperparameters.epochs} epochs`);
        break;
      }

      case "create_job": {
        requireAuthor();
        const config = find(state.configs, command.configId, "Training configuration");
        activeProject(config.projectId);
        const dataset = find(state.datasets, config.datasetId, "Dataset");
        if (dataset.status !== "valid" || !dataset.validation) throw new StudioError(409, "The dataset is no longer valid.");
        verifyDataset(dataset, recipeFor(find(state.projects, config.projectId, "Project").recipeId));
        if (state.jobs.some((job) => job.configId === config.id && job.status === "running")) throw new StudioError(409, "A job is already running for this configuration.");
        const provider = providerFor(config.provider);
        const input = { baseModel: config.baseModel, hyperparameters: config.hyperparameters };
        const size = { contentHash: dataset.contentHash, records: dataset.validation.records, bytes: dataset.bytes };
        const estimate = provider.estimate(input, size);
        const { providerJobId } = provider.startJob(input, size, config.hash);
        const job: TrainingJob = { id: randomUUID(), projectId: config.projectId, configId: config.id, provider: provider.id, providerJobId,
          status: "running", createdBy: actor, createdAt: at, updatedAt: at, estimate, detail: "Started." };
        state.jobs.push(job);
        record("job", job.id, "started", `${nameOf(config.projectId)} · ${provider.id} · ${providerJobId} · ${estimate.units} units`);
        break;
      }

      case "record_job":
      case "cancel_job": {
        requireAuthor();
        const job = find(state.jobs, command.jobId, "Training job");
        if (job.status !== "running") throw new StudioError(409, `This job already finished as ${job.status}.`);
        const provider = providerFor(job.provider);
        const result = command.action === "cancel_job" ? provider.cancelJob(job.providerJobId) : provider.getJob(job.providerJobId);
        job.updatedAt = at;
        job.detail = result.detail.slice(0, 500);
        if (result.status === "running") { record("job", job.id, "checked", `${nameOf(job.projectId)} · still running`); break; }
        job.status = result.status;
        job.finishedAt = result.finishedAt ?? at;
        if (result.status === "succeeded") {
          const artifact = provider.resolveArtifact(job.providerJobId);
          if (!artifact) throw new StudioError(502, "The provider reports success but returned no artifact.");
          job.artifact = artifact;
        }
        record("job", job.id, result.status, `${nameOf(job.projectId)} · ${job.artifact ? `${job.artifact.label} artifact ${job.artifact.hash.slice(0, 16)}` : result.detail}`);
        break;
      }

      case "run_evaluation": {
        requireAuthor();
        const job = find(state.jobs, command.jobId, "Training job");
        const project = activeProject(job.projectId);
        if (job.status !== "succeeded" || !job.artifact) throw new StudioError(409, "Only a succeeded job can be evaluated.");
        const config = find(state.configs, job.configId, "Training configuration");
        const dataset = find(state.datasets, config.datasetId, "Dataset");
        if (!dataset.validation) throw new StudioError(409, "The dataset has no validation to evaluate against.");
        const recipe = recipeFor(project.recipeId);
        const metrics = evaluator.evaluate({ recipe, config, validation: dataset.validation, artifact: job.artifact });
        // Baseline: the newest approved release of this project, else the recipe.
        const previous = [...state.releases].reverse().find((release) => release.projectId === project.id && release.status === "approved");
        const previousEvaluation = previous ? state.evaluations.find((item) => item.id === previous.evaluationId) : undefined;
        const baseline: EvaluationRun["baseline"] = previous && previousEvaluation
          ? { source: "release", releaseId: previous.id, metrics: previousEvaluation.metrics }
          : { source: "recipe", metrics: recipe.baselineMetrics };
        const { comparison, passed } = compareMetrics(metrics, recipe.thresholds, baseline.metrics);
        const evaluation: EvaluationRun = { id: randomUUID(), projectId: project.id, jobId: job.id, suiteId: recipe.suiteId, evaluator: evaluator.id,
          ranBy: actor, ranAt: at, metrics, thresholds: recipe.thresholds, baseline, comparison, passed, note: evaluator.note };
        state.evaluations.push(evaluation);
        record("evaluation", evaluation.id, passed ? "passed" : "failed", `${project.name} · ${recipe.suiteId} · ${comparison.filter((row) => row.passed).length}/${comparison.length} metrics`);
        break;
      }

      case "request_release": {
        requireAuthor();
        const evaluation = find(state.evaluations, command.evaluationId, "Evaluation");
        const project = activeProject(evaluation.projectId);
        if (!evaluation.passed) throw new StudioError(409, "A release needs a passed evaluation.");
        if (state.releases.some((release) => release.evaluationId === evaluation.id && release.status !== "rejected")) {
          throw new StudioError(409, "A release for this evaluation already exists.");
        }
        const job = find(state.jobs, evaluation.jobId, "Training job");
        const config = find(state.configs, job.configId, "Training configuration");
        if (!job.artifact) throw new StudioError(409, "The job has no artifact.");
        verifyEvidence(project, config, evaluation, job.artifact);
        const release: ModelRelease = { id: randomUUID(), projectId: project.id, jobId: job.id, evaluationId: evaluation.id,
          version: state.releases.filter((item) => item.projectId === project.id).length + 1,
          contentHash: hashRelease({ projectId: project.id, jobId: job.id, configHash: config.hash, artifact: job.artifact, evaluationId: evaluation.id, metrics: evaluation.metrics, passed: evaluation.passed }),
          requiredApprovals, allowSelfApproval, requestedBy: actor, requestedAt: at, status: "pending_approval", approvals: [] };
        state.releases.push(release);
        record("release", release.id, "requested", `${project.name} v${release.version} · ${release.contentHash.slice(0, 16)}${command.note ? ` · ${command.note}` : ""}`);
        break;
      }

      case "approve_release": {
        requireApprover();
        const release = find(state.releases, command.releaseId, "Release");
        if (release.status !== "pending_approval") throw new StudioError(409, `This release is ${release.status.replace("_", " ")}.`);
        if (command.expectedHash !== release.contentHash) throw new StudioError(409, "This release changed. Refresh and review it again.");
        // The requester cannot approve their own release. Being an admin
        // does not change that; only the deployment policy can.
        if (release.requestedBy === actor && !release.allowSelfApproval) throw new StudioError(403, "You requested this release, so you cannot approve it.");
        if (release.approvals.some((approval) => approval.actor === actor)) throw new StudioError(409, "You have already approved this release.");
        release.approvals.push({ actor, at, contentHash: release.contentHash, ...(command.note ? { note: command.note } : {}) });
        const valid = validApproversOf(release);
        if (valid.length >= release.requiredApprovals) release.status = "approved";
        record("release", release.id, release.status === "approved" ? "approved" : "signed", `${nameOf(release.projectId)} v${release.version} · ${valid.length}/${release.requiredApprovals} approvals${command.note ? ` · ${command.note}` : ""}`);
        break;
      }

      case "reject_release": {
        requireApprover();
        const release = find(state.releases, command.releaseId, "Release");
        if (release.status !== "pending_approval") throw new StudioError(409, `This release is ${release.status.replace("_", " ")}.`);
        if (command.expectedHash !== release.contentHash) throw new StudioError(409, "This release changed. Refresh and review it again.");
        release.status = "rejected";
        release.decision = { by: actor, at, note: command.note };
        record("release", release.id, "rejected", `${nameOf(release.projectId)} v${release.version} · ${command.note}`);
        break;
      }

      case "retire_release": {
        const release = find(state.releases, command.releaseId, "Release");
        if (!admin && !(author && release.requestedBy === actor)) throw new StudioError(403, "The requester or an admin can retire a release.");
        if (release.status !== "approved") throw new StudioError(409, "Only an approved release can be retired.");
        release.status = "retired";
        release.decision = { by: actor, at, note: command.note };
        // Profiles on a retired release stop answering. Disabling them here
        // makes that visible in the list, not only at chat time.
        for (const profile of state.profiles) {
          if (profile.releaseId === release.id && profile.status === "active") { profile.status = "disabled"; profile.updatedAt = at; }
        }
        record("release", release.id, "retired", `${nameOf(release.projectId)} v${release.version} · ${command.note}`);
        break;
      }

      case "assign_profile": {
        requireAuthor();
        const release = find(state.releases, command.releaseId, "Release");
        if (release.status !== "approved") throw new StudioError(409, "Only an approved release can be assigned to a chatbot profile.");
        const project = find(state.projects, release.projectId, "Project");
        if (state.profiles.some((profile) => profile.name.toLowerCase() === command.name.toLowerCase() && profile.status === "active")) {
          throw new StudioError(409, "An active profile with this name already exists.");
        }
        const profile: ChatbotProfile = { id: randomUUID(), workspaceId: workspace, name: command.name, releaseId: release.id,
          instructions: command.instructions ?? recipeFor(project.recipeId).profileInstructions, status: "active", createdBy: actor, createdAt: at, updatedAt: at };
        state.profiles.push(profile);
        record("profile", profile.id, "assigned", `${profile.name} → ${project.name} v${release.version}`);
        break;
      }

      case "disable_profile": {
        requireAuthor();
        const profile = find(state.profiles, command.profileId, "Profile");
        if (profile.status !== "active") throw new StudioError(409, "This profile is already disabled.");
        if (!admin && profile.createdBy !== actor) throw new StudioError(403, "Only the profile's creator or an admin can disable it.");
        profile.status = "disabled"; profile.updatedAt = at;
        record("profile", profile.id, "disabled", profile.name);
        break;
      }
    }

    // A refused commit throws here, and the state that was read on the next
    // request is the one before this command.
    options.persistence.commit(workspace, state);
    return snapshot(workspace);
  }

  function resolveProfile(workspace: string, profileId: string): ResolvedProfile {
    // A file that fails its checks means no profile can be trusted to
    // answer, and the reason is said plainly rather than as a missing profile.
    let state: StudioState;
    try {
      state = load(workspace);
    } catch (error) {
      if (error instanceof StudioStorageError) throw new StudioError(409, "Model Studio data failed its integrity check. No profile can answer until it is repaired.");
      throw error;
    }
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new StudioError(404, "Chatbot profile not found in this workspace.");
    if (profile.status !== "active") throw new StudioError(409, "This chatbot profile is disabled.");
    const release = state.releases.find((item) => item.id === profile.releaseId);
    if (!release) throw new StudioError(409, "The profile's release is missing.");
    if (release.status === "retired") throw new StudioError(409, "This profile's release has been retired.");
    if (release.status !== "approved") throw new StudioError(409, "This profile's release is not approved.");
    if (validApproversOf(release).length < release.requiredApprovals) throw new StudioError(409, "This release no longer has enough valid approvals.");
    const project = state.projects.find((item) => item.id === release.projectId);
    const job = state.jobs.find((item) => item.id === release.jobId);
    const config = job ? state.configs.find((item) => item.id === job.configId) : undefined;
    if (!project || !job || !config || !job.artifact) throw new StudioError(409, "The release's records are incomplete.");
    return { profile, release, project, recipe: recipeFor(project.recipeId), job, config };
  }

  return { snapshot, execute, resolveProfile };
}
