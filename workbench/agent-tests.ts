import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Role } from "../registry/roles.js";
import { PermissionError } from "../registry/roles.js";
import type { AgentConfigurable } from "./agent-configurables.js";
import { atomicJson, digest, readProjectFile } from "./bot-project.js";
import type { BotRuntime } from "./bot-runtime.js";
import { attemptSchema, effectiveToolPolicy, type BotAttempt } from "./bot-schema.js";
import { BotHandoffError, BotToolPolicyError, runBotWorker } from "./bot-worker.js";
import { untilAborted, type ChatConfiguration } from "./chat.js";
import { PipelineError, type PipelineEngine, type PipelineRun } from "./pipeline.js";
import { agentHash, agentTestCommandSchema, testCaseSchema, testRunSchema, toolCallsFrom, type AgentTestCase, type AgentTestRun, type AgentTestsSnapshot } from "./agent-tests-model.js";
export { agentHash, agentTestCommandSchema, testCaseSchema, testRunSchema, toolCallsFrom, TEST_RUN_STATUSES, type AgentTestCase, type AgentTestRun, type AgentTestsSnapshot } from "./agent-tests-model.js";

/**
 * Agent tests: a saved prompt run against one saved version of an agent.
 *
 * A test is not a workflow run. It executes the same worker, with the same
 * tools, limits and required-read rule the agent will have on a stage, but
 * it advances nothing and approves nothing: the result is evidence for the
 * person deciding whether to assign the agent. Three things are recorded
 * separately and never merged into one verdict: whether the execution
 * finished, what the automated checks said, and what a reviewer concluded.
 */

const stateSchema = z.object({ version: z.literal(1), workspaceId: z.string().min(1), cases: z.array(testCaseSchema).max(200), runs: z.array(testRunSchema).max(300) }).strict();
type State = z.infer<typeof stateSchema>;

export interface AgentTestsEngine {
  snapshot(workspace: string): AgentTestsSnapshot;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown): Promise<AgentTestsSnapshot>;
  /** Resolves when no test is running in the workspace. Tests wait on it; production code does not need it. */
  settled(workspace: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentTestsOptions {
  /** Where each workspace's tests are kept. Omitted means memory only, which the scripted demo uses. */
  directory?: string;
  pipelines: Pick<PipelineEngine, "snapshot">;
  bots: Pick<BotRuntime, "snapshot">;
  chat?: ChatConfiguration;
}

const MAX_CASES = 200;
const MAX_RUNS = 300;

export function createAgentTests(options: AgentTestsOptions): AgentTestsEngine {
  const states = new Map<string, State>();
  const active = new Map<string, { runId: string; controller: AbortController; done: Promise<void> }>();
  let closed = false;
  if (options.directory) mkdirSync(options.directory, { recursive: true });
  const pathFor = (workspace: string) => join(options.directory!, `${digest(workspace)}.json`);

  function state(workspace: string): State {
    const cached = states.get(workspace);
    if (cached) return cached;
    let value: State = { version: 1, workspaceId: workspace, cases: [], runs: [] };
    if (options.directory) {
      try {
        value = stateSchema.parse(JSON.parse(readFileSync(pathFor(workspace), "utf8")));
        if (value.workspaceId !== workspace) throw new Error("Workspace binding does not match.");
        // A run that was in flight when the application stopped has no result. It stays, marked, so the gap is visible.
        for (const run of value.runs) if (run.status === "running") { run.status = "cancelled"; run.error = "The application stopped before this test finished. Run it again."; run.finishedAt = new Date().toISOString(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    states.set(workspace, value);
    return value;
  }
  function save(value: State): void {
    stateSchema.parse(value);
    if (options.directory) atomicJson(pathFor(value.workspaceId), value);
  }
  function snapshot(workspace: string): AgentTestsSnapshot {
    const value = state(workspace);
    return structuredClone({ cases: value.cases, runs: value.runs, busy: active.has(workspace) });
  }

  function agentOf(workspace: string, agentId: string): AgentConfigurable {
    const agent = options.pipelines.snapshot(workspace).config.configurables?.find(item => item.id === agentId);
    if (!agent) throw new PipelineError(404, "This agent is not in this workspace.");
    return agent;
  }

  /** Everything a test needs before a model is loaded, each refusal naming the fix. */
  async function readiness(workspace: string, agent: AgentConfigurable, testCase: AgentTestCase): Promise<{ checkout: string }> {
    if (!options.chat) throw new PipelineError(409, "No model provider is configured for workflow agents. Connect one, then run the test.");
    const choices = options.chat.modelOptions ? await options.chat.modelOptions()
      : (options.chat.listModels ? await options.chat.listModels() : [options.chat.model]).map(id => ({ id, available: true }));
    if (!choices.some(item => item.id === agent.model && item.available)) throw new PipelineError(409, `The model "${agent.model}" is not connected. Choose an available model in Knowledge and tools, save, then run the test.`);
    const policy = effectiveToolPolicy(agent.bot);
    if (agent.bot.requireSourceRead && !policy.allowedTools.includes("read_project_file")) throw new PipelineError(409, "Required source reading needs the read file tool. Choose it in Knowledge and tools.");
    const project = options.bots.snapshot(workspace).project;
    if (!project) throw new PipelineError(409, "No repository is attached, so the agent has nothing to read. Attach one from Work items, then run the test.");
    if (testCase.source) {
      const content = readProjectFile(project.root, testCase.source);
      if (content === null) throw new PipelineError(409, `The source "${testCase.source}" is not in the attached repository. Fix the path or add the file.`);
      if (!content.trim()) throw new PipelineError(409, `The source "${testCase.source}" is empty, so a required read could never succeed. Add content or choose another file.`);
      if (!policy.allowedTools.includes("read_project_file")) throw new PipelineError(409, "This test names a source but the agent may not read files. Choose the read file tool in Knowledge and tools.");
    }
    if ((agent.bot.requireSourceRead || testCase.source) && (policy.maxToolCalls < 1 || agent.bot.maxSteps < 2)) {
      throw new PipelineError(409, "Source reading needs at least 1 tool call and 2 model calls: one to request evidence, one to answer. Update Execution limits.");
    }
    return { checkout: project.root };
  }

  /** A one stage run that exists only for the length of the test. It is never stored with the workflow runs. */
  function trialRun(workspace: string, actor: string, agent: AgentConfigurable, testCase: AgentTestCase): PipelineRun {
    const pipeline = options.pipelines.snapshot(workspace);
    const config = pipeline.config;
    const base = config.stages[0]!;
    const at = new Date().toISOString();
    const brief = [testCase.prompt, testCase.source ? `Source to read with read_project_file: ${testCase.source}` : "", testCase.expected ? `What a good answer covers (for the reviewer, not a claim of success): ${testCase.expected}` : ""].filter(Boolean).join("\n\n");
    return { id: randomUUID(), requestId: randomUUID(), workspaceId: workspace, owner: actor, title: testCase.title, brief, issueKey: null,
      config: { ...config, stages: [{ ...base, id: "test", name: "Agent test", agent: agent.name, instructions: agent.instructions, approval: false, model: agent.model, bot: structuredClone(agent.bot), context: "A saved test prompt. Nothing here is a workflow handoff." }] },
      version: pipeline.version, revision: 1, requiredApprovals: 1, createdAt: at, updatedAt: at, status: "running", current: 0,
      stages: [{ status: "active", output: "", outputHash: "", outputBy: "", approvals: [] }], events: [], jira: [] };
  }

  async function work(value: State, run: AgentTestRun, agent: AgentConfigurable, testCase: AgentTestCase, checkout: string, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort("timeout"), agent.bot.timeoutSeconds * 1000);
    const attempt: BotAttempt = attemptSchema.parse({ id: run.id, requestId: run.id, runId: run.id, stageId: "test", revision: 1, actor: run.startedBy, bot: agent.bot, model: agent.model,
      checkout, baseCommit: "test", startedAt: run.startedAt, status: "running", summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
    const note = (message: string) => {
      run.events = [...run.events.slice(-59), message.slice(0, 500)];
      // A running test must report evidence as it arrives, not only after the model finishes.
      run.calls = attempt.calls;
      run.tokenUsage = attempt.tokenUsage;
      run.toolCalls = toolCallsFrom(run.events);
      run.sourceRead = run.toolCalls.some(call => call.outcome === "read");
      save(value);
    };
    try {
      const model = await untilAborted(options.chat!.loadModel(agent.model, { maxOutputTokens: 1024 }), controller.signal);
      const result = await runBotWorker(attempt, trialRun(value.workspaceId, run.startedBy, agent, testCase), model, controller.signal, note);
      controller.signal.throwIfAborted();
      run.summary = result.summary.slice(0, 40_000);
      run.status = "succeeded";
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      if (controller.signal.aborted) {
        if (controller.signal.reason === "shutdown") {
          run.error = "The application restarted or stopped before this test finished. Reconnect and run it again.";
        } else if (controller.signal.reason === "user") {
          run.error = "Stopped by a workspace operator. No answer was accepted.";
        } else {
          run.error = `The test stopped at the ${agent.bot.timeoutSeconds} second limit. Try a smaller task or a faster connected model before increasing the limit.`;
        }
      } else {
        run.error = error instanceof BotToolPolicyError || error instanceof BotHandoffError ? error.message
          : "The agent could not finish. Check the model connection, repository access and tool budget, then run again.";
      }
    } finally {
      clearTimeout(timer);
      run.calls = attempt.calls; run.tokenUsage = attempt.tokenUsage;
      run.toolCalls = toolCallsFrom(run.events);
      run.sourceRead = run.toolCalls.some(call => call.outcome === "read");
      run.finishedAt = new Date().toISOString();
      try { save(value); } finally { active.delete(value.workspaceId); }
    }
  }

  async function execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown): Promise<AgentTestsSnapshot> {
    if (closed) throw new PipelineError(409, "The application is stopping.");
    if (!roles.length) throw new PermissionError("You are not a member of this workspace.");
    const input = agentTestCommandSchema.parse(raw);
    const value = state(workspace);
    const author = roles.includes("author") || roles.includes("admin");
    const at = new Date().toISOString();
    if (input.action === "save_case") {
      if (!author) throw new PermissionError("An author or admin writes test cases.");
      const agent = agentOf(workspace, input.agentId);
      const existing = input.id ? value.cases.find(item => item.id === input.id) : undefined;
      if (input.id && !existing) throw new PipelineError(404, "This test case is not in this workspace.");
      if (existing && existing.agentId !== agent.id) throw new PipelineError(409, "A test case stays with the agent it was written for.");
      if (!existing && value.cases.length >= MAX_CASES) throw new PipelineError(409, `A workspace keeps up to ${MAX_CASES} test cases. Delete one first.`);
      const saved = testCaseSchema.parse({ id: existing?.id ?? randomUUID(), workspaceId: workspace, agentId: agent.id, title: input.title, prompt: input.prompt, expected: input.expected, source: input.source,
        createdBy: existing?.createdBy ?? actor, createdAt: existing?.createdAt ?? at, updatedAt: at });
      value.cases = existing ? value.cases.map(item => item.id === saved.id ? saved : item) : [...value.cases, saved];
      save(value);
      return snapshot(workspace);
    }
    if (input.action === "delete_case") {
      if (!author) throw new PermissionError("An author or admin deletes test cases.");
      if (!value.cases.some(item => item.id === input.caseId)) throw new PipelineError(404, "This test case is not in this workspace.");
      // Runs keep the prompt they used, so history survives the case being deleted.
      value.cases = value.cases.filter(item => item.id !== input.caseId);
      save(value);
      return snapshot(workspace);
    }
    if (input.action === "review") {
      if (!roles.includes("approver") && !roles.includes("admin")) throw new PermissionError("An approver or admin records a quality review.");
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "This test run is not in this workspace.");
      if (run.status === "running") throw new PipelineError(409, "Wait for the test to finish before reviewing it.");
      if (run.review) throw new PipelineError(409, `${run.review.by} already reviewed this run. Run the test again for a fresh review.`);
      run.review = { verdict: input.verdict, note: input.note, by: actor, at };
      save(value);
      return snapshot(workspace);
    }
    if (input.action === "cancel") {
      const run = value.runs.find(item => item.id === input.runId);
      if (!run) throw new PipelineError(404, "This test run is not in this workspace.");
      if (!roles.includes("admin") && (!author || run.startedBy !== actor)) throw new PermissionError("Only the test author or an admin can stop this test.");
      const current = active.get(workspace);
      if (run.status !== "running" || current?.runId !== run.id) throw new PipelineError(409, "This test is no longer running.");
      current.controller.abort("user");
      await current.done;
      return snapshot(workspace);
    }
    // run
    if (!author) throw new PermissionError("An author or admin runs tests.");
    const testCase = value.cases.find(item => item.id === input.caseId);
    if (!testCase) throw new PipelineError(404, "This test case is not in this workspace.");
    const pipeline = options.pipelines.snapshot(workspace);
    if (pipeline.version !== input.expectedVersion) throw new PipelineError(409, "The agent changed since this page loaded. Refresh, read the saved version, then run the test.");
    if (active.has(workspace)) throw new PipelineError(409, "A test is already running in this workspace. Wait for it to finish.");
    if (options.bots.snapshot(workspace).busy) throw new PipelineError(409, "A workflow agent is running. Wait for it to finish before testing.");
    const agent = agentOf(workspace, testCase.agentId);
    const { checkout } = await readiness(workspace, agent, testCase);
    const run = testRunSchema.parse({ id: randomUUID(), workspaceId: workspace, caseId: testCase.id, agentId: agent.id, agentHash: agentHash(agent), agentName: agent.name, model: agent.model,
      prompt: testCase.prompt, expected: testCase.expected, source: testCase.source, startedBy: actor, startedAt: at, status: "running", summary: "", error: "", toolCalls: [], sourceRead: false, calls: 0, tokenUsage: null, events: [] });
    value.runs = [...value.runs, run].slice(-MAX_RUNS);
    save(value);
    const controller = new AbortController();
    const done = Promise.resolve().then(() => work(value, run, agent, testCase, checkout, controller)).catch(() => undefined);
    active.set(workspace, { runId: run.id, controller, done });
    return snapshot(workspace);
  }

  return {
    snapshot, execute,
    settled: async (workspace) => { await active.get(workspace)?.done; },
    close: async () => {
      closed = true;
      for (const entry of active.values()) entry.controller.abort("shutdown");
      await Promise.all([...active.values()].map(entry => entry.done));
    },
  };
}

