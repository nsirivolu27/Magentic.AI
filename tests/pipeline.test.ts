import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryPipelines, DEFAULT_PIPELINE, pipelineSchema, type PipelineRun } from "../workbench/pipeline.js";
import { pipelineView } from "../workbench/pipeline-view.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

function fixture(gated = false) {
  const engine = memoryPipelines();
  engine.execute("one", "admin", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: gated }, { ...DEFAULT_PIPELINE.stages[1], approval: false }] } }, 2);
  const input = { action: "start", requestId: randomUUID(), title: "Develop a prototype", brief: "Produce and validate an accessible prototype." };
  const run = engine.execute("one", "writer", ["author"], input, 2).runs[0]!;
  function current() { return engine.snapshot("one").runs[0]!; }
  function act(action: string, actor = "writer", note?: string) {
    return engine.execute("one", actor, actor === "writer" ? ["author"] : ["approver"], {
      action, runId: run.id, expectedRevision: current().revision, ...(note ? { note } : {}),
    }, 2);
  }
  return { engine, input, run, current, act };
}

test("pipeline schema rejects unknown keys and duplicate stage IDs", () => {
  assert.equal(pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, extra: true }).success, false);
  assert.equal(pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, stages: [DEFAULT_PIPELINE.stages[0], DEFAULT_PIPELINE.stages[0]] }).success, false);
  assert.equal(pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, stages: [] }).success, false);
  assert.equal(pipelineSchema.safeParse({ ...DEFAULT_PIPELINE, jira: { ...DEFAULT_PIPELINE.jira, apiKey: "secret" } }).success, false);
});

test("start retries reuse the run and Jira preview, but conflicting request IDs fail", () => {
  const { engine, input } = fixture();
  const again = engine.execute("one", "writer", ["author"], input, 2);
  assert.equal(again.runs.length, 1); assert.equal(again.runs[0]!.jira.length, 1);
  assert.throws(() => engine.execute("one", "writer", ["author"], { ...input, title: "Other work" }, 2), /request ID/);
  assert.equal(engine.snapshot("two").runs.length, 0);
});

test("configuration edits are admin-only, version checked, and do not alter a running snapshot", () => {
  const { engine, run } = fixture(true);
  const command = { action: "configure", expectedVersion: 2, config: { ...DEFAULT_PIPELINE, name: "Research workflow", stages: [{ ...DEFAULT_PIPELINE.stages[0], approval: false }] } };
  assert.throws(() => engine.execute("one", "writer", ["author"], command, 2), /admin/);
  engine.execute("one", "admin", ["admin"], command, 2);
  assert.throws(() => engine.execute("one", "admin", ["admin"], command, 2), /Configuration changed/);
  const current = engine.snapshot("one");
  assert.equal(current.config.name, "Research workflow");
  assert.deepEqual(current.runs[0]!.config, run.config);
  current.runs[0]!.config.stages[0]!.approval = false;
  assert.equal(engine.snapshot("one").runs[0]!.config.stages[0]!.approval, true);
});

test("handoffs require output and two distinct reviewers bound to immutable output", () => {
  const { act, current } = fixture(true);
  assert.throws(() => act("complete"), /Provide output/);
  act("complete", "writer", "Prototype tested against acceptance criteria.");
  assert.equal(current().stages[0]!.status, "awaiting_review");
  assert.equal(current().jira.length, 1);
  assert.throws(() => act("approve", "writer"), /reviewer/);
  act("approve", "reviewer");
  assert.equal(current().current, 0);
  assert.throws(() => act("approve", "reviewer"), /already approved/);
  act("approve", "second");
  assert.equal(current().current, 1); assert.equal(current().jira.length, 2);
  assert.equal(current().stages[0]!.outputHash.length, 64);
  assert.throws(() => act("approve", "second"), /not awaiting/);
});

test("admin run owners and output authors cannot self approve", () => {
  const { engine, run, current } = fixture(true);
  engine.execute("one", "admin", ["admin"], { action: "complete", runId: run.id, expectedRevision: current().revision, note: "Admin-authored evidence" }, 2);
  assert.throws(() => engine.execute("one", "admin", ["admin"], { action: "approve", runId: run.id, expectedRevision: current().revision }, 2), /cannot approve/);
  assert.throws(() => engine.execute("one", "writer", ["admin"], { action: "approve", runId: run.id, expectedRevision: current().revision }, 2), /cannot approve/);
});

test("stale mutations, cross-workspace runs, and other authors are refused", () => {
  const { engine, run, act } = fixture();
  act("complete", "writer", "Requirements accepted.");
  const command = { action: "complete", runId: run.id, expectedRevision: 1, note: "Duplicate" };
  assert.throws(() => engine.execute("one", "writer", ["author"], command, 2), /run changed/);
  assert.throws(() => engine.execute("two", "writer", ["admin"], command, 2), /not found/);
  assert.throws(() => engine.execute("one", "stranger", ["author"], { ...command, expectedRevision: 2 }, 2), /run owner/);
});

test("pause, block, retry, completion and cancellation enforce the state machine", () => {
  const { act, current } = fixture();
  act("pause"); assert.throws(() => act("complete", "writer", "Output"), /cannot be completed/);
  act("resume"); act("block", "writer", "Waiting on a dependency");
  assert.equal(current().status, "blocked");
  act("retry"); act("complete", "writer", "Intake accepted"); act("complete", "writer", "Plan delivered");
  assert.equal(current().status, "complete"); assert.equal(current().jira.length, 3);
  assert.throws(() => act("retry"), /closed/);
  const cancelled = fixture(); cancelled.act("cancel");
  assert.throws(() => cancelled.act("complete", "writer", "Output"), /closed/);
});

test("Jira preview mappings preserve existing keys and never claim delivery", () => {
  const engine = memoryPipelines();
  const command = { action: "start", requestId: randomUUID(), title: "A work item", brief: "Validate a design", issueKey: "ENG-12" };
  const run = engine.execute("one", "writer", ["author"], command, 1).runs[0]!;
  assert.equal(run.jira[0]!.action, "update_issue"); assert.equal(run.jira[0]!.issueKey, "ENG-12");
  assert.equal(run.jira[0]!.delivery, "preview");
  assert.throws(() => engine.execute("one", "writer", ["author"], { ...command, requestId: randomUUID(), issueKey: "OTHER-2" }, 1), /configured Jira project/);
});

test("rendered outputs are escaped and monitoring does not invent token usage", () => {
  const { engine, act } = fixture(); act("complete", "writer", '<img src=x onerror="alert(1)">');
  const html = pipelineView(engine.snapshot("one"), "writer", ["author"]);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
  assert.match(html, /Tokens and cost: not measured/); assert.match(html, /Nothing is sent to Jira/);
});

test("HTTP and standalone pipeline MCP share authorization and run state", async (t) => {
  const engine = memoryPipelines();
  const server = createWorkbenchServer({ assets: new Map(), pipelines: engine,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
      members: memoryMembers([{ workspaceId: "one", actor: "writer", roles: ["author"] }, { workspaceId: "two", actor: "outsider", roles: ["author"] }]) },
    authenticate: async req => {
      const actor = req.headers.authorization?.replace(/^Bearer /, "");
      return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer writer", "Content-Type": "application/json" };
  const command = { action: "start", requestId: randomUUID(), title: "Develop a new process", brief: "Document the process and validate the outcome." };
  assert.equal((await fetch(base + "/api/pipeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) })).status, 401);
  assert.equal((await fetch(base + "/api/pipeline", { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: JSON.stringify(command) })).status, 403);
  const started = await fetch(base + "/api/pipeline", { method: "POST", headers, body: JSON.stringify(command) });
  assert.equal(started.status, 200); const run = (await started.json()).runs[0] as PipelineRun;
  const client = new Client({ name: "pipeline-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/api/pipeline-mcp"), { requestInit: { headers } }) as unknown as Parameters<typeof client.connect>[0]);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 4);
  const complete = await client.callTool({ name: "update_pipeline_run", arguments: { action: "complete", runId: run.id, expectedRevision: 1, note: "Requirements documented." } });
  assert.notEqual(complete.isError, true);
  assert.equal(engine.snapshot("one").runs[0]!.current, 1);
  const replay = await client.callTool({ name: "update_pipeline_run", arguments: { action: "complete", runId: run.id, expectedRevision: 1, note: "Duplicate" } });
  assert.equal(replay.isError, true);
  const outsider = new Client({ name: "outsider-test", version: "1" });
  await outsider.connect(new StreamableHTTPClientTransport(new URL(base + "/api/pipeline-mcp"), { requestInit: { headers: { Authorization: "Bearer outsider" } } }) as unknown as Parameters<typeof outsider.connect>[0]);
  t.after(() => outsider.close());
  assert.equal((await outsider.callTool({ name: "get_pipeline_run", arguments: { runId: run.id } })).isError, true);
  assert.equal((await client.callTool({ name: "get_pipeline", arguments: { workspaceId: "two" } })).isError, true);
});
