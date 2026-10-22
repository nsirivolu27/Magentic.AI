import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { createWorkspaceMcpServer } from "../workbench/mcp-portal.js";
import { createOntologyDirectory, loadOntologyDirectory, ontologyMaterial } from "../workbench/ontology.js";
import { ingest } from "../workbench/ontology-ingest.js";
import { workspaceView } from "../workbench/workspace-view.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { companyInput } from "./ontology-ingest.test.js";

/**
 * Dataset mode: the adapter reads an ingested file with real paging and
 * links that follow the blueprint's foreign keys, through the same reader,
 * MCP tools and reference form the Foundry mode uses.
 */

function datasetDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "ontology-dataset-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = companyInput();
  input.files.set("Company.csv", "companyId,name\ndemo-company,Synthetic company\nalpha,Alpha\nbeta,Beta\n");
  writeFileSync(join(dir, "dataset.json"), JSON.stringify(ingest(input)));
  return dir;
}
const config = (file: string, objectTypes?: unknown) => ({ version: 1, workspaces: [{ workspaceId: "one", mode: "dataset", file, ...(objectTypes ? { objectTypes } : {}) }] });
const ctx = () => ({ store: memoryStore(), audit: memoryAudit(), members: memoryMembers([{ workspaceId: "one", actor: "owner", roles: ["admin", "author"] }]) });

test("a dataset connection resolves its file beside the configuration and exposes lineage", t => {
  const dir = datasetDir(t);
  const configPath = join(dir, "ontology.json"); writeFileSync(configPath, JSON.stringify(config("dataset.json")));
  const reader = loadOntologyDirectory(() => configPath)("one")!;
  const catalog = reader.catalog();
  assert.equal(catalog.mode, "dataset"); assert.equal(catalog.ontology, "Company automation");
  assert.equal(catalog.objectTypes.length, 6);
  assert.deepEqual(catalog.objectTypes.find(type => type.apiName === "Run")!.links.map(link => link.apiName), ["company", "workflow", "agent"]);
  assert.match(catalog.lineage!.sha256, /^[a-f0-9]{64}$/);
  assert.equal(catalog.lineage!.sources.find(source => source.objectType === "Company")!.rows, 3);
  assert.throws(() => createOntologyDirectory(config("missing.json"), undefined, undefined, dir), /missing\.json: provide a readable dataset/);
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ version: 1 }));
  assert.throws(() => createOntologyDirectory(config("wrong.json"), undefined, undefined, dir), /not a dataset written by ontology:ingest/);
});

test("pages are stable and bounded, links follow foreign keys, and keys outside the file are refused", async t => {
  const dir = datasetDir(t);
  const reader = createOntologyDirectory(config("dataset.json"), undefined, undefined, dir)("one")!;
  const first = await reader.list({ objectType: "Company", pageSize: 2 });
  assert.deepEqual(first.objects.map(object => object.primaryKey), ["alpha", "beta"]); assert.equal(first.nextPageToken, "2");
  const second = await reader.list({ objectType: "Company", pageSize: 2, pageToken: first.nextPageToken! });
  assert.deepEqual(second.objects.map(object => object.primaryKey), ["demo-company"]); assert.equal(second.nextPageToken, undefined);
  await assert.rejects(reader.list({ objectType: "Company", pageSize: 2, pageToken: "9" }), /page token/);
  await assert.rejects(reader.list({ objectType: "Company", pageSize: 2, pageToken: "x" }), /page token/);
  const run = await reader.get({ objectType: "Run", primaryKey: "demo-run" });
  assert.equal(run.source.mode, "dataset"); assert.equal(run.source.url, undefined);
  assert.deepEqual(run.properties.companyId, "demo-company");
  const linked = await reader.links({ objectType: "Run", primaryKey: "demo-run", linkType: "workflow" });
  assert.equal(linked.objects.length, 1); assert.equal(linked.objects[0]!.primaryKey, "demo-workflow");
  // The sample mode returns every target; the dataset returns only the object the foreign key names.
  const company = await reader.links({ objectType: "Run", primaryKey: "demo-run", linkType: "company" });
  assert.deepEqual(company.objects.map(object => object.primaryKey), ["demo-company"]);
  await assert.rejects(reader.get({ objectType: "Run", primaryKey: "nope" }), /not found in the dataset/);
  await assert.rejects(reader.links({ objectType: "Run", primaryKey: "demo-run", linkType: "reviewer" }), /not enabled/);
  assert.match(ontologyMaterial(run).title, /^Dataset: Run \/ demo-run$/);
});

test("a connection can narrow the dataset to fewer types, properties and links, never widen it", async t => {
  const dir = datasetDir(t);
  const narrow = [{ apiName: "Run", properties: ["status"], links: [{ apiName: "agent", targetType: "Agent" }] }, { apiName: "Agent", properties: ["name"], links: [] }];
  const reader = createOntologyDirectory(config("dataset.json", narrow), undefined, undefined, dir)("one")!;
  assert.deepEqual(reader.catalog().objectTypes.map(type => type.apiName), ["Run", "Agent"]);
  const run = await reader.get({ objectType: "Run", primaryKey: "demo-run" });
  assert.deepEqual(run.properties, { status: "not_started" });
  await assert.rejects(reader.get({ objectType: "Company", primaryKey: "demo-company" }), /not enabled/);
  await assert.rejects(reader.links({ objectType: "Run", primaryKey: "demo-run", linkType: "workflow" }), /not enabled/);
  assert.throws(() => createOntologyDirectory(config("dataset.json", [{ apiName: "Run", properties: ["secret"], links: [] }]), undefined, undefined, dir), /Run has no property secret/);
  assert.throws(() => createOntologyDirectory(config("dataset.json", [{ apiName: "Run", properties: ["status"], links: [{ apiName: "company", targetType: "Agent" }] }, { apiName: "Agent", properties: ["name"], links: [] }]), undefined, undefined, dir), /Run has no link company to Agent/);
});

test("MCP clients read the dataset with provenance and the reference form names it", async t => {
  const dir = datasetDir(t);
  const reader = createOntologyDirectory(config("dataset.json"), undefined, undefined, dir)("one");
  const server = createWorkspaceMcpServer(ctx(), "one", reader);
  const client = new Client({ name: "dataset-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b as never); await client.connect(a as never);
    const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
    const catalog = JSON.parse(text(await client.callTool({ name: "get_ontology_catalog", arguments: {} }))) as { mode: string; lineage: { sources: { file: string }[] } };
    assert.equal(catalog.mode, "dataset"); assert.equal(catalog.lineage.sources[0]!.file, "Company.csv");
    const page = await client.callTool({ name: "list_ontology_links", arguments: { objectType: "Evidence", primaryKey: "demo-evidence", linkType: "run", pageSize: 1 } });
    assert.equal(page.isError, undefined); assert.match(text(page), /"primaryKey":"demo-run"/); assert.match(text(page), /retrievedAt/);
    const tools = await client.listTools();
    assert.ok(tools.tools.filter(tool => tool.name.includes("ontology")).every(tool => tool.annotations?.readOnlyHint && !tool.annotations.openWorldHint));
  } finally { await client.close(); await server.close(); }
  const page = workspaceView(memoryPipelines().snapshot("one"), undefined, "owner", ["admin"], { title: "", brief: "" }, [], undefined, undefined, "", reader!.catalog());
  assert.match(page, /Dataset Ontology/); assert.match(page, /ingested dataset file/);
});
