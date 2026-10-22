import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable, AGENT_STARTERS } from "../workbench/agent-configurables.js";
import { agentStudioPage, agentTestHistory, nextAction } from "../workbench/agent-studio-view.js";
import { agentHash, testRunSchema, type AgentTestsSnapshot } from "../workbench/agent-tests-model.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { emptyStudioUi } from "../workbench/studio-view.js";

/** The Agent Studio pages as an analyst and a reviewer see them, with tests in every state. */

const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Docs helper", purpose: "Answer from the SOP.", model: "test-model", instructions: "Read SOP.md and cite it.",
  bot: { kind: "planner", maxSteps: 4, timeoutSeconds: 60, allowedTools: ["read_project_file"], maxToolCalls: 2, requireSourceRead: true } });
const models = [{ id: agent.model, label: "Test model", provider: "Test", available: true, local: true, detail: "Fixture" }];

function fixture(roles: ("author" | "approver" | "admin")[] = ["admin", "author"], assigned = false) {
  const engine = memoryPipelines();
  let config = saveConfigurable(DEFAULT_PIPELINE, agent);
  if (assigned) config = applyConfigurable(config, agent.id, DEFAULT_PIPELINE.stages[0]!.id);
  const pipelines = engine.execute("one", "operator", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const snapshot: WorkbenchSnapshot = { workspaceId: "one", actor: "operator", roles, canAuthor: roles.includes("author") || roles.includes("admin"), demo: true,
    workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: true }, pipelines,
    bots: { project: { root: "/repo", checks: [] }, attempts: [], busy: false } };
  return { snapshot, pipelines };
}
function run(overrides: Partial<ReturnType<typeof testRunSchema.parse>> = {}) {
  return testRunSchema.parse({ id: randomUUID(), workspaceId: "one", caseId: randomUUID(), agentId: agent.id, agentHash: agentHash(agent), agentName: agent.name, model: agent.model,
    prompt: "Explain the access process.", expected: "Cites SOP.md.", source: "SOP.md", startedBy: "operator", startedAt: "2026-10-12T10:00:00.000Z", finishedAt: "2026-10-12T10:00:04.000Z",
    status: "succeeded", summary: "The team owner approves. <b>bold</b>", error: "", toolCalls: [{ name: "read_project_file", path: "SOP.md", outcome: "read" }], sourceRead: true, calls: 2, tokenUsage: { promptTokens: 120, completionTokens: 40 }, events: ["MCP tool: read_project_file", "Source read: SOP.md (90 characters)"], ...overrides });
}
const tests = (...runs: ReturnType<typeof run>[]): AgentTestsSnapshot => ({ cases: [{ id: runs[0]?.caseId ?? randomUUID(), workspaceId: "one", agentId: agent.id, title: "Access process", prompt: "Explain the access process.", expected: "Cites SOP.md.", source: "SOP.md", createdBy: "operator", createdAt: "2026-10-12T09:00:00.000Z", updatedAt: "2026-10-12T09:00:00.000Z" }], runs, busy: false });

test("the overview lists configuration status, latest test outcome and workflow assignment per agent, and offers four working templates", () => {
  const { snapshot } = fixture(["admin", "author"], true);
  const html = agentStudioPage(snapshot, undefined, null, models, emptyStudioUi(), "setup", tests(run())).body;
  assert.match(html, /Ready to run/);
  assert.match(html, /Execution finished/);
  assert.match(html, /Review pending/);
  assert.match(html, new RegExp(`href="#/workflows/${DEFAULT_PIPELINE.stages[0]!.id}"`));
  assert.match(html, /Review result/);
  for (const starter of AGENT_STARTERS) assert.ok(html.includes(starter.name), starter.name);
  assert.equal(AGENT_STARTERS.length, 4);
  assert.match(html, /Needs a validation command/);
  assert.match(html, /Import an agent \(advanced\)/);
  const untested = agentStudioPage(snapshot, undefined, null, [], emptyStudioUi(), "setup", undefined).body;
  assert.match(untested, /Not tested/);
  assert.match(untested, /Needs model connected/);
});

test("the next action follows the saved state: model, test, review, assign, run", () => {
  const { snapshot } = fixture();
  assert.equal(nextAction(snapshot, agent, [], undefined).label, "Choose a connected model");
  assert.equal(nextAction(snapshot, agent, models, undefined).label, "Run test");
  assert.equal(nextAction(snapshot, agent, models, tests(run({ status: "running" }))).label, "Wait for the test");
  assert.equal(nextAction(snapshot, agent, models, tests(run({ status: "failed", summary: "", error: "Required source read missing." }))).label, "Fix and run test again");
  assert.equal(nextAction(snapshot, agent, models, tests(run())).label, "Review result");
  const reviewed = run({ review: { verdict: "pass", note: "", by: "reviewer", at: "2026-10-12T10:05:00.000Z" } });
  assert.equal(nextAction(snapshot, agent, models, tests(reviewed)).label, "Assign to workflow");
  assert.equal(nextAction(fixture(["admin"], true).snapshot, agent, models, tests(reviewed)).label, "Run in a workflow");
  assert.equal(nextAction(snapshot, agent, models, tests(run({ agentHash: "000000000000" }))).label, "Run test again");
});

test("the test page shows evidence, usage and elapsed time from the run, keeps execution and review apart, and escapes the answer", () => {
  const { snapshot } = fixture();
  const page = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run()));
  assert.equal(page.title, agent.name);
  const html = page.body;
  assert.match(html, /aria-current="page">Test</);
  assert.match(html, /Read SOP\.md/);
  assert.match(html, /read_project_file<\/code> SOP\.md · read, content returned/);
  assert.match(html, /120 input · 40 output \(reported by the provider\)/);
  assert.match(html, /<dt>Elapsed<\/dt><dd>4 s<\/dd>/);
  assert.match(html, /id="agent-test-review"/);
  assert.match(html, /separate from the execution finishing/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /id="agent-test-case"/);
  assert.match(html, /data-form="agent-test-run"/);
  assert.doesNotMatch(html, /accurate|confidence|score|cost/i);
});

test("a changed agent marks earlier runs out of date, a failed run explains itself, and a recorded review is shown once", () => {
  const { snapshot } = fixture();
  const stale = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run({ agentHash: "000000000000" }))).body;
  assert.match(stale, /Out of date/);
  assert.match(stale, /tested version v000000000000/);
  const failed = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run({ status: "failed", summary: "", sourceRead: false, toolCalls: [], error: "Required source read missing. No result was accepted; revise the task or choose another model." }))).body;
  assert.match(failed, /Execution failed/);
  assert.match(failed, /Required source read missing/);
  assert.match(failed, /SOP\.md was not read/);
  assert.doesNotMatch(failed, /id="agent-test-review"/, "a failed execution is not offered for a quality review");
  const reviewed = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run({ review: { verdict: "fail", note: "Missed the approval precondition.", by: "reviewer", at: "2026-10-12T10:05:00.000Z" } }))).body;
  assert.match(reviewed, /Review: fail/);
  assert.match(reviewed, /Missed the approval precondition/);
  assert.doesNotMatch(reviewed, /id="agent-test-review"/);
  const tokenless = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run({ tokenUsage: null }))).body;
  assert.match(tokenless, /Not reported by this model/);
});

test("a reviewer without author rights can read results and record a review but not write or run tests", () => {
  const { snapshot } = fixture(["approver"]);
  const html = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi(), "test", tests(run())).body;
  assert.match(html, /<fieldset disabled>/);
  assert.match(html, /<button class="primary small" disabled>Run test/);
  assert.doesNotMatch(html, /data-test-delete/);
  assert.match(html, /id="agent-test-review"/);
  const viewer = agentStudioPage({ ...snapshot, roles: ["author"], canAuthor: true }, agent.id, null, models, emptyStudioUi(), "test", tests(run())).body;
  assert.match(viewer, /An approver or admin records the quality review/);
});

test("the workflow page explains input, output, tools, review and next step for each assigned stage, and never offers a publish button", () => {
  const assigned = fixture(["admin", "author"], true);
  const html = agentStudioPage(assigned.snapshot, agent.id, null, models, emptyStudioUi(), "workflow").body;
  const stage = DEFAULT_PIPELINE.stages[0]!;
  assert.match(html, new RegExp(`<h3>${stage.name}`));
  assert.match(html, /<dt>Input<\/dt>/);
  assert.match(html, /<dt>Output<\/dt>/);
  assert.match(html, /Read file contents · source read required/);
  assert.match(html, new RegExp(`<dt>Next<\\/dt><dd>${DEFAULT_PIPELINE.stages[1]!.name}`));
  assert.match(html, /Changes affect future runs only/);
  assert.match(html, /workflow handoff approval, not a model release approval|No review gate/);
  assert.doesNotMatch(html, /Publish/);
  assert.match(html, /id="agent-studio-assign"/);
  const unassigned = agentStudioPage(fixture().snapshot, agent.id, null, models, emptyStudioUi(), "workflow").body;
  assert.match(unassigned, /Not assigned to any stage yet/);
});

test("the setup page separates instructions, knowledge, tools, limits and review, names automatic routing as unavailable, and seeds the template example", () => {
  const { snapshot } = fixture();
  const html = agentStudioPage(snapshot, agent.id, null, models, emptyStudioUi()).body;
  for (const heading of ["<legend>Instructions</legend>", "<legend>Knowledge</legend>", "<legend>Tools</legend>", "Execution limits", "<legend>Review</legend>"]) assert.ok(html.includes(heading), heading);
  assert.match(html, /Automatic model routing is not available on this execution path/);
  assert.match(html, /<code>\/repo<\/code>/);
  assert.match(html, /2 independent approvals/);
  assert.match(html, /aria-current="page">Knowledge &amp; tools</);
  const fresh = agentStudioPage(snapshot, "new", "docs", models, emptyStudioUi()).body;
  assert.match(fresh, /name="examplePrompt"/);
  assert.match(fresh, /name="exampleSource" value="SOP\.md"/);
  assert.doesNotMatch(fresh, /agent-studio-head/);
  const history = agentTestHistory(agent, tests(run(), run({ agentHash: "000000000000" })));
  assert.deepEqual(history.runs.map(entry => entry.stale), [true, false]);
});
