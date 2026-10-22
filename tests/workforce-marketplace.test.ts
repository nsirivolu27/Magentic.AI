import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { installWorkforceAgents, workforceTemplates } from "../workbench/workforce-marketplace.js";
import { workforceMarketplacePage } from "../workbench/workforce-marketplace-view.js";
import { applyConfigurable } from "../workbench/agent-configurables.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const slugs = workforceTemplates.map(item => item.slug);
test("a company pack installs as isolated drafts without replacing automation stages", () => {
  const original = structuredClone(DEFAULT_PIPELINE);
  const config = installWorkforceAgents(original, slugs);
  assert.equal(config.configurables?.length, 26);
  assert.deepEqual(config.stages, original.stages);
  assert.equal(original.configurables, undefined);
  for (const agent of config.configurables!) {
    assert.equal(agent.model, "select-connected-model");
    assert.equal(agent.bot.requireSourceRead, true);
    assert.ok(agent.bot.allowedTools?.includes("read_project_file"));
  }
  config.configurables![0]!.instructions = "Company-specific instructions";
  assert.notEqual(workforceTemplates[0]!.definition.instructions, "Company-specific instructions");
  assert.deepEqual(installWorkforceAgents(config, slugs), config);
});

test("invalid or overflowing packs make no partial changes", () => {
  const original = structuredClone(DEFAULT_PIPELINE);
  assert.throws(() => installWorkforceAgents(original, [slugs[0]!, "unknown"]), /existing/);
  assert.throws(() => installWorkforceAgents(original, [slugs[0]!, slugs[0]!]), /distinct/);
  const full = { ...original, configurables: Array.from({ length: 5 }, () => ({ ...workforceTemplates[0]!.definition, id: randomUUID() })) };
  assert.throws(() => installWorkforceAgents(full, slugs), /30 agents/);
  assert.equal(full.configurables.length, 5);
  assert.equal(original.configurables, undefined);
});

test("company installs use existing admin, stale-version and workspace boundaries", () => {
  const engine = memoryPipelines();
  const config = installWorkforceAgents(DEFAULT_PIPELINE, slugs);
  const command = { action: "configure", expectedVersion: 1, config };
  assert.throws(() => engine.execute("company-a", "writer", ["author"], command, 2), /admin/i);
  const saved = engine.execute("company-a", "admin", ["admin"], command, 2);
  assert.equal(saved.config.configurables?.length, 26);
  assert.equal(engine.snapshot("company-b").config.configurables, undefined);
  assert.throws(() => engine.execute("company-a", "admin", ["admin"], command, 2), /changed/);
  assert.throws(() => engine.execute("company-b", "admin", ["admin"], { ...command, workspaceId: "company-a" }, 2));
});

test("assignment uses the workspace copy and keeps prior runs and review gates", () => {
  const engine = memoryPipelines();
  const installed = installWorkforceAgents(DEFAULT_PIPELINE, slugs);
  installed.configurables![0]!.model = "company-model";
  engine.execute("company-a", "admin", ["admin"], { action: "configure", expectedVersion: 1, config: installed }, 2);
  const run = engine.execute("company-a", "author", ["author"], { action: "start", requestId: randomUUID(), title: "Inspect policy", brief: "Read the authorized policy." }, 2).runs[0]!;
  const before = structuredClone(run);
  const config = applyConfigurable(installed, installed.configurables![0]!.id, installed.stages[0]!.id);
  const after = engine.execute("company-a", "admin", ["admin"], { action: "configure", expectedVersion: 2, config }, 2);
  assert.deepEqual(after.runs[0], before);
  assert.equal(after.config.stages[0]!.model, "company-model");
  assert.deepEqual(after.config.stages.map(stage => stage.approval), DEFAULT_PIPELINE.stages.map(stage => stage.approval));
});

test("marketplace distinguishes drafts, workspace copies and unrun checks", () => {
  const engine = memoryPipelines();
  const snapshot: WorkbenchSnapshot = { workspaceId: "company-a", actor: "reader", roles: ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, pipelines: engine.snapshot("company-a"), records: [], audit: [], demo: true,
    mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  const page = workforceMarketplacePage(snapshot, "Example company");
  assert.match(page.context!, /Example company/);
  assert.match(page.body, /disabled>Add remaining 26/);
  assert.match(page.body, /not endorsed or evaluated/);
  assert.match(workforceMarketplacePage(snapshot, "Company", slugs[0]).body, /Checks not run/);
  snapshot.pipelines!.config = installWorkforceAgents(DEFAULT_PIPELINE, slugs);
  const detail = workforceMarketplacePage(snapshot, "Company", slugs[0]).body;
  assert.match(detail, /Configure workspace copy/);
  assert.doesNotMatch(detail, /workforce-install/);
  assert.match(workforceMarketplacePage(snapshot, "Company", "missing").body, /not found/);
});
