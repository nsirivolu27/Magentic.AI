import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_PIPELINE, memoryPipelines, pipelineSchema, type PipelineConfig } from "../workbench/pipeline.js";
import { readPipelineForm } from "../workbench/pipeline-form.js";
import { selectedWorkId } from "../workbench/work-selection.js";
import { pipelineView } from "../workbench/pipeline-view.js";
import { developmentAgentConfig } from "../workbench/bot-profiles.js";
import { agentConfigurableSchema, applyConfigurable, saveConfigurable } from "../workbench/agent-configurables.js";
import { withCloudModels } from "../workbench/model-catalog.js";
import { mcpRequest } from "../workbench/mcp-view.js";

function configured() {
  const agent = agentConfigurableSchema.parse({ id: randomUUID(), name: "Review helper", purpose: "Inspect changes.",
    model: "local-test", instructions: "Read the supplied diff and identify defects.",
    bot: { kind: "reviewer", maxSteps: 3, timeoutSeconds: 60, allowedTools: ["project_diff"], maxToolCalls: 1 } });
  return applyConfigurable(saveConfigurable(DEFAULT_PIPELINE, agent), agent.id, "planning");
}

function formFor(config: PipelineConfig) {
  const data = new FormData();
  data.set("pipelineName", config.name); data.set("description", config.description);
  data.set("project", config.jira.project); data.set("issueType", config.jira.issueType);
  if (config.jira.enabled) data.set("jiraEnabled", "on");
  config.stages.forEach((stage, index) => {
    for (const field of ["name", "agent", "model", "instructions", "context"] as const) data.set(`${field}-${index}`, stage[field]);
    data.set(`status-${index}`, stage.jiraStatus);
    if (stage.approval) data.set(`approval-${index}`, "on");
    data.set(`bot-${index}`, stage.bot?.kind ?? "manual");
    data.set(`steps-${index}`, String(stage.bot?.maxSteps ?? 6));
    data.set(`timeout-${index}`, String(stage.bot?.timeoutSeconds ?? 120));
    data.set(`toolcalls-${index}`, String(stage.bot?.maxToolCalls ?? 0));
    for (const tool of stage.bot?.allowedTools ?? []) data.set(`tool-${index}-${tool}`, "on");
  });
  return data;
}

test("advanced setup preserves the saved agent library and approved-assistant bindings", () => {
  const config = configured();
  config.stages[0]!.assistantId = randomUUID();
  const before = structuredClone(config);
  const form = formFor(config); form.set("description", "Updated workflow description.");
  const next = pipelineSchema.parse(readPipelineForm(config, form, true));
  assert.deepEqual(next.configurables, before.configurables);
  assert.equal(next.stages[0]!.assistantId, before.stages[0]!.assistantId);
  assert.deepEqual(next.stages[1]!.bot, before.stages[1]!.bot);
  assert.equal(next.description, "Updated workflow description.");
  assert.deepEqual(config, before);
});

test("enabling phase starters preserves custom agents, approved assistants and running policy snapshots", () => {
  const config = configured();
  const before = structuredClone(config);
  const next = developmentAgentConfig(config);
  assert.deepEqual(next.stages[1], before.stages[1]);
  assert.equal(next.stages[0]!.bot?.profile, "requirements");
  const approved = structuredClone(config); approved.stages[0]!.assistantId = randomUUID();
  assert.deepEqual(developmentAgentConfig(approved).stages[0], approved.stages[0]);
  const engine = memoryPipelines();
  engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: 1, config }, 2);
  const started = engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Existing work", brief: "Keep the original policy." }, 2);
  const after = engine.execute("one", "owner", ["admin"], { action: "configure", expectedVersion: started.version, config: next }, 2);
  assert.deepEqual(after.runs, started.runs);
});

test("work selection follows the address and never substitutes a missing or foreign item", () => {
  const runs = [{ id: "one" }, { id: "two" }];
  assert.equal(selectedWorkId("desk", "two", runs), "two");
  assert.equal(selectedWorkId("desk", "new", runs), undefined);
  assert.equal(selectedWorkId("desk", undefined, runs), undefined);
  assert.equal(selectedWorkId("pipelines", undefined, runs), "one");
  assert.equal(selectedWorkId("pipelines", "missing", runs), "missing");
  const engine = memoryPipelines();
  const snapshot = engine.execute("one", "owner", ["author"], { action: "start", requestId: randomUUID(), title: "Existing work", brief: "Do not target this by accident." }, 2);
  const html = pipelineView(snapshot, "owner", ["author"], randomUUID());
  assert.doesNotMatch(html, /data-pipeline-action=/);
  assert.doesNotMatch(html, /id="pipeline-output"/);
});

test("unknown model IDs cannot silently fall back to the configured model", async () => {
  let loads = 0;
  const config = withCloudModels({ provider: "ollama", model: "installed", listModels: async () => ["installed"],
    loadModel: async () => { loads++; return { invoke: async () => ({ content: "unused" }) }; } }, {});
  await assert.rejects(config.loadModel("missing"), /no longer available/);
  await assert.rejects(config.loadModel("openai/not-configured"), /not available/);
  await assert.rejects(config.loadModel("anthropic/claude-sonnet-5"), /ANTHROPIC_API_KEY/);
  assert.equal(loads, 0);
  await config.loadModel("installed"); assert.equal(loads, 1);
});

test("provider discovery failure blocks execution without leaking its error", async () => {
  const config = withCloudModels({ provider: "ollama", model: "installed", listModels: async () => { throw new Error("private credential value"); },
    loadModel: async () => { throw new Error("must not load"); } }, {});
  await assert.rejects(config.loadModel("installed"), error => {
    assert.match(String(error), /service is unavailable/);
    assert.doesNotMatch(String(error), /private credential|must not load/); return true;
  });
});

test("MCP accepts only the matching response and carries the selected workspace", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("X-Magentic-Workspace"), "one");
    const request = JSON.parse(String(init.body));
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
  });
  assert.deepEqual(await mcpRequest("", "tools/list", {}, "2025-03-26", { "X-Magentic-Workspace": "one" }), { tools: [] });
});

test("MCP rejects mismatched IDs, malformed results and unexpected acknowledgements", async t => {
  let reply: (id: number) => Response = id => Response.json({ jsonrpc: "2.0", id: id + 1, result: {} });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => reply(JSON.parse(String(init.body)).id));
  await assert.rejects(mcpRequest("", "tools/list", {}), /did not match/);
  reply = id => Response.json({ jsonrpc: "2.0", id, result: null });
  await assert.rejects(mcpRequest("", "tools/list", {}), /did not match/);
  reply = () => new Response(null, { status: 202 });
  await assert.rejects(mcpRequest("", "tools/list", {}), /did not return a result/);
  assert.deepEqual(await mcpRequest("", "notifications/initialized", {}), {});
  reply = () => new Response("private invalid response");
  await assert.rejects(mcpRequest("", "tools/list", {}), /invalid response/);
});
