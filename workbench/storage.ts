import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { materialsSchema } from "./materials.js";
import { setting } from "../env.js";
import { pipelineSchema, type PipelineConfig, type PipelineRun } from "./pipeline.js";
import { dedupeKeyFor, hashIntent, jiraIntentSchema, type PendingJiraAction } from "./jira.js";

/**
 * Durable storage for one local workspace.
 *
 * One JSON document per workspace, rewritten whole on every commit. Whole
 * rather than incremental because a workspace is small, bounded by the run
 * and event limits the engine already enforces, and because a single
 * rewrite has exactly one commit point. Incremental writes would buy speed
 * this application does not need and cost a recovery story it does.
 *
 * The engine stays synchronous, so everything here is synchronous too. That
 * is deliberate: an async store would push await through PipelineEngine,
 * server.ts and every caller, for a write of a few kilobytes to a local disk.
 */

/** Bumped only when the on-disk shape changes in a way older code misreads. */
export const STORAGE_VERSION = 1;

export class StorageError extends Error {}

/**
 * Where workspaces live.
 *
 * The desktop application already owns %LOCALAPPDATA%\MagenticDeveloper, so
 * user data goes under its data folder rather than a second directory beside
 * it. Installed binaries and user data stay separate: this path never points
 * inside the program directory.
 */
export function workspacesDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = setting("MAGENTIC_WORKSPACES_DIR", env)?.trim();
  if (override) return override;

  if (platform === "win32") {
    const local = setting("LOCALAPPDATA", env)?.trim() || join(homedir(), "AppData", "Local");
    return join(local, "MagenticDeveloper", "data", "workspaces");
  }
  const base = setting("XDG_DATA_HOME", env)?.trim() || join(homedir(), ".local", "share");
  return join(base, "MagenticDeveloper", "data", "workspaces");
}

// --------------------------------------------------------------- the document

const stageRunSchema = z.object({
  status: z.enum(["pending", "active", "awaiting_review", "complete"]),
  output: z.string().max(4000),
  outputHash: z.string().regex(/^(|[0-9a-f]{64})$/),
  outputBy: z.string().max(200),
  approvals: z.array(z.string().min(1).max(200)).max(10),
  completedAt: z.string().datetime().optional(),
}).strict();

const eventSchema = z.object({
  id: z.string().uuid(), at: z.string().datetime(), actor: z.string().min(1).max(200),
  stage: z.string().min(1).max(80), action: z.string().min(1).max(80), detail: z.string().max(4000),
}).strict();

const jiraSchema = z.object({
  id: z.string().uuid(), eventId: z.string().uuid(), action: z.enum(["create_issue", "update_issue"]),
  project: z.string(), issueType: z.string(), issueKey: z.string().nullable(), summary: z.string(),
  status: z.string(), comment: z.string(), delivery: z.literal("preview"),
}).strict();

const runSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid(), workspaceId: z.string().min(1),
  owner: z.string().min(1).max(200), title: z.string().min(1), brief: z.string().min(1),
  materials: materialsSchema.optional(), issueKey: z.string().nullable(), config: pipelineSchema, version: z.number().int().min(1),
  revision: z.number().int().min(1), requiredApprovals: z.number().int().min(1).max(10),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  status: z.enum(["running", "paused", "blocked", "complete", "cancelled"]),
  current: z.number().int().min(0), stages: z.array(stageRunSchema).min(1),
  events: z.array(eventSchema), jira: z.array(jiraSchema),
}).strict();

const deliveryStepSchema = z.object({
  name: z.string().min(1).max(80), at: z.string().datetime(), detail: z.string().max(2000),
}).strict();

const jiraActionSchema = z.object({
  id: z.string().uuid(),
  dedupeKey: z.string().regex(/^[0-9a-f]{64}$/),
  intent: jiraIntentSchema,
  authorizedBy: z.string().min(1).max(200),
  authorizedAt: z.string().datetime(),
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["pending", "claimed", "sent", "failed", "uncertain"]),
  attempts: z.number().int().min(0),
  claim: z.object({ attemptId: z.string().uuid(), at: z.string().datetime() }).strict().optional(),
  steps: z.array(deliveryStepSchema).max(50),
  evidence: z.object({ issueKey: z.string().min(1), url: z.string().url(), at: z.string().datetime() }).strict().optional(),
  lastError: z.string().max(2000).optional(),
  retryAfterMs: z.number().int().min(0).optional(),
  retryNotBefore: z.string().datetime().optional(),
}).strict();

const documentSchema = z.object({
  storageVersion: z.number().int(),
  workspaceId: z.string().min(1),
  config: pipelineSchema,
  version: z.number().int().min(1),
  runs: z.array(runSchema),
  // Added after the first release. Optional with a default so a workspace
  // written before Jira actions existed still loads, which is why the
  // storage version did not have to change.
  jiraActions: z.array(jiraActionSchema).max(500).default([]),
}).strict();

/**
 * What the engine holds for one workspace, and the document that wraps it.
 *
 * Written by hand from the engine's own types rather than inferred from the
 * schema above. Under exactOptionalPropertyTypes a zod .optional() infers
 * `string | undefined`, which is a different type from the engine's
 * `completedAt?: string`. The schema proves the shape at runtime; these
 * declare it for the compiler, and the one cast in read() is where the two
 * meet.
 */
export interface WorkspaceState {
  config: PipelineConfig; version: number; runs: PipelineRun[];
  /** Durable Jira actions. Absent in documents written before they existed. */
  jiraActions?: PendingJiraAction[];
}
export interface WorkspaceDocument extends WorkspaceState { storageVersion: number; workspaceId: string }

/**
 * Checks the schema cannot express.
 *
 * A document can be valid JSON of the right shape and still describe a state
 * the engine could never have produced. Those are the interesting failures,
 * because they are what a hand-edited or partially written file looks like,
 * and serving one would mean enforcing approval rules against invented data.
 */
function assertCoherent(document: WorkspaceDocument, workspace: string): void {
  const fail = (message: string): never => {
    throw new StorageError(`Workspace ${workspace} is not internally consistent: ${message}`);
  };

  if (document.workspaceId !== workspace) {
    fail(`it is labelled ${document.workspaceId}.`);
  }

  const seenActionIds = new Set<string>();
  const seenActions = new Set<string>();
  for (const action of document.jiraActions ?? []) {
    if (seenActionIds.has(action.id)) fail(`two Jira actions share id ${action.id}.`);
    seenActionIds.add(action.id);
    if (action.intentHash !== hashIntent(action.intent)) fail(`Jira action ${action.id} has a changed intent.`);
    if (action.dedupeKey !== dedupeKeyFor(action.intent)) fail(`Jira action ${action.id} has a different dedupe key.`);
    if ((action.status === "claimed") !== Boolean(action.claim)) fail(`Jira action ${action.id} has an inconsistent claim.`);
    if (seenActions.has(action.dedupeKey)) fail(`two Jira actions share dedupe key ${action.dedupeKey}.`);
    seenActions.add(action.dedupeKey);
    // Evidence means it landed. Anything else claiming evidence, or a sent
    // action without it, is a record that cannot be true.
    if (action.status === "sent" && !action.evidence) fail(`Jira action ${action.id} is sent with no evidence.`);
    if (action.status !== "sent" && action.evidence) fail(`Jira action ${action.id} is ${action.status} but carries evidence.`);
    const intentWorkspace = action.intent.workspaceId;
    if (intentWorkspace !== workspace) {
      fail(`Jira action ${action.id} was authorized for workspace ${intentWorkspace}.`);
    }
  }

  const seenRequests = new Set<string>();
  for (const run of document.runs) {
    if (run.workspaceId !== workspace) fail(`run ${run.id} belongs to ${run.workspaceId}.`);
    if (seenRequests.has(run.requestId)) fail(`two runs share request id ${run.requestId}.`);
    seenRequests.add(run.requestId);

    if (run.stages.length !== run.config.stages.length) {
      fail(`run ${run.id} has ${run.stages.length} stage states for ${run.config.stages.length} configured stages.`);
    }
    if (run.current >= run.stages.length) {
      fail(`run ${run.id} points at stage ${run.current} of ${run.stages.length}.`);
    }
    if (run.version > document.version) {
      fail(`run ${run.id} claims configuration version ${run.version}, ahead of the workspace's ${document.version}.`);
    }

    // Stage statuses have to describe a position the engine could have
    // reached. A file that says otherwise is edited or half-written, and
    // trusting it would mean enforcing gates against invented progress.
    for (const [index, stage] of run.stages.entries()) {
      if (run.status === "complete") {
        if (stage.status !== "complete") fail(`run ${run.id} is complete but stage ${index} is ${stage.status}.`);
      } else if (index < run.current) {
        if (stage.status !== "complete") fail(`run ${run.id} has passed stage ${index} but it is ${stage.status}.`);
      } else if (index > run.current) {
        if (stage.status !== "pending") fail(`run ${run.id} has not reached stage ${index} but it is ${stage.status}.`);
      } else if (stage.status === "pending") {
        fail(`run ${run.id} is sitting on stage ${index} but it is still pending.`);
      }

      // A gated stage that is complete must carry the signatures that were
      // required to pass it. This is the check that stops a gate being
      // cleared by editing the file.
      if (stage.status === "complete" && run.config.stages[index]?.approval
        && stage.approvals.length < run.requiredApprovals) {
        fail(`run ${run.id} stage ${index} is a gated stage completed with ${stage.approvals.length} of ${run.requiredApprovals} approvals.`);
      }
    }

    for (const [index, stage] of run.stages.entries()) {
      // A hash that does not match its output is the one corruption that
      // would let edited content inherit an existing approval.
      const expected = stage.output ? createHash("sha256").update(stage.output).digest("hex") : "";
      if (stage.outputHash !== expected) fail(`run ${run.id} stage ${index} has an output hash that does not match its output.`);
      if (new Set(stage.approvals).size !== stage.approvals.length) {
        fail(`run ${run.id} stage ${index} records the same approver twice.`);
      }
      // The engine refuses these at approval time; a file must not smuggle
      // them back in.
      if (stage.approvals.includes(run.owner)) fail(`run ${run.id} stage ${index} records the run owner as an approver.`);
      if (stage.outputBy && stage.approvals.includes(stage.outputBy)) {
        fail(`run ${run.id} stage ${index} records the output author as an approver.`);
      }
    }
  }
}

// ------------------------------------------------------------------ the store

export interface WorkspaceStore {
  /** The file this workspace lives in. Exposed so callers need not guess the naming. */
  pathFor(workspace: string): string;
  /** The stored state, or undefined when this workspace has nothing yet. */
  read(workspace: string): WorkspaceState | undefined;
  /** Persist, or throw. Returning means the new state is durable. */
  commit(workspace: string, state: WorkspaceState): void;
  /** Release the writer lock. Safe to call twice. */
  close(): void;
  /** Test seam: make the next commit fail, to prove a failed write stays invisible. */
  failNextCommit(error: Error): void;
}

/**
 * A workspace name becomes one file name.
 *
 * The sanitized name alone is not enough. NTFS is case-insensitive, so
 * "agency-a" and "Agency-A" would land on one file and silently share state.
 * A 128-bit hash of the exact name is appended, which makes two names sharing
 * a file implausible rather than impossible. Because implausible is not the
 * same as impossible, commit() also refuses to replace a document that names
 * a different workspace, so a collision becomes a visible error instead of
 * silent data loss.
 */
function fileNameFor(workspace: string): string {
  const trimmed = workspace.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || trimmed.length > 100) {
    throw new StorageError(`"${workspace}" is not a usable workspace name.`);
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  return `${safe}-${digest}.json`;
}

const LOCK = ".writer.lock";

export function fileWorkspaceStore(directory: string): WorkspaceStore {
  mkdirSync(directory, { recursive: true });

  // Exclusive create is the whole lock. It is one atomic filesystem
  // operation, so two processes racing cannot both believe they won.
  const owner = randomUUID();
  const lockPath = join(directory, LOCK);
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }));
    fsyncSync(fd);
    closeSync(fd);
  } catch (cause) {
    if ((cause as { code?: string }).code === "EEXIST") {
      throw new StorageError(
        `Another instance is already using ${directory}. Close it and try again. `
        + `If no Magentic process is running, delete ${lockPath} and retry.`,
      );
    }
    throw new StorageError(`Could not take the writer lock in ${directory}.`, { cause });
  }

  // Holding the lock means no other writer exists, so any leftover temporary
  // file is from a crash and can go. They are never read, only removed.
  for (const name of readdirSync(directory)) {
    if (/^(?:[a-z0-9._-]+-[0-9a-f]{32}|workspaces)\.json\.tmp-[0-9a-f]{8}$/.test(name)) rmSync(join(directory, name), { force: true });
  }

  let closed = false;
  let pendingFailure: Error | undefined;

  return {
    pathFor(workspace) {
      return join(directory, fileNameFor(workspace));
    },

    read(workspace) {
      const path = join(directory, fileNameFor(workspace));
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (cause) {
        if ((cause as { code?: string }).code === "ENOENT") return undefined;
        throw new StorageError(`Workspace ${workspace} could not be read.`, { cause });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        // Never replaced with an empty workspace. Someone has to look at it.
        throw new StorageError(`Workspace ${workspace} is not valid JSON. The file at ${path} was left untouched.`, { cause });
      }

      const envelope = z.object({ storageVersion: z.number().int() }).safeParse(parsed);
      if (envelope.success && envelope.data.storageVersion !== STORAGE_VERSION) {
        throw new StorageError(
          `Workspace ${workspace} has storage version ${envelope.data.storageVersion}; this build reads version ${STORAGE_VERSION}. `
          + `Upgrade Magentic, or move ${path} aside to start fresh.`,
        );
      }

      const document = documentSchema.safeParse(parsed);
      if (!document.success) {
        const detail = document.error.issues.slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
        throw new StorageError(`Workspace ${workspace} is not a valid document. ${detail}. The file at ${path} was left untouched.`);
      }

      // Validated above; this only reconciles how zod and the engine spell
      // an optional property.
      const data = document.data as unknown as WorkspaceDocument;
      assertCoherent(data, workspace);
      return { config: data.config, version: data.version, runs: data.runs, jiraActions: data.jiraActions ?? [] };
    },

    commit(workspace, state) {
      if (closed) throw new StorageError("This store has been closed.");
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        throw failure;
      }

      const document: WorkspaceDocument = { storageVersion: STORAGE_VERSION, workspaceId: workspace, ...state };
      // Validated before anything touches the disk, so a state the engine
      // should never have produced is refused while the old file is intact.
      const checked = documentSchema.safeParse(document);
      if (!checked.success) {
        throw new StorageError(`Refusing to write workspace ${workspace}: ${checked.error.issues[0]?.message ?? "invalid document"}.`);
      }
      assertCoherent(document, workspace);

      const target = join(directory, fileNameFor(workspace));

      // Whose document is already there? A name hash makes a collision
      // implausible, not impossible, and "implausible" is not a safe basis
      // for overwriting somebody's work. If the file on disk names a
      // different workspace, refuse and say so.
      try {
        const existing = JSON.parse(readFileSync(target, "utf8")) as { workspaceId?: unknown };
        if (existing.workspaceId !== workspace) {
          throw new StorageError(
            `Refusing to save workspace ${workspace}: ${target} already belongs to workspace ${existing.workspaceId}. `
            + "Rename one of them, or move that file aside.",
          );
        }
      } catch (cause) {
        if (cause instanceof StorageError) throw cause;
        // An unreadable document may be the only recoverable copy. Only a
        // missing file permits creation; damage needs explicit recovery.
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new StorageError(`Refusing to replace unreadable workspace ${workspace}.`, { cause });
        }
      }

      const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
      let fd: number | undefined;
      try {
        // Exclusive create: a name collision is an error, never an overwrite
        // of somebody else's half-written file.
        fd = openSync(temp, "wx");
        writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;

        // The rename publishes the complete document. File content has been
        // synced, but directory durability after power loss depends on the
        // filesystem. This is not a power-loss or network-drive guarantee.
        renameSync(temp, target);
      } catch (cause) {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* already closing */ } }
        rmSync(temp, { force: true });
        throw new StorageError(`Workspace ${workspace} could not be saved. No change was made.`, { cause });
      }
    },

    close() {
      if (closed) return;
      closed = true;
      // Only ever remove a lock this instance still owns. If the file has
      // been replaced, someone else's lock is there and deleting it would
      // hand a second writer the directory.
      try {
        const held = JSON.parse(readFileSync(lockPath, "utf8")) as { owner?: string };
        if (held.owner === owner) unlinkSync(lockPath);
      } catch {
        // Gone or unreadable: nothing of ours left to release.
      }
    },

    failNextCommit(error) {
      pendingFailure = error;
    },
  };
}
