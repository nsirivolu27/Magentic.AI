import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Role } from "../registry/roles.js";
import { StudioError, type ModelStudio, type StudioSnapshot } from "./studio/engine.js";
import { failingMetrics } from "./studio-model.js";
import { atomicJson, digest } from "./bot-project.js";

/**
 * The learning schedule: an assistant keeps learning from new personal
 * content on a rhythm.
 *
 * One schedule per project, owned by the author who set it. When it is due
 * (or someone asks), one cycle runs: import new files from the workspace's
 * import folder that match the pattern, validate the newest registered
 * content, train a candidate from the newest valid content, evaluate it,
 * and request a release. Every step is the ordinary studio command, run as
 * the owner, so the audit trail reads exactly as if they had clicked. The
 * cycle stops where a person has to look (rejected content, a failed
 * evaluation, a release still waiting for reviewers) and says why. It
 * never approves, never assigns and never changes a threshold.
 */

export const CADENCES = ["manual", "daily", "weekly"] as const;
export type Cadence = typeof CADENCES[number];
const HOURS: Record<Cadence, number> = { manual: 0, daily: 24, weekly: 24 * 7 };

export const learningScheduleSchema = z.object({
  projectId: z.string().uuid(), workspaceId: z.string().min(1), owner: z.string().min(1), cadence: z.enum(CADENCES),
  /** Import folder files to pick up, as a name with * wildcards. Empty means registered datasets only. */
  pattern: z.string().max(200), paused: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(), nextRunAt: z.string().nullable(), lastRunAt: z.string().optional(),
}).strict();
export type LearningSchedule = z.infer<typeof learningScheduleSchema>;

export const STEPS = ["import", "validate", "train", "evaluate", "release"] as const;
export const learningStepSchema = z.object({ step: z.enum(STEPS), outcome: z.enum(["done", "skipped", "stopped"]), detail: z.string(), at: z.string() }).strict();
export const learningRunSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), projectId: z.string().uuid(), project: z.string(), owner: z.string(),
  trigger: z.enum(["schedule", "manual"]), status: z.enum(["complete", "stopped", "failed"]),
  startedAt: z.string(), finishedAt: z.string(), steps: z.array(learningStepSchema), summary: z.string(),
}).strict();
export type LearningStep = z.infer<typeof learningStepSchema>;
export type LearningRun = z.infer<typeof learningRunSchema>;
export const learningStateSchema = z.object({ schedules: z.array(learningScheduleSchema), runs: z.array(learningRunSchema) }).strict();
export type LearningState = z.infer<typeof learningStateSchema>;

export interface LearningPersistence {
  read(workspace: string): LearningState | undefined;
  commit(workspace: string, state: LearningState): void;
}
/** Where new content may come from: the workspace's import folder, listed by name. */
export interface ImportSource { list(): string[] }
export interface LearningOptions {
  studio: ModelStudio;
  imports?: ImportSource;
  persistence?: LearningPersistence;
  now?: () => string;
  /** The approval policy the studio commands run under. */
  requiredApprovals?: number;
}
export interface ScheduleInput { projectId: string; cadence: Cadence; pattern?: string | undefined; paused?: boolean | undefined }
export interface LearningEngine {
  snapshot(workspace: string): LearningState;
  set(workspace: string, actor: string, roles: readonly Role[], input: ScheduleInput): LearningSchedule;
  remove(workspace: string, actor: string, roles: readonly Role[], projectId: string): void;
  /** Run every due schedule once. Returns the runs it made. */
  tick(workspace: string): LearningRun[];
  /** Run one project's cycle now, whatever its cadence. */
  runNow(workspace: string, actor: string, roles: readonly Role[], projectId: string): LearningRun;
}

const MAX_RUNS = 100;
const scheduleInputSchema = z.object({ projectId: z.string().uuid(), cadence: z.enum(CADENCES), pattern: z.string().trim().max(200).optional(), paused: z.boolean().optional() }).strict();

export function createLearningSchedule(options: LearningOptions): LearningEngine {
  const now = options.now ?? (() => new Date().toISOString());
  const approvals = options.requiredApprovals ?? 2;
  const states = new Map<string, LearningState>();

  function state(workspace: string): LearningState {
    let value = states.get(workspace);
    if (!value) { value = learningStateSchema.parse(options.persistence?.read(workspace) ?? { schedules: [], runs: [] }); states.set(workspace, value); }
    return value;
  }
  const save = (workspace: string) => options.persistence?.commit(workspace, state(workspace));
  const later = (from: string, cadence: Cadence): string | null => cadence === "manual" ? null : new Date(new Date(from).getTime() + HOURS[cadence] * 3_600_000).toISOString();
  const isAuthor = (roles: readonly Role[]) => roles.includes("author") || roles.includes("admin");

  function set(workspace: string, actor: string, roles: readonly Role[], raw: ScheduleInput): LearningSchedule {
    if (!isAuthor(roles)) throw new StudioError(403, "Authors and admins set learning schedules.");
    const input = scheduleInputSchema.parse(raw);
    const project = options.studio.snapshot(workspace).projects.find((item) => item.id === input.projectId);
    if (!project) throw new StudioError(404, "Project not found in this workspace.");
    if (project.status !== "active") throw new StudioError(409, "An archived project cannot learn.");
    const value = state(workspace);
    const at = now();
    const existing = value.schedules.find((item) => item.projectId === input.projectId);
    const paused = input.paused ?? existing?.paused ?? false;
    // Unpausing or changing the rhythm makes the schedule due now; a person changed their mind and expects to see it act.
    const schedule: LearningSchedule = {
      projectId: input.projectId, workspaceId: workspace, owner: actor, cadence: input.cadence, pattern: input.pattern ?? existing?.pattern ?? "", paused,
      createdAt: existing?.createdAt ?? at, updatedAt: at, nextRunAt: paused ? null : input.cadence === "manual" ? null : at,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    };
    if (existing) value.schedules[value.schedules.indexOf(existing)] = schedule; else value.schedules.push(schedule);
    save(workspace);
    return structuredClone(schedule);
  }

  function remove(workspace: string, _actor: string, roles: readonly Role[], projectId: string): void {
    if (!isAuthor(roles)) throw new StudioError(403, "Authors and admins set learning schedules.");
    const value = state(workspace);
    value.schedules = value.schedules.filter((item) => item.projectId !== projectId);
    save(workspace);
  }

  /** One cycle. Every studio call is the owner's; every stop is recorded with its reason. */
  function cycle(workspace: string, schedule: LearningSchedule, trigger: LearningRun["trigger"]): LearningRun {
    const startedAt = now();
    const steps: LearningStep[] = [];
    const roles: Role[] = ["author"];
    const exec = (command: Record<string, unknown>): StudioSnapshot => options.studio.execute(workspace, schedule.owner, roles, command, approvals);
    const note = (step: LearningStep["step"], outcome: LearningStep["outcome"], detail: string) => { steps.push({ step, outcome, detail, at: now() }); };
    let studio = options.studio.snapshot(workspace);
    const project = studio.projects.find((item) => item.id === schedule.projectId);
    const finish = (status: LearningRun["status"], summary: string): LearningRun => ({
      id: randomUUID(), workspaceId: workspace, projectId: schedule.projectId, project: project?.name ?? "", owner: schedule.owner, trigger, status,
      startedAt, finishedAt: now(), steps, summary,
    });
    if (!project || project.status !== "active") { schedule.paused = true; schedule.nextRunAt = null; return finish("stopped", "The project is archived or missing; the schedule is paused."); }
    let worked = false;
    try {
      // 1. Import: new files in the import folder that match the pattern and are not registered yet.
      const names = options.imports && schedule.pattern ? options.imports.list().filter((name) => matches(name, schedule.pattern)) : [];
      const registered: string[] = [];
      for (const name of names) {
        try { studio = exec({ action: "register_dataset", projectId: project.id, name, source: { kind: "file", path: name } }); registered.push(name); }
        catch (error) { if (!(error instanceof StudioError && error.status === 409)) throw error; }
      }
      if (registered.length) { worked = true; note("import", "done", `Registered ${registered.join(", ")}.`); }
      else note("import", "skipped", options.imports && schedule.pattern ? "No new files match the pattern." : "No import folder to watch.");

      // 2. Validate the newest registered content.
      const datasets = () => studio.datasets.filter((item) => item.projectId === project.id);
      const unchecked = [...datasets()].reverse().find((item) => item.status === "registered");
      if (unchecked) {
        studio = exec({ action: "validate_dataset", datasetId: unchecked.id });
        const checked = studio.datasets.find((item) => item.id === unchecked.id)!;
        worked = true;
        if (checked.status !== "valid") {
          const v = checked.validation!;
          note("validate", "stopped", `${checked.name} was rejected: ${v.rejected} of ${v.records} records failed${v.secretFindings ? `, ${v.secretFindings} with credentials` : ""}.`);
          return finish("stopped", `${checked.name} was rejected by validation; fix the content and the next cycle will pick it up.`);
        }
        note("validate", "done", `${checked.name} is valid: ${checked.validation!.records} records.`);
      } else note("validate", "skipped", "No unvalidated content.");

      // 3. Train the newest valid content that has no candidate yet.
      const trained = (datasetId: string) => studio.configs.some((config) => config.datasetId === datasetId && studio.jobs.some((job) => job.configId === config.id && job.status === "succeeded"));
      const fresh = [...datasets()].reverse().find((item) => item.status === "valid" && !trained(item.id));
      let jobId: string | undefined;
      if (fresh) {
        const provider = studio.providers[0];
        if (!provider) { note("train", "stopped", "No training provider is configured."); return finish("stopped", "No training provider is configured."); }
        studio = exec({ action: "configure_training", projectId: project.id, datasetId: fresh.id, provider: provider.id });
        const config = studio.configs.filter((item) => item.datasetId === fresh.id).at(-1)!;
        studio = exec({ action: "create_job", configId: config.id });
        jobId = studio.jobs.filter((item) => item.configId === config.id).at(-1)!.id;
        studio = exec({ action: "record_job", jobId });
        const job = studio.jobs.find((item) => item.id === jobId)!;
        worked = true;
        if (job.status === "running") { note("train", "done", `Training started with ${provider.label}; the next cycle checks it.`); return finish("stopped", "Training is running; the next cycle continues from it."); }
        if (job.status !== "succeeded") { note("train", "stopped", `Training ${job.status}: ${job.detail}`); return finish("stopped", `Training ${job.status}.`); }
        note("train", "done", `Candidate ${job.artifact?.hash.slice(0, 12) ?? ""} trained from ${fresh.name}.`);
      } else note("train", "skipped", "The newest valid content already has a candidate.");

      // 4. Evaluate the newest candidate that has not been evaluated.
      const candidate = [...studio.jobs].reverse().find((item) => item.projectId === project.id && item.status === "succeeded");
      let evaluation = candidate ? studio.evaluations.find((item) => item.jobId === candidate.id) : undefined;
      if (candidate && !evaluation) {
        studio = exec({ action: "run_evaluation", jobId: candidate.id });
        evaluation = studio.evaluations.find((item) => item.jobId === candidate.id)!;
        worked = true;
        if (!evaluation.passed) { note("evaluate", "stopped", `Evaluation failed: ${failingMetrics(evaluation)}.`); return finish("stopped", `The evaluation failed: ${failingMetrics(evaluation)}. More or cleaner content is needed.`); }
        note("evaluate", "done", `Evaluation passed: ${evaluation.comparison.filter((row) => row.passed).length} of ${evaluation.comparison.length} metrics.`);
      } else note("evaluate", "skipped", candidate ? "The candidate is already evaluated." : "No candidate to evaluate.");

      // 5. Request a release for a passing evaluation, unless one is already waiting.
      const releases = studio.releases.filter((item) => item.projectId === project.id);
      const pending = releases.find((item) => item.status === "pending_approval");
      if (!worked) { note("release", "skipped", pending ? `Release v${pending.version} is waiting for approval.` : "Nothing new to release."); return finish("stopped", "Nothing new to learn from."); }
      if (pending) { note("release", "skipped", `Release v${pending.version} is waiting for approval.`); return finish("stopped", `Release v${pending.version} is waiting for approval; nothing more until reviewers decide.`); }
      if (evaluation?.passed && !releases.some((item) => item.evaluationId === evaluation!.id && item.status !== "rejected")) {
        studio = exec({ action: "request_release", evaluationId: evaluation.id, note: "Requested by the learning schedule." });
        const release = studio.releases.filter((item) => item.projectId === project.id).at(-1)!;
        note("release", "done", `Release v${release.version} requested; ${release.requiredApprovals} approvals needed.`);
        return finish("complete", `Release v${release.version} requested from the new content; it needs ${release.requiredApprovals} approvals before the assistant changes.`);
      }
      note("release", "skipped", evaluation?.passed ? "This evaluation already has a release." : "No passing evaluation to release.");
      return finish("complete", "Content was checked; nothing new to release.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cycle could not finish.";
      note(steps.length < STEPS.length ? STEPS[steps.length]! : "release", "stopped", message);
      return finish("failed", message);
    }
  }

  function record(workspace: string, schedule: LearningSchedule, run: LearningRun): LearningRun {
    const value = state(workspace);
    value.runs.push(run);
    if (value.runs.length > MAX_RUNS) value.runs.splice(0, value.runs.length - MAX_RUNS);
    schedule.lastRunAt = run.startedAt;
    if (!schedule.paused) schedule.nextRunAt = later(run.startedAt, schedule.cadence);
    save(workspace);
    return structuredClone(run);
  }

  return {
    snapshot(workspace) { return structuredClone(state(workspace)); },
    set, remove,
    tick(workspace) {
      const at = now();
      const runs: LearningRun[] = [];
      for (const schedule of state(workspace).schedules) {
        if (schedule.paused || !schedule.nextRunAt || schedule.nextRunAt > at) continue;
        runs.push(record(workspace, schedule, cycle(workspace, schedule, "schedule")));
      }
      return runs;
    },
    runNow(workspace, actor, roles, projectId) {
      if (!isAuthor(roles)) throw new StudioError(403, "Authors and admins run learning cycles.");
      const schedule = state(workspace).schedules.find((item) => item.projectId === projectId);
      if (!schedule) throw new StudioError(404, "This project has no learning schedule.");
      if (!(roles.includes("admin") || schedule.owner === actor)) throw new StudioError(403, "Only the schedule's owner or an admin runs it by hand.");
      return record(workspace, schedule, cycle(workspace, schedule, "manual"));
    },
  };
}

/** A file name against a pattern with * wildcards. Case is respected; folders are not part of it. */
export function matches(name: string, pattern: string): boolean {
  const expression = "^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(expression).test(name);
}

/** The workspace's dataset import folder, top level files only. */
export function folderImports(directory: string): ImportSource {
  mkdirSync(directory, { recursive: true });
  return { list() {
    return readdirSync(directory).filter((name) => { try { return statSync(join(directory, name)).isFile(); } catch { return false; } }).sort();
  } };
}

/** One JSON file per workspace, written atomically like the other timelines. */
export function fileLearningPersistence(directory: string): LearningPersistence {
  mkdirSync(directory, { recursive: true });
  const pathFor = (workspace: string) => join(directory, `${digest(workspace)}.json`);
  return {
    read(workspace) {
      try { return learningStateSchema.parse(JSON.parse(readFileSync(pathFor(workspace), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    commit(workspace, value) { atomicJson(pathFor(workspace), value); },
  };
}
