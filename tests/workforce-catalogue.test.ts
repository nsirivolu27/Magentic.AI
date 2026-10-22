import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { agentConfigurableSchema } from "../workbench/agent-configurables.js";
import { importAgentDefinition } from "../workbench/agent-studio.js";

const root = resolve("examples/workforce/accenture");
const pack = JSON.parse(readFileSync(resolve(root, "catalogue.json"), "utf8"));

test("workforce templates import through the real strict schema without granting external tools", () => {
  assert.equal(pack.agents.length, 26);
  assert.equal(readdirSync(resolve(root, "agents")).length, pack.agents.length);
  const ids = new Set<string>();
  for (const item of pack.agents) {
    const text = readFileSync(resolve(root, "agents", item.slug + ".json"), "utf8");
    const agent = agentConfigurableSchema.parse(item.definition);
    assert.deepEqual(JSON.parse(text), agent);
    assert.deepEqual(importAgentDefinition(text, agent.id), agent);
    assert.equal(ids.has(agent.id), false); ids.add(agent.id);
    assert.equal(agent.model, "select-connected-model");
    assert.equal(agent.bot.requireSourceRead, true);
    assert.ok(agent.bot.allowedTools!.includes("read_project_file"));
    assert.ok(agent.bot.allowedTools!.every(tool => ["list_project_files", "read_project_file", "project_diff"].includes(tool)));
    assert.equal(item.status, "draft");
    assert.equal(item.provenance, "proposed");
    assert.ok(item.connectorRoadmap.every((connector: { status: string }) => connector.status === "not-connected"));
  }
});

test("workforce relationships resolve and public labels remain separate from proposed agents", () => {
  const groups = new Set(pack.groups.map((group: { id: string }) => group.id));
  const slugs = new Set(pack.agents.map((agent: { slug: string }) => agent.slug));
  const sources = new Set(pack.sources.map((source: { id: string }) => source.id));
  assert.equal(groups.size, pack.groups.length);
  assert.equal(slugs.size, pack.agents.length);
  for (const group of pack.groups) {
    if (group.provenance === "public") assert.ok(group.sourceIds.length);
    assert.ok(group.sourceIds.every((id: string) => sources.has(id)));
    assert.ok(pack.agents.some((agent: { group: string }) => agent.group === group.id));
  }
  for (const agent of pack.agents) {
    assert.ok(groups.has(agent.group));
    assert.ok(agent.humanReviewer);
    assert.deepEqual(agent.testCases.map((item: { id: string }) => item.id), ["evidence", "missing", "conflict", "injection"]);
    assert.ok(agent.testCases.every((item: { status: string }) => item.status === "not-run"));
  }
  for (const pipeline of pack.pipelines) {
    assert.ok(pipeline.steps.every((slug: string) => slugs.has(slug)));
    assert.ok(pipeline.review);
  }
  assert.equal(pack.activation.state, "not-installed");
});

test("the offline explorer displays the same catalogue as the importable files", () => {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const embedded = html.match(/<script id="catalogue" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  assert.deepEqual(JSON.parse(embedded[1]!), pack);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
