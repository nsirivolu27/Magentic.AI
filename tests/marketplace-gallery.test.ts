import assert from "node:assert/strict";
import test from "node:test";
import { workforceMarketplacePage } from "../workbench/workforce-marketplace-view.js";
import { workforceTemplates, installWorkforceAgents } from "../workbench/workforce-marketplace.js";
import { memoryPipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function snapshot(): WorkbenchSnapshot {
  return { workspaceId: "company", actor: "reader", roles: ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, pipelines: memoryPipelines().snapshot("company"), records: [], audit: [],
    demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: false } };
}

test("gallery search combines category and workspace filters without losing saved copies", () => {
  const state = snapshot();
  const knowledge = workforceTemplates.find(item => item.slug === "knowledge")!;
  state.pipelines!.config = installWorkforceAgents(DEFAULT_PIPELINE, ["knowledge"]);
  const page = workforceMarketplacePage(state, "Company", undefined, knowledge.group, "INTERNAL KNOWLEDGE", true);
  assert.match(page.body, /1 design</);
  assert.match(page.body, /In workspace/);
  assert.match(page.body, new RegExp(`href="#/agent-studio/${knowledge.definition.id}"`));
  assert.doesNotMatch(page.body, /Preview Implementation agent/);
  assert.match(page.body, /name="library" value="1"/);
  const excluded = workforceMarketplacePage(state, "Company", undefined, "cyber", "knowledge", true);
  assert.match(excluded.body, /No matching designs/);
});

test("gallery escapes query and workspace labels and offers recovery for an empty collection", () => {
  const state = snapshot();
  assert.match(workforceMarketplacePage(state, "Company", undefined, undefined, "", true).body, /Your collection starts here/);
  const page = workforceMarketplacePage(state, '<script>company</script>', undefined, undefined, '\"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(page.body, /<script>|<img/);
  assert.match(page.body, /&lt;img/);
  assert.match(page.body, /href="#\/marketplace">Explore all designs/);
});

test("template preview exposes actual inputs and review path without claiming execution", () => {
  const page = workforceMarketplacePage(snapshot(), "Company", "knowledge");
  assert.match(page.body, /WORKFLOW DESIGN/);
  assert.match(page.body, /Human review/);
  assert.match(page.body, /Checks not run/);
  assert.match(page.body, /Suggested sequence/);
  assert.match(page.body, /disabled>Add to workspace/);
  assert.match(page.body, /External connectors are not connected/);
  assert.match(page.body, /aria-current="page"/);
});
