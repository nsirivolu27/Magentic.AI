import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The records the Model Studio keeps, and the rules each one must satisfy on
 * its own.
 *
 * Every schema is strict: an unknown key is a mistake, not an extension. Rules
 * that span records (a job must point at a config that exists, an approved
 * release must carry enough distinct signatures) live in store.ts, because
 * they need the whole document to check.
 *
 * Types are written by hand rather than inferred. Under
 * exactOptionalPropertyTypes a zod .optional() infers `T | undefined`, which
 * is not the same as `key?: T`, and the engine wants the second form so it
 * can omit a key rather than assign undefined to it. The schema proves the
 * shape at runtime; the interfaces declare it for the compiler.
 */

export const RECIPE_IDS = ["coding-assistant", "it-support", "incident-summarization", "internal-knowledge", "jira-issue-assistant", "salesforce-delivery"] as const;
export type RecipeId = typeof RECIPE_IDS[number];

const id = z.string().uuid();
const when = z.string().datetime();
const person = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const title = z.string().trim().min(1).max(120);
const note = z.string().trim().max(2_000);
const metrics = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), z.number().min(0).max(1));

// ------------------------------------------------------------------- projects

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const projectSchema = z.object({
  id, workspaceId: z.string().min(1), name: title, recipeId: z.enum(RECIPE_IDS),
  purpose: z.string().trim().max(1_000), owner: person,
  status: z.enum(PROJECT_STATUSES), createdAt: when, updatedAt: when,
}).strict();
export interface ModelProject {
  id: string; workspaceId: string; name: string; recipeId: RecipeId; purpose: string; owner: string;
  status: typeof PROJECT_STATUSES[number]; createdAt: string; updatedAt: string;
}

// ------------------------------------------------------------------- datasets

export const DATASET_STATUSES = ["registered", "valid", "rejected"] as const;
export const datasetIssueSchema = z.object({
  line: z.number().int().min(0), code: z.string().regex(/^[a-z][a-z-]*$/), message: z.string().max(300),
}).strict();
export const datasetValidationSchema = z.object({
  at: when, by: person, passed: z.boolean(),
  records: z.number().int().min(0), rejected: z.number().int().min(0),
  duplicates: z.number().int().min(0), secretFindings: z.number().int().min(0),
  /** Line numbers and codes only. Never the content of a line. */
  issues: z.array(datasetIssueSchema).max(50),
  /** What was validated. Must equal the dataset's contentHash or the result is stale. */
  contentHash: hash,
}).strict();
export const datasetSchema = z.object({
  id, projectId: id, name: title, format: z.literal("jsonl"),
  /** The managed copy, named by its content hash, under the studio's datasets directory. */
  file: z.string().regex(/^[0-9a-f]{64}\.jsonl$/),
  bytes: z.number().int().min(0), contentHash: hash,
  registeredBy: person, registeredAt: when,
  status: z.enum(DATASET_STATUSES), validation: datasetValidationSchema.optional(),
}).strict();
export interface DatasetIssue { line: number; code: string; message: string }
export interface DatasetValidation {
  at: string; by: string; passed: boolean; records: number; rejected: number; duplicates: number;
  secretFindings: number; issues: DatasetIssue[]; contentHash: string;
}
export interface Dataset {
  id: string; projectId: string; name: string; format: "jsonl"; file: string; bytes: number; contentHash: string;
  registeredBy: string; registeredAt: string; status: typeof DATASET_STATUSES[number]; validation?: DatasetValidation;
}

// ------------------------------------------------------------------- training

export const hyperparametersSchema = z.object({
  epochs: z.number().int().min(1).max(20),
  learningRate: z.number().min(1e-7).max(1),
  batchSize: z.number().int().min(1).max(256),
}).strict();
export type Hyperparameters = z.infer<typeof hyperparametersSchema>;

export const trainingConfigSchema = z.object({
  id, projectId: id, datasetId: id,
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), baseModel: z.string().trim().min(1).max(200),
  hyperparameters: hyperparametersSchema,
  /** Covers dataset content, provider, base model and hyperparameters. */
  hash, createdBy: person, createdAt: when,
}).strict();
export interface TrainingConfig {
  id: string; projectId: string; datasetId: string; provider: string; baseModel: string;
  hyperparameters: Hyperparameters; hash: string; createdBy: string; createdAt: string;
}

/** What a config's hash is computed over. The dataset hash is included so a re-registered dataset is a different config. */
export function hashTrainingConfig(input: { projectId: string; datasetId: string; datasetHash: string; provider: string; baseModel: string; hyperparameters: Hyperparameters }): string {
  return sha256(canonical(input));
}

export const ARTIFACT_LABELS = ["development", "trained"] as const;
export const artifactSchema = z.object({
  uri: z.string().min(1).max(500), hash,
  /** "development" means no weights exist behind this artifact. The UI says so wherever it appears. */
  label: z.enum(ARTIFACT_LABELS), note: z.string().max(500),
}).strict();
export interface Artifact { uri: string; hash: string; label: typeof ARTIFACT_LABELS[number]; note: string }

export const JOB_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export const trainingJobSchema = z.object({
  id, projectId: id, configId: id, provider: z.string().min(1), providerJobId: z.string().min(1).max(200),
  status: z.enum(JOB_STATUSES), createdBy: person, createdAt: when, updatedAt: when,
  estimate: z.object({ units: z.number().min(0), note: z.string().max(300) }).strict(),
  detail: z.string().max(500),
  finishedAt: when.optional(), artifact: artifactSchema.optional(),
}).strict();
export interface TrainingJob {
  id: string; projectId: string; configId: string; provider: string; providerJobId: string;
  status: typeof JOB_STATUSES[number]; createdBy: string; createdAt: string; updatedAt: string;
  estimate: { units: number; note: string }; detail: string; finishedAt?: string; artifact?: Artifact;
}

// ----------------------------------------------------------------- evaluation

export const comparisonRowSchema = z.object({
  metric: z.string(), value: z.number(), threshold: z.number(), baseline: z.number(), passed: z.boolean(),
}).strict();
export const evaluationSchema = z.object({
  id, projectId: id, jobId: id, suiteId: z.string().min(1).max(80), evaluator: z.string().min(1).max(80),
  ranBy: person, ranAt: when, metrics, thresholds: metrics,
  baseline: z.object({ source: z.enum(["recipe", "release"]), releaseId: id.optional(), metrics }).strict(),
  comparison: z.array(comparisonRowSchema).max(20), passed: z.boolean(), note: z.string().max(500),
}).strict();
export interface ComparisonRow { metric: string; value: number; threshold: number; baseline: number; passed: boolean }
export interface EvaluationRun {
  id: string; projectId: string; jobId: string; suiteId: string; evaluator: string; ranBy: string; ranAt: string;
  metrics: Record<string, number>; thresholds: Record<string, number>;
  baseline: { source: "recipe" | "release"; releaseId?: string; metrics: Record<string, number> };
  comparison: ComparisonRow[]; passed: boolean; note: string;
}

// ------------------------------------------------------------------- releases

export const RELEASE_STATUSES = ["pending_approval", "approved", "rejected", "retired"] as const;
export const releaseApprovalSchema = z.object({ actor: person, at: when, contentHash: hash, note: note.optional() }).strict();
export const releaseSchema = z.object({
  id, projectId: id, jobId: id, evaluationId: id, version: z.number().int().min(1),
  /** Binds the release to one artifact, one config and one evaluation result. Approvals sign this. */
  contentHash: hash, requiredApprovals: z.number().int().min(1).max(10),
  /** The policy in force when this was requested. Saved so the file can be checked against the rules its approvals were made under. */
  allowSelfApproval: z.boolean(),
  requestedBy: person, requestedAt: when, status: z.enum(RELEASE_STATUSES),
  approvals: z.array(releaseApprovalSchema).max(10),
  decision: z.object({ by: person, at: when, note }).strict().optional(),
}).strict();
export interface ReleaseApproval { actor: string; at: string; contentHash: string; note?: string }
export interface ModelRelease {
  id: string; projectId: string; jobId: string; evaluationId: string; version: number; contentHash: string;
  requiredApprovals: number; allowSelfApproval: boolean; requestedBy: string; requestedAt: string; status: typeof RELEASE_STATUSES[number];
  approvals: ReleaseApproval[]; decision?: { by: string; at: string; note: string };
}

/**
 * Approvers whose signature still counts: signed over the current content,
 * each person once, and not the requester unless the policy the release was
 * requested under allowed that. The same idea as the registry's
 * validApprovers, applied to releases.
 */
export function validApproversOf(release: Pick<ModelRelease, "approvals" | "contentHash" | "requestedBy" | "allowSelfApproval">): string[] {
  return [...new Set(release.approvals
    .filter((approval) => approval.contentHash === release.contentHash && (release.allowSelfApproval || approval.actor !== release.requestedBy))
    .map((approval) => approval.actor))];
}

/** What a release's hash covers. Change any of these and every signature stops matching. */
export function hashRelease(input: { projectId: string; jobId: string; configHash: string; artifact: Artifact; evaluationId: string; metrics: Record<string, number>; passed: boolean }): string {
  return sha256(canonical(input));
}

// ------------------------------------------------------------------- profiles

export const PROFILE_STATUSES = ["active", "disabled"] as const;
export const profileSchema = z.object({
  id, workspaceId: z.string().min(1), name: title, releaseId: id,
  instructions: z.string().trim().min(1).max(4_000),
  status: z.enum(PROFILE_STATUSES), createdBy: person, createdAt: when, updatedAt: when,
}).strict();
export interface ChatbotProfile {
  id: string; workspaceId: string; name: string; releaseId: string; instructions: string;
  status: typeof PROFILE_STATUSES[number]; createdBy: string; createdAt: string; updatedAt: string;
}

// --------------------------------------------------------------------- events

export const STUDIO_ENTITIES = ["project", "dataset", "config", "job", "evaluation", "release", "profile"] as const;
export const studioEventSchema = z.object({
  id, at: when, actor: person, entity: z.enum(STUDIO_ENTITIES), entityId: id,
  action: z.string().regex(/^[a-z][a-z-]*$/), detail: z.string().max(500),
}).strict();
export interface StudioEvent { id: string; at: string; actor: string; entity: typeof STUDIO_ENTITIES[number]; entityId: string; action: string; detail: string }

// ------------------------------------------------------------------- document

export const studioStateSchema = z.object({
  projects: z.array(projectSchema).max(200), datasets: z.array(datasetSchema).max(1_000),
  configs: z.array(trainingConfigSchema).max(1_000), jobs: z.array(trainingJobSchema).max(1_000),
  evaluations: z.array(evaluationSchema).max(1_000), releases: z.array(releaseSchema).max(1_000),
  profiles: z.array(profileSchema).max(200), events: z.array(studioEventSchema).max(500),
}).strict();
export interface StudioState {
  projects: ModelProject[]; datasets: Dataset[]; configs: TrainingConfig[]; jobs: TrainingJob[];
  evaluations: EvaluationRun[]; releases: ModelRelease[]; profiles: ChatbotProfile[]; events: StudioEvent[];
}
export function emptyStudioState(): StudioState {
  return { projects: [], datasets: [], configs: [], jobs: [], evaluations: [], releases: [], profiles: [], events: [] };
}

// -------------------------------------------------------------------- hashing

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with sorted keys, so the same value always hashes the same way. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
