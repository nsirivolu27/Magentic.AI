import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BOT_PROFILES, developmentAgentConfig } from "../workbench/bot-profiles.js";
import { BOT_PROFILE_IDS, BOT_PROFILE_KINDS, attemptSchema, botPolicySchema, type BotHandoff, type BotProfile } from "../workbench/bot-schema.js";
import { runBotWorker } from "../workbench/bot-worker.js";
import { createBotRuntime, type BotRuntime } from "../workbench/bot-runtime.js";
import { registerBotInspection } from "../workbench/bot-mcp.js";
import { botTimeline } from "../workbench/bot-view.js";
import { DEFAULT_PIPELINE, memoryPipelines, pipelineSchema } from "../workbench/pipeline.js";
import type { AgentModel } from "../workbench/chat.js";

function handoff(profile: BotProfile, blockers: string[] = []): BotHandoff {
  return { sections: BOT_PROFILES[profile].sections.map(title => ({ title, body: `Evidence for ${title}.` })), blockers };
}
function workerFixture(profile: BotProfile) {
  const engine = memoryPipelines();
  const bot = { profile, kind: BOT_PROFILE_KINDS[profile], maxSteps: 2, timeoutSeconds: 15, allowedTools: [], maxToolCalls: 0 };
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0]!, bot }] } }, 1);
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Build a feature", brief: "Respect the acceptance criteria." }, 1).runs[0]!;
  const attempt = attemptSchema.parse({ id: randomUUID(), requestId: randomUUID(), runId: run.id, stageId: "intake", revision: 1,
    actor: "owner", bot, model: "fixture-model", checkout: "/unused", baseCommit: "fixture", startedAt: new Date().toISOString(),
    status: "running", summary: "", error: "", calls: 0, tokenUsage: null, cost: null, events: [], changes: [], proposalHash: "", checks: [], checkedTree: "" });
  return { engine, run, attempt };
}

test("agent setup preserves gates, models, limits, Jira mappings and custom phases", () => {
  const config = structuredClone(DEFAULT_PIPELINE);
  config.stages[0]!.bot = { kind: "manual", maxSteps: 2, timeoutSeconds: 30, allowedTools: [], maxToolCalls: 0 };
  config.stages.push({ ...config.stages[0]!, id: "custom-phase", agent: "Custom responsibility" });
  const before = structuredClone(config);
  const updated = pipelineSchema.parse(developmentAgentConfig(config));
  assert.deepEqual(config, before);
  assert.deepEqual(updated.stages.map(stage => stage.bot?.profile), [...BOT_PROFILE_IDS, undefined]);
  assert.deepEqual(updated.stages.at(-1), before.stages.at(-1));
  assert.deepEqual(updated.jira, before.jira);
  updated.stages.forEach((stage, i) => {
    const { bot: _, ...rest } = stage;
    const { bot: __, ...original } = before.stages[i]!;
    assert.deepEqual(rest, original);
  });
  assert.equal(updated.stages[0]!.bot!.maxSteps, 2);
  assert.deepEqual(updated.stages[0]!.bot!.allowedTools, []);
  assert.equal(updated.stages[0]!.bot!.maxToolCalls, 0);
  assert.ok(DEFAULT_PIPELINE.stages.every(stage => !stage.bot));
});

test("profiles reject incompatible execution kinds and unknown configuration", () => {
  const base = { kind: "planner", maxSteps: 2, timeoutSeconds: 15 };
  assert.deepEqual(botPolicySchema.parse(base), base);
  for (const extra of [{ profile: "implementation" }, { profile: "invented" }, { autoApprove: true }]) {
    assert.equal(botPolicySchema.safeParse({ ...base, ...extra }).success, false);
  }
  const mismatch = botPolicySchema.safeParse({ ...base, profile: "implementation" });
  assert.equal(mismatch.success, false);
  if (!mismatch.success) assert.equal(mismatch.error.issues[0]!.path.join("."), "profile");
});

for (const profile of BOT_PROFILE_IDS) {
  test(`${profile} agent requests and returns its specialized handoff without advancing`, async () => {
    const f = workerFixture(profile);
    const result = await runBotWorker(f.attempt, f.run, { async invoke(prompt) {
      assert.ok(prompt.includes(BOT_PROFILES[profile].instructions));
      assert.ok(prompt.includes(JSON.stringify(BOT_PROFILES[profile].sections)));
      assert.match(prompt, /Your output is not independent human approval/);
      return { content: JSON.stringify({ type: "result", summary: "Phase report", changes: [], handoff: handoff(profile) }) };
    } }, new AbortController().signal, () => {});
    assert.deepEqual(result.handoff, handoff(profile));
    assert.equal(f.engine.snapshot("one").runs[0]!.revision, 1);
  });
}

test("profiled workers refuse missing or incorrect sections and read-only file proposals", async () => {
  const f = workerFixture("review");
  const valid = handoff("review");
  for (const extra of [{}, { handoff: { ...valid, sections: valid.sections.map(section => ({ ...section, title: "Invented" })) } },
    { handoff: { ...valid, authority: "approve" } }, { handoff: valid, summary: "x".repeat(601) },
    { handoff: valid, changes: [{ path: "source.ts", content: "unauthorized" }] }]) {
    await assert.rejects(runBotWorker(f.attempt, f.run, { async invoke() {
      return { content: JSON.stringify({ type: "result", summary: "Report", changes: [], ...extra }) };
    } }, new AbortController().signal, () => {}));
  }
});

async function settled(runtime: BotRuntime) {
  const deadline = Date.now() + 20_000;
  while (runtime.busy("one") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.busy("one"), false);
  return runtime.snapshot("one").attempts.at(-1)!;
}

function runtimeFixture(model: AgentModel) {
  const directory = mkdtempSync(join(tmpdir(), "magentic-profiles-"));
  const repo = join(directory, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo], { windowsHide: true });
  writeFileSync(join(repo, "answer.txt"), "before");
  execFileSync("git", ["add", "answer.txt"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo, windowsHide: true });
  const engine = memoryPipelines();
  const config = developmentAgentConfig(DEFAULT_PIPELINE);
  for (const stage of config.stages) { stage.model = "fixture"; stage.bot!.maxSteps = 3; stage.bot!.timeoutSeconds = 15; }
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: randomUUID(), title: "Implement answer", brief: "Replace before with after." }, 2).runs[0]!;
  const chat = { provider: "fixture", model: "fixture", loadModel: async () => model };
  const data = join(directory, "data");
  const runtime = createBotRuntime(data, engine, chat);
  const act = (command: unknown) => runtime.execute("one", "owner", ["admin"], command, 2);
  return { directory, repo, engine, run, runtime, data, chat, act,
    async attach() { await act({ action: "attach", project: { root: repo, checks: [{ executable: "node", args: ["-e", "if(require('fs').readFileSync('answer.txt','utf8')!=='after')process.exit(1)"] }] } }); },
    async start() { await act({ action: "start", runId: run.id, expectedRevision: engine.snapshot("one").runs[0]!.revision, requestId: randomUUID() }); return settled(runtime); },
    async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("seven agents carry evidence through implementation, checks and independent approval gates", { timeout: 60_000 }, async () => {
  const prompts: string[] = [];
  let read = false;
  const f = runtimeFixture({ async invoke(prompt) {
    prompts.push(prompt);
    const profile = BOT_PROFILE_IDS.find(id => prompt.includes(`AGENT PROFILE: ${BOT_PROFILES[id].name}.`))!;
    assert.ok(profile);
    if (profile === "implementation" && !read) {
      read = true;
      return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: "answer.txt" } }) };
    }
    return { content: JSON.stringify({ type: "result", summary: `Report from ${profile}`, handoff: handoff(profile),
      changes: profile === "implementation" ? [{ path: "answer.txt", content: "after" }] : [] }) };
  } });
  try {
    await f.attach();
    for (const profile of BOT_PROFILE_IDS) {
      const attempt = await f.start();
      assert.equal(attempt.status, "ready", attempt.error);
      assert.equal(attempt.bot.profile, profile);
      const command = { attemptId: attempt.id, expectedHash: attempt.proposalHash };
      await assert.rejects(f.act({ ...command, action: "accept", expectedHash: "stale" }), /result changed/);
      if (profile === "implementation") await f.act({ ...command, action: "apply" });
      if (profile === "implementation" || profile === "validation") {
        await assert.rejects(f.act({ ...command, action: "accept" }), /check must pass/);
        await f.act({ ...command, action: "checks" });
      }
      await f.act({ ...command, action: "accept" });
      let run = f.engine.snapshot("one").runs[0]!;
      const completed = run.stages.find(stage => stage.output.includes(`Bot attempt: ${attempt.id}`))!;
      assert.ok(completed.output.includes(BOT_PROFILES[profile].sections[0]!));
      if (run.stages[run.current]!.status === "awaiting_review") {
        assert.throws(() => f.engine.execute("one", "owner", ["admin"], { action: "approve", runId: run.id, expectedRevision: run.revision }, 2), /cannot approve/);
        for (const reviewer of ["reviewer-a", "reviewer-b"]) {
          run = f.engine.execute("one", reviewer, ["approver"], { action: "approve", runId: run.id, expectedRevision: run.revision }, 2).runs[0]!;
        }
      }
    }
    assert.equal(f.engine.snapshot("one").runs[0]!.status, "complete");
    assert.equal(readFileSync(join(f.repo, "answer.txt"), "utf8"), "before");
    const validation = prompts.find(prompt => prompt.includes("AGENT PROFILE: Validation agent."))!;
    assert.match(validation, /CURRENT CHECK EVIDENCE:.*"exitCode":0/);
    assert.match(validation, /Report from implementation/);
    assert.ok(f.runtime.snapshot("one").attempts.every(attempt => attempt.status === "accepted"));
    await f.runtime.close();
    const reopened = createBotRuntime(f.data, f.engine, f.chat);
    try { assert.deepEqual(reopened.snapshot("one").attempts[0]!.handoff, handoff("requirements")); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("blockers persist, render safely and prevent bot handoff", async () => {
  const f = runtimeFixture({ async invoke() {
    return { content: JSON.stringify({ type: "result", summary: "Need requirements", changes: [],
      handoff: handoff("requirements", ["Choose the target <script>platform</script>"]) }) };
  } });
  try {
    await f.attach(); const attempt = await f.start();
    assert.equal(attempt.status, "ready", attempt.error);
    await assert.rejects(f.act({ action: "accept", attemptId: attempt.id, expectedHash: attempt.proposalHash }), /blockers/);
    assert.equal(f.engine.snapshot("one").runs[0]!.revision, 1);
    const html = botTimeline(f.runtime.snapshot("one"), f.engine.snapshot("one").runs[0]!);
    assert.match(html, /Handoff blocked/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
    assert.match(html, /disabled data-bot-action="accept"/);
    await f.runtime.close();
    const reopened = createBotRuntime(f.data, f.engine, f.chat);
    try { assert.equal(reopened.snapshot("one").attempts[0]!.handoff!.blockers.length, 1); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("current-check context excludes evidence after a checkout change", async () => {
  const prompts: string[] = [];
  const f = runtimeFixture({ async invoke(prompt) {
    prompts.push(prompt);
    return { content: JSON.stringify({ type: "result", summary: "Requirements", changes: [], handoff: handoff("requirements") }) };
  } });
  try {
    await f.attach(); const attempt = await f.start();
    await f.act({ action: "checks", attemptId: attempt.id, expectedHash: attempt.proposalHash });
    await f.start();
    assert.match(prompts.at(-1)!, /CURRENT CHECK EVIDENCE:.*"exitCode":1/);
    writeFileSync(join(attempt.checkout, "answer.txt"), "after");
    await f.start();
    assert.match(prompts.at(-1)!, /CURRENT CHECK EVIDENCE: \[\]/);
  } finally { await f.close(); }
});

test("standalone MCP exposes profile contracts without adding execution tools", async () => {
  const f = runtimeFixture({ async invoke() { throw new Error("No model call expected"); } });
  const server = new McpServer({ name: "test", version: "1" });
  const client = new Client({ name: "test-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  registerBotInspection(server, f.engine, f.runtime, "one", 2);
  try {
    await server.connect(b as unknown as Parameters<typeof server.connect>[0]);
    await client.connect(a as unknown as Parameters<typeof client.connect>[0]);
    const response = await client.callTool({ name: "get_pipeline_capabilities", arguments: {} });
    const content = response.content as { type: string; text: string }[];
    const capabilities = JSON.parse(content[0]!.text);
    assert.deepEqual(capabilities.phases.map((phase: { profile: string }) => phase.profile), BOT_PROFILE_IDS);
    assert.deepEqual(capabilities.phases[0].expectedSections, BOT_PROFILES.requirements.sections);
    assert.equal(capabilities.execution.directMcpBotExecution, false);
    assert.equal((await client.callTool({ name: "start_bot", arguments: {} })).isError, true);
  } finally { await client.close(); await server.close(); await f.close(); }
});

test("format correction consumes the existing model budget and cannot execute a rejected proposal", async () => {
  const f = workerFixture("implementation");
  let calls = 0;
  const events: string[] = [];
  const result = await runBotWorker(f.attempt, f.run, { async invoke(prompt) {
    calls++;
    if (calls === 1) return { content: JSON.stringify({ type: "result", summary: "Missing handoff", changes: [{ path: "unread.ts", content: "bad proposal" }] }) };
    assert.match(prompt, /Your previous response was rejected/);
    assert.ok(prompt.includes(JSON.stringify({ type: "result", summary: "Concise findings and evidence", changes: [],
      handoff: { sections: BOT_PROFILES.implementation.sections.map(title => ({ title, body: "Observed evidence or an explicit unknown." })), blockers: [] } })));
    return { content: JSON.stringify({ type: "result", summary: "Corrected report", changes: [], handoff: handoff("implementation") }) };
  } }, new AbortController().signal, event => events.push(event));
  assert.equal(calls, 2);
  assert.equal(f.attempt.calls, 2);
  assert.deepEqual(result.changes, []);
  assert.ok(events.some(event => event.startsWith("Invalid response format")));
  assert.equal(events.filter(event => event.startsWith("MCP tool:")).length, 0);
  assert.equal(f.engine.snapshot("one").runs[0]!.revision, 1);
});
