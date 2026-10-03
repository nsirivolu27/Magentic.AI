import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Role } from "../registry/roles.js";
import type { ChatConfiguration } from "./chat.js";
import { untilAborted } from "./chat.js";
import { PipelineError, type PipelineEngine, type PipelineRun } from "./pipeline.js";
import { attemptSchema, botCommandSchema, DEFAULT_BOT_POLICY, projectSchema, type BotAttempt, type BotSnapshot } from "./bot-schema.js";
import { applyChanges, atomicJson, command, createCheckout, digest, inspectProject, readProjectFile, treeDigest } from "./bot-project.js";
import { BotHandoffError, BotToolPolicyError, runBotWorker } from "./bot-worker.js";
import { handoffText } from "./bot-profiles.js";
import type { AssistantResolver } from "./assistant-resolver.js";

const stateSchema = z.object({
  version: z.literal(1), workspaceId: z.string(), project: projectSchema.nullable(),
  attempts: z.array(attemptSchema).max(100),
  checkouts: z.record(z.object({ checkout: z.string(), baseCommit: z.string() }).strict()),
}).strict();
type State = z.infer<typeof stateSchema>;
export interface BotRuntime {
  snapshot(workspace: string): BotSnapshot;
  busy(workspace: string): boolean;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, approvals: number): Promise<BotSnapshot>;
  close(): Promise<void>;
}

// This store shares the local application's writer lock. Attempts are separate
// from pipeline transitions so an interrupted model cannot complete a phase.
export function createBotRuntime(directory: string, pipelines: PipelineEngine, chat?: ChatConfiguration, assistants?: AssistantResolver): BotRuntime {
  mkdirSync(directory, { recursive: true });
  const states = new Map<string, State>();
  const active = new Map<string, { controller: AbortController; done: Promise<void>; attemptId: string }>();
  const locks = new Set<string>();
  let closed = false;
  const operations = new Set<Promise<BotSnapshot>>();
  const checkControllers = new Set<AbortController>();
  const pathFor = (workspace: string) => join(directory, `${digest(workspace)}.json`);
  const save = (state: State) => atomicJson(pathFor(state.workspaceId), stateSchema.parse(state));
  function state(workspace: string): State {
    const cached = states.get(workspace); if (cached) return cached;
    let value: State;
    try {
      value = stateSchema.parse(JSON.parse(readFileSync(pathFor(workspace), "utf8")));
      if (value.workspaceId !== workspace) throw new Error("Workspace binding does not match.");
      for (const attempt of value.attempts) {
        if (attempt.status === "applying") {
          const complete = attempt.changes.every(change => readProjectFile(attempt.checkout, change.path) === change.after);
          attempt.status = complete ? "applied" : "interrupted";
          if (!complete) attempt.error = "File application was interrupted. Inspect the checkout before starting a new attempt.";
        }
        const run = pipelines.snapshot(workspace).runs.find(run => run.id === attempt.runId);
        if (run?.stages.some(stage => stage.output.includes(`Bot attempt: ${attempt.id}\nProposal: ${attempt.proposalHash}`))) attempt.status = "accepted";
        if (attempt.status === "running") {
          attempt.status = "interrupted"; attempt.error = "The application stopped before this bot finished. Start a new attempt.";
          attempt.finishedAt = new Date().toISOString();
        }
      }
      save(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PipelineError(409, "The saved bot timeline is unreadable. Restore its file before continuing.");
      value = { version: 1, workspaceId: workspace, project: null, attempts: [], checkouts: {} };
    }
    states.set(workspace, value); return value;
  }
  const busy = (workspace: string) => active.has(workspace) || locks.has(workspace);
  function snapshot(workspace: string): BotSnapshot {
    const value = state(workspace);
    return structuredClone({ project: value.project, attempts: value.attempts, busy: busy(workspace) });
  }
  function current(workspace: string, actor: string, roles: readonly Role[], runId: string, revision: number): PipelineRun {
    const run = pipelines.snapshot(workspace).runs.find(item => item.id === runId);
    if (!run) throw new PipelineError(404, "Run not found in this workspace.");
    if (!roles.includes("admin") && !(roles.includes("author") && actor === run.owner)) throw new PipelineError(403, "The run owner or an admin must operate this bot.");
    if (run.revision !== revision) throw new PipelineError(409, "The run changed. Refresh before operating this bot.");
    if (run.status !== "running" || run.stages[run.current]!.status !== "active") throw new PipelineError(409, "Only the active phase of a running workflow can execute a bot.");
    return run;
  }
  function event(value: State, attempt: BotAttempt, message: string) {
    attempt.events = attempt.events.slice(-49);
    attempt.events.push({ at: new Date().toISOString(), message }); save(value);
  }
  async function work(value: State, attempt: BotAttempt, run: PipelineRun, controller: AbortController, previousAttempt?: BotAttempt): Promise<void> {
    const timer = setTimeout(() => controller.abort(), attempt.bot.timeoutSeconds * 1000);
    try {
      if (!chat) throw new Error("No model configured.");
      const choices = await untilAborted(chat.modelOptions ? chat.modelOptions()
        : (chat.listModels ? chat.listModels() : Promise.resolve([chat.model])).then(names => names.map(id => ({ id, available: true }))), controller.signal);
      if (!choices.some(item => item.id === attempt.model && item.available)) throw new Error("Selected model unavailable.");
      const model = await untilAborted(chat.loadModel(attempt.model), controller.signal);
      // Previous prose can claim success. Only checks recorded for this run
      // and the current tree are presented as command evidence to a model.
      const checked = value.attempts.filter(item => item.runId === run.id && item.checkout === attempt.checkout && item.checkedTree && item.checks.length);
      const tree = checked.length ? await treeDigest(attempt.checkout) : "";
      const evidence = checked.filter(item => item.checkedTree === tree).slice(-3)
        .map(item => ({ attemptId: item.id, stageId: item.stageId,
          checks: item.checks.map(check => ({ ...check, output: check.output.slice(0, 2000) })) }));
      const result = await runBotWorker(attempt, run, model, controller.signal, message => event(value, attempt, message), evidence, previousAttempt);
      controller.signal.throwIfAborted();
      current(value.workspaceId, attempt.actor, ["admin"], run.id, attempt.revision);
      attempt.summary = result.summary; attempt.changes = result.changes;
      if (result.handoff) attempt.handoff = result.handoff;
      attempt.proposalHash = digest(JSON.stringify(result));
      attempt.status = "ready"; event(value, attempt, "Result ready for review. No phase was advanced.");
    } catch (error) {
      attempt.status = controller.signal.aborted ? "cancelled" : "failed";
      attempt.error = controller.signal.aborted ? "The bot stopped or reached its time limit."
        : error instanceof BotToolPolicyError || error instanceof BotHandoffError ? error.message
        : "The bot could not finish. Check the selected model, repository access, and tool budget; then start a new attempt.";
    } finally {
      clearTimeout(timer); attempt.finishedAt = new Date().toISOString();
      try { save(value); } finally { active.delete(value.workspaceId); }
    }
  }
  async function execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown, approvals: number): Promise<BotSnapshot> {
      if (closed) throw new PipelineError(409, "The bot runtime is stopping.");
      if (!roles.length) throw new PipelineError(403, "Workspace membership is required.");
      const input = botCommandSchema.parse(raw);
      const value = state(workspace);
      if (input.action === "cancel") {
        const attempt = value.attempts.find(item => item.id === input.attemptId);
        if (!attempt) throw new PipelineError(404, "Bot attempt not found.");
        if (attempt.actor !== actor && !roles.includes("admin")) throw new PipelineError(403, "Only the operator or admin may stop this bot.");
        if (active.get(workspace)?.attemptId !== attempt.id) throw new PipelineError(409, "This bot is not running.");
        active.get(workspace)!.controller.abort(); return snapshot(workspace);
      }
      if (busy(workspace)) throw new PipelineError(409, "A bot or repository operation is active. Stop it or wait before changing this workspace.");
      locks.add(workspace);
      try {
        if (input.action === "attach") {
          if (!roles.includes("admin")) throw new PipelineError(403, "Only an admin can attach a repository or configure commands.");
          if (value.attempts.length) throw new PipelineError(409, "This workspace already has bot history. Create a new workspace to attach another repository or change check commands.");
          const project = await inspectProject(input.project);
          save({ ...value, project }); value.project = project;
        } else if (input.action === "start") {
          const previous = value.attempts.find(item => item.requestId === input.requestId);
          if (previous) {
            if (previous.runId !== input.runId || previous.actor !== actor || previous.revision !== input.expectedRevision
              || previous.revisionSource?.attemptId !== input.revisionSource?.attemptId
              || previous.revisionSource?.expectedHash !== input.revisionSource?.expectedHash
              || previous.revisionSource?.feedback !== input.revisionSource?.feedback) throw new PipelineError(409, "This request ID belongs to a different bot attempt.");
            return snapshot(workspace);
          }
          const run = current(workspace, actor, roles, input.runId, input.expectedRevision);
          const definition = run.config.stages[run.current]!;
          let revisionSource: BotAttempt | undefined;
          if (input.revisionSource) {
            revisionSource = value.attempts.find(item => item.id === input.revisionSource!.attemptId);
            if (!revisionSource || revisionSource.runId !== run.id || revisionSource.stageId !== definition.id) {
              throw new PipelineError(404, "Revision source not found in this run's active phase.");
            }
            if (!["ready", "applied", "failed", "cancelled", "interrupted"].includes(revisionSource.status)) {
              throw new PipelineError(409, "This attempt cannot be revised. Use its latest revision or start a new attempt.");
            }
            if (revisionSource.proposalHash !== input.revisionSource.expectedHash) {
              throw new PipelineError(409, "The revision source changed. Refresh before giving feedback.");
            }
          }
          const bot = definition.bot ?? DEFAULT_BOT_POLICY;
          if (bot.kind === "manual") throw new PipelineError(400, "Assign a bot to this phase before starting a new run.");
          if (!value.project) throw new PipelineError(400, "Attach a Git repository first.");
          if (value.attempts.length >= 100) throw new PipelineError(409, "This workspace holds at most 100 bot attempts.");
          if (active.size >= 2) throw new PipelineError(429, "Two bots are already running. Wait for one to finish.");
          let checkout = value.checkouts[run.id];
          if (!checkout) {
            checkout = await createCheckout(value.project, join(directory, "checkouts", digest(workspace).slice(0, 24), run.id));
            const checkouts = { ...value.checkouts, [run.id]: checkout };
            save({ ...value, checkouts }); value.checkouts = checkouts;
          }
          // A stage staffed by an assistant runs with that assistant's approved
          // model and instructions, resolved now, under the chat rules.
          if (definition.assistantId && !assistants) throw new PipelineError(409, "This phase names an assistant, but Model Studio is not configured here.");
          const unit = definition.assistantId ? assistants!(workspace, definition.assistantId) : undefined;
          const attempt: BotAttempt = { id: randomUUID(), requestId: input.requestId, runId: run.id,
            stageId: definition.id, revision: run.revision, actor, bot: structuredClone(bot), model: unit?.model ?? definition.model,
            ...(unit ? { assistant: { id: unit.id, name: unit.name, release: unit.release, instructions: unit.instructions } } : {}),
            ...checkout, startedAt: new Date().toISOString(), status: "running", summary: "", error: "", calls: 0,
            ...(input.revisionSource ? { revisionSource: structuredClone(input.revisionSource) } : {}),
            tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" };
          // The old result and its replacement change together on disk. A
          // restart must never make a superseded proposal actionable again.
          const attempts = value.attempts.map(item => item.id === revisionSource?.id ? { ...item, status: "superseded" as const } : item);
          attempts.push(attempt);
          save({ ...value, attempts }); value.attempts = attempts;
          const controller = new AbortController();
          // Deferring work lets the active marker exist before a synchronous
          // provider failure reaches cleanup.
          const previousAttempt = revisionSource ? structuredClone(revisionSource) : undefined;
          const done = Promise.resolve().then(() => work(value, attempt, run, controller, previousAttempt)).catch(() => {
            attempt.status = "failed"; attempt.error = "Timeline could not be saved. Reopen the application before continuing.";
          });
          active.set(workspace, { controller, done, attemptId: attempt.id });
        } else {
          const attempt = value.attempts.find(item => item.id === input.attemptId);
          if (!attempt) throw new PipelineError(404, "Bot attempt not found in this workspace.");
          const run = current(workspace, actor, roles, attempt.runId, attempt.revision);
          if (run.config.stages[run.current]!.id !== attempt.stageId) throw new PipelineError(409, "The active phase changed.");
          if (input.expectedHash !== attempt.proposalHash) throw new PipelineError(409, "The bot result changed. Refresh before acting.");
          if (!["ready", "applied"].includes(attempt.status)) throw new PipelineError(409, "This attempt has no reviewable result.");
          if (input.action === "apply") {
            if (attempt.status !== "ready" || !attempt.changes.length) throw new PipelineError(409, "There are no pending file changes.");
            // The intent is durable before files change. Restart can detect
            // a fully applied proposal or leave partial work for inspection.
            attempt.status = "applying"; save(value);
            try {
              applyChanges(attempt.checkout, attempt.changes);
              attempt.status = "applied"; attempt.checkedTree = ""; attempt.checks = [];
              event(value, attempt, "Reviewed proposal applied to the isolated checkout.");
            } catch (error) {
              attempt.status = "interrupted"; attempt.error = "File application needs inspection. The checkout may contain changes; start a new attempt after reviewing it.";
              save(value); throw error;
            }
          } else if (input.action === "checks") {
            if (!value.project?.checks.length) throw new PipelineError(400, "No validation commands were configured when this repository was attached.");
            if (attempt.changes.length && attempt.status !== "applied") throw new PipelineError(409, "Apply the proposed changes before running checks.");
            attempt.checks = []; attempt.checkedTree = "";
            save(value);
            const controller = new AbortController(); checkControllers.add(controller);
            try {
              const treeBeforeChecks = await treeDigest(attempt.checkout);
              for (const check of value.project.checks) {
                controller.signal.throwIfAborted();
                const checked = await command(check.executable, check.args, attempt.checkout, controller.signal);
                attempt.checks.push({ command: check, ...checked }); save(value);
                if (!checked.passed) break;
              }
              const treeAfterChecks = await treeDigest(attempt.checkout);
              controller.signal.throwIfAborted();
              if (treeBeforeChecks !== treeAfterChecks) {
                event(value, attempt, "The checkout changed during validation. Check results do not verify the current source.");
                throw new PipelineError(409, "The checkout changed while checks were running. Inspect the changes and run checks again before handoff.");
              }
              attempt.checkedTree = treeAfterChecks;
              event(value, attempt, "Configured checks finished. Exit codes are recorded in the timeline.");
            } finally { checkControllers.delete(controller); }
          } else if (input.action === "accept") {
            if (attempt.handoff?.blockers.length) throw new PipelineError(409, "Resolve the agent's blockers and run a new attempt before handing off.");
            if (attempt.changes.length && attempt.status !== "applied") throw new PipelineError(409, "Apply the reviewed changes before handing off this result.");
            if (attempt.changes.some(change => readProjectFile(attempt.checkout, change.path) !== change.after)) throw new PipelineError(409, "Applied files changed after review. Run the bot again.");
            if (attempt.bot.kind === "validator" && !value.project?.checks.length) throw new PipelineError(409, "Validation requires configured checks.");
            if ((attempt.bot.kind === "coder" || attempt.bot.kind === "validator") && value.project?.checks.length) {
              if (attempt.checks.length !== value.project.checks.length || attempt.checks.some(check => !check.passed)) throw new PipelineError(409, "Every configured check must pass before handoff.");
              if (attempt.checkedTree !== await treeDigest(attempt.checkout)) throw new PipelineError(409, "The checkout changed after validation. Run checks again.");
            }
            const trace = `\n\nBot attempt: ${attempt.id}\nProposal: ${attempt.proposalHash}\nCheckout: ${attempt.checkout}\nChecks: ${attempt.checks.length ? attempt.checks.map(check => check.passed ? "passed" : "failed").join(", ") : "not run"}`;
            const report = attempt.summary + (attempt.handoff ? "\n\n" + handoffText(attempt.handoff) : "");
            // Keep the evidence reference intact even for a long legacy summary.
            const note = report.slice(0, Math.max(0, 4000 - trace.length)) + trace;
            pipelines.execute(workspace, actor, roles, { action: "complete", runId: run.id, expectedRevision: run.revision, note }, approvals);
            attempt.status = "accepted"; event(value, attempt, "Result submitted through the pipeline's existing approval gate.");
          }
        }
      } finally { locks.delete(workspace); }
      return snapshot(workspace);
  }
  return {
    snapshot, busy,
    execute(workspace, actor, roles, raw, approvals) {
      const operation = execute(workspace, actor, roles, raw, approvals);
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => undefined);
      return operation;
    },
    async close() {
      closed = true;
      for (const controller of checkControllers) controller.abort();
      for (const task of active.values()) task.controller.abort();
      await Promise.allSettled([...operations]);
      for (const task of active.values()) task.controller.abort();
      await Promise.allSettled([...active.values()].map(task => task.done));
    },
  };
}
