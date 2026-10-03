import { randomUUID } from "node:crypto";
import { tokenUsageSchema, usageOf } from "./model-usage.js";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, digest } from "./bot-project.js";
import { z } from "zod";
import type { AgentModel } from "./chat.js";
import type { PipelineEngine, PipelineRun } from "./pipeline.js";
import type { AssistantBinding, AssistantResolver } from "./assistant-resolver.js";

/**
 * The scheduler: assistants working their stages on their own.
 *
 * A tick looks at every running workflow. When the active stage names an
 * assistant and has no job yet, a job is queued. Jobs run one at a time per
 * workspace: the assistant's binding is taken fresh (a retired release fails
 * the job with the reason), the model is asked for the stage's output, and
 * the answer is attached to the stage as a draft. The scheduler never
 * completes a stage and never approves anything; a person does that, with
 * the draft or without it. One job per run and stage: a failed job is
 * retried only when someone asks.
 */

export const JOB_STATUSES = ["queued", "running", "ready", "failed", "cancelled"] as const;
export const scheduledJobSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), runId: z.string().uuid(), stageId: z.string().min(1), stage: z.string(),
  title: z.string(), assistantId: z.string().uuid(), assistant: z.string(), model: z.string(),
  status: z.enum(JOB_STATUSES), queuedAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  /** Why it failed or was cancelled. Empty otherwise. */
  error: z.string(), draftHash: z.string(),
  /** Tokens the draft cost, when the provider reported them. */
  usage: tokenUsageSchema.optional(),
}).strict();
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;
export interface SchedulerSnapshot { jobs: ScheduledJob[]; busy: boolean }

export interface SchedulerPersistence {
  read(workspace: string): ScheduledJob[] | undefined;
  commit(workspace: string, jobs: ScheduledJob[]): void;
}
export interface SchedulerOptions {
  pipelines: PipelineEngine;
  assistants: AssistantResolver;
  /** Loads the model an assistant's release names. Missing chat configuration throws, and the job records that. */
  loadModel: (model: string) => Promise<AgentModel>;
  persistence?: SchedulerPersistence;
  now?: () => string;
  /** Seconds a single model call may take. */
  timeoutSeconds?: number;
}
export interface Scheduler {
  snapshot(workspace: string): SchedulerSnapshot;
  /** Queue jobs for every running workflow whose active stage is staffed by an assistant. */
  enqueue(workspace: string): ScheduledJob[];
  /** Enqueue, then run every queued job in turn. Resolves when the workspace is idle again. */
  tick(workspace: string): Promise<void>;
  retry(workspace: string, jobId: string): void;
  cancel(workspace: string, jobId: string): void;
  close(): Promise<void>;
}

const MAX_JOBS = 200;
const DRAFT_LIMIT = 4000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? (() => new Date().toISOString());
  const timeout = (options.timeoutSeconds ?? 300) * 1000;
  const jobsByWorkspace = new Map<string, ScheduledJob[]>();
  const running = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;

  function jobs(workspace: string): ScheduledJob[] {
    let list = jobsByWorkspace.get(workspace);
    if (!list) {
      list = z.array(scheduledJobSchema).parse(options.persistence?.read(workspace) ?? []);
      // A job recorded as running belongs to a process that is gone. Its
      // result, if any, never reached the stage, so it is failed rather than
      // resumed or trusted.
      for (const job of list) {
        if (job.status === "running") { job.status = "failed"; job.error = "The application stopped while this job was running; it was interrupted."; job.finishedAt = now(); }
      }
      jobsByWorkspace.set(workspace, list);
      if (options.persistence && list.some((job) => job.error.includes("interrupted"))) options.persistence.commit(workspace, list);
    }
    return list;
  }
  function save(workspace: string): void {
    options.persistence?.commit(workspace, jobs(workspace));
  }
  function snapshot(workspace: string): SchedulerSnapshot {
    return structuredClone({ jobs: jobs(workspace), busy: running.has(workspace) });
  }

  function enqueue(workspace: string): ScheduledJob[] {
    const list = jobs(workspace);
    const added: ScheduledJob[] = [];
    for (const run of options.pipelines.snapshot(workspace).runs) {
      if (run.status !== "running") continue;
      const stage = run.config.stages[run.current];
      const progress = run.stages[run.current];
      if (!stage?.assistantId || progress?.status !== "active") continue;
      if (list.some((job) => job.runId === run.id && job.stageId === stage.id)) continue;
      if (list.length >= MAX_JOBS) break;
      const job: ScheduledJob = { id: randomUUID(), workspaceId: workspace, runId: run.id, stageId: stage.id, stage: stage.name, title: run.title,
        assistantId: stage.assistantId, assistant: "", model: "", status: "queued", queuedAt: now(), error: "", draftHash: "" };
      list.push(job); added.push(job);
    }
    if (added.length) save(workspace);
    return added;
  }

  async function work(workspace: string, job: ScheduledJob): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    job.status = "running"; job.startedAt = now(); save(workspace);
    try {
      const run = options.pipelines.snapshot(workspace).runs.find((item) => item.id === job.runId);
      const active = run && run.status === "running" && run.config.stages[run.current]?.id === job.stageId && run.stages[run.current]?.status === "active";
      if (!run || !active) throw new Cancelled("The stage is no longer active; the workflow moved on or stopped.");
      // The binding is taken now, under the same rules as chat, so a release
      // retired since the job was queued stops it here.
      const unit = options.assistants(workspace, job.assistantId);
      job.assistant = unit.name; job.model = unit.model; save(workspace);
      const model = await options.loadModel(unit.model);
      controller.signal.throwIfAborted();
      const answer = await model.invoke(stagePrompt(unit, run), { signal: controller.signal });
      controller.signal.throwIfAborted();
      const usage = usageOf(answer);
      if (usage) job.usage = usage;
      const text = draftText(answer.content);
      if (!text) throw new Error("The model did not return a draft.");
      // Attach only if the stage is still where the job left it.
      const latest = options.pipelines.snapshot(workspace).runs.find((item) => item.id === job.runId);
      if (!latest || latest.status !== "running" || latest.config.stages[latest.current]?.id !== job.stageId) throw new Cancelled("The stage is no longer active; the workflow moved on or stopped.");
      const after = options.pipelines.draft(workspace, { runId: job.runId, stageId: job.stageId, expectedRevision: latest.revision, text, by: unit.name, jobId: job.id });
      job.draftHash = after.runs.find((item) => item.id === job.runId)!.stages[latest.current]!.draft!.hash;
      job.status = "ready";
    } catch (error) {
      job.status = error instanceof Cancelled ? "cancelled" : "failed";
      job.error = controller.signal.aborted ? "The model did not answer in time." : error instanceof Error ? error.message : "The job could not finish.";
    } finally {
      clearTimeout(timer); controllers.delete(controller);
      job.finishedAt = now(); save(workspace);
    }
  }

  async function drain(workspace: string): Promise<void> {
    for (;;) {
      if (closed) return;
      const next = jobs(workspace).find((job) => job.status === "queued");
      if (!next) return;
      await work(workspace, next);
    }
  }

  return {
    snapshot, enqueue,
    tick(workspace) {
      if (closed) return Promise.resolve();
      enqueue(workspace);
      // One loop per workspace. A tick during a loop joins it.
      const current = running.get(workspace);
      if (current) return current;
      const loop = drain(workspace).finally(() => { running.delete(workspace); });
      running.set(workspace, loop);
      return loop;
    },
    retry(workspace, jobId) {
      const job = jobs(workspace).find((item) => item.id === jobId);
      if (!job || (job.status !== "failed" && job.status !== "cancelled")) return;
      job.status = "queued"; job.error = ""; job.queuedAt = now(); delete job.startedAt; delete job.finishedAt; save(workspace);
    },
    cancel(workspace, jobId) {
      const job = jobs(workspace).find((item) => item.id === jobId);
      if (!job || job.status !== "queued") return;
      job.status = "cancelled"; job.error = "Cancelled before it ran."; job.finishedAt = now(); save(workspace);
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(running.values());
    },
  };
}

class Cancelled extends Error {}

/** What the assistant is asked. Completed outputs are handed over; nothing else about the workspace is. */
export function stagePrompt(unit: AssistantBinding, run: PipelineRun): string {
  const stage = run.config.stages[run.current]!;
  const done = run.config.stages.slice(0, run.current).map((item, index) => `- ${item.name}: ${run.stages[index]!.output}`).join("\n") || "- none yet";
  return [
    `You are ${unit.name}, an approved assistant (release ${unit.release}). ${unit.instructions}`,
    `You are working one stage of the workflow "${run.config.name}".`,
    `Request: ${run.title}`,
    `Brief: ${run.brief}`,
    `Stage: ${stage.name}. ${stage.instructions}`,
    `Completed stages:\n${done}`,
    "STAGE DRAFT. Write the output for this stage as plain text of at most 2000 characters. Record only what the brief and the completed stages support; list anything unknown as an open question. You have changed no system and run no tool. A person will review this draft and decide whether to use it.",
    'Return one JSON object without markdown fences: {"type":"draft","text":"the stage output"}.',
  ].join("\n");
}

/** The draft text from whatever the model returned: the JSON shape asked for, a chat style answer, or plain text. */
export function draftText(content: unknown): string {
  const raw = typeof content === "string" ? content : content && typeof content === "object" ? JSON.stringify(content) : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const text = parsed && typeof parsed === "object" ? (typeof parsed.text === "string" ? parsed.text : typeof parsed.content === "string" ? parsed.content : "") : "";
    return text.trim().slice(0, DRAFT_LIMIT);
  } catch {
    // Not JSON: plain prose is still a draft, as long as it is not a stray JSON looking fragment.
    return trimmed.startsWith("{") ? "" : trimmed.slice(0, DRAFT_LIMIT);
  }
}

/** One JSON file per workspace, written atomically like the bot timeline. */
export function fileSchedulePersistence(directory: string): SchedulerPersistence {
  mkdirSync(directory, { recursive: true });
  const pathFor = (workspace: string) => join(directory, `${digest(workspace)}.json`);
  return {
    read(workspace) {
      try { return z.array(scheduledJobSchema).parse(JSON.parse(readFileSync(pathFor(workspace), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    commit(workspace, jobs) { atomicJson(pathFor(workspace), jobs); },
  };
}

/** The model loader for a chat configuration: the assistant's release names the model, chat loads it. */
export function chatModelLoader(chat: { loadModel: (model?: string) => Promise<AgentModel> } | undefined): SchedulerOptions["loadModel"] {
  return async (model) => {
    if (!chat) throw new Error("No model is configured. Start Ollama and choose a model before assistants can draft.");
    return chat.loadModel(model);
  };
}
