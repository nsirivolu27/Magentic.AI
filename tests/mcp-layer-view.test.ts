import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { mcpLayerPage } from "../workbench/mcp-layer-view.js";
import { emptyInspector } from "../workbench/mcp-view.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function fixture(): WorkbenchSnapshot {
  return { workspaceId: "team", actor: "alex", roles: ["author"], canAuthor: true, workflow: DEFAULT_WORKFLOW,
    records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false } };
}

test("MCP page distinguishes configured endpoints from checked connections", () => {
  const snapshot = fixture();
  const inspector = emptyInspector();
  let page = mcpLayerPage(snapshot, inspector, "http://127.0.0.1:4319").body;
  assert.match(page, /Not tested/);
  assert.match(page, /Not configured/);
  assert.doesNotMatch(page, /http:\/\/127.0.0.1:4319\/api\/pipeline-mcp/);
  snapshot.pipelines = memoryPipelines().snapshot("team");
  inspector.protocolVersion = "2025-03-26";
  page = mcpLayerPage(snapshot, inspector, "http://127.0.0.1:4319").body;
  assert.match(page, /Connection checked/);
  assert.match(page, /http:\/\/127.0.0.1:4319\/api\/pipeline-mcp/);
  assert.match(page, /Can update tasks/);
  inspector.failed = true;
  assert.match(mcpLayerPage(snapshot, inspector, "http://127.0.0.1:4319").body, /Check failed/);
});

test("MCP definitions are escaped and have inspection rather than execution actions", () => {
  const snapshot = fixture();
  snapshot.mcp.agents.push({ name: "test-agent", title: "<img src=x>", description: "Read-only example", hash: "a".repeat(64), readTools: ["list_conversations"] });
  const body = mcpLayerPage(snapshot, emptyInspector(), "http://localhost:4319").body;
  assert.match(body, /&lt;img src=x&gt;/);
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /data-mcp-agent="test-agent"/);
  assert.match(body, /Does not execute agents/);
  assert.match(body, /No ontology data source is configured/);
});
