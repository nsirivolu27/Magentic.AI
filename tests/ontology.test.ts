import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { createOntologyDirectory, loadOntologyDirectory, ontologyConfigSchema, ontologyMaterial } from "../workbench/ontology.js";
import { createWorkspaceMcpServer } from "../workbench/mcp-portal.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { runWorkspaceAgent } from "../workbench/chat.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { workspaceView } from "../workbench/workspace-view.js";

const sampleConfig = { version: 1, workspaces: [{ workspaceId: "one", mode: "sample" }] };
const foundryConfig = { version: 1, workspaces: [{ workspaceId: "one", mode: "foundry", ontology: "test-ontology", baseUrl: "https://foundry.example", tokenSetting: "MAGENTIC_FOUNDRY_TOKEN",
  objectTypes: [{ apiName: "Service", properties: ["name"], links: [{ apiName: "dependencies", targetType: "Dependency" }] }, { apiName: "Dependency", properties: ["version"], links: [] }] }] };
const ctx = () => ({ store: memoryStore(), audit: memoryAudit(), members: memoryMembers([
  { workspaceId: "one", actor: "owner", roles: ["admin", "author"] }, { workspaceId: "two", actor: "other", roles: ["author"] },
]) });

test("ontology configuration is strict, workspace scoped and validates link targets", () => {
  const reader = createOntologyDirectory(sampleConfig);
  assert.ok(reader("one")); assert.equal(reader("two"), undefined);
  assert.throws(() => ontologyConfigSchema.parse({ ...sampleConfig, token: "bad" }), /Unrecognized/);
  assert.throws(() => ontologyConfigSchema.parse({ ...sampleConfig, workspaces: [...sampleConfig.workspaces, ...sampleConfig.workspaces] }), /workspaceId/);
  const bad = structuredClone(foundryConfig); bad.workspaces[0]!.objectTypes[0]!.links[0]!.targetType = "Unknown";
  assert.throws(() => ontologyConfigSchema.parse(bad), /targetType/);
  for (const baseUrl of ["http://foundry.example", "https://user:secret@foundry.example", "https://foundry.example/path", "https://foundry.example/?token=hidden"]) {
    const badUrl = structuredClone(foundryConfig); badUrl.workspaces[0]!.baseUrl = baseUrl;
    assert.throws(() => ontologyConfigSchema.parse(badUrl), /baseUrl/);
  }
});

test("startup uses the setting seam, refuses malformed files, and defaults to disabled", t => {
  assert.equal(loadOntologyDirectory(() => undefined)("one"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "ontology-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json"); writeFileSync(path, JSON.stringify(sampleConfig));
  const names: string[] = [];
  assert.ok(loadOntologyDirectory(name => { names.push(name); return path; })("one"));
  assert.deepEqual(names, ["MAGENTIC_ONTOLOGY_FILE"]);
  writeFileSync(path, "not-json"); assert.throws(() => loadOntologyDirectory(() => path), /MAGENTIC_ONTOLOGY_FILE/);
  assert.throws(() => createOntologyDirectory(foundryConfig, () => undefined), /MAGENTIC_FOUNDRY_TOKEN/);
});

test("Foundry v2 reads encode keys, project properties, retain paging and never expose tokens", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const reader = createOntologyDirectory(foundryConfig, () => "test-secret", async (url, init) => {
    requests.push({ url: new URL(String(url)), init: init! });
    const linked = String(url).includes("/links/");
    const data = { __apiName: linked ? "Dependency" : "Service", __primaryKey: linked ? "d1" : "a/b?c", name: "Portal", version: "1", privateField: "must not reach model" };
    return new Response(JSON.stringify(String(url).includes("/links/") || !String(url).includes("a%2Fb%3Fc") ? { data: [data], nextPageToken: "next/+=" } : data));
  })("one")!;
  const object = await reader.get({ objectType: "Service", primaryKey: "a/b?c" });
  assert.deepEqual(object.properties, { name: "Portal" });
  assert.ok(object.source.url?.endsWith("a%2Fb%3Fc"));
  const page = await reader.list({ objectType: "Service", pageSize: 1, pageToken: "previous/+=" });
  assert.equal(page.nextPageToken, "next/+=");
  const linked = await reader.links({ objectType: "Service", primaryKey: "a/b?c", linkType: "dependencies" });
  assert.deepEqual(linked.objects[0]!.properties, { version: "1" });
  assert.equal(requests[0]!.url.pathname, "/api/v2/ontologies/test-ontology/objects/Service/a%2Fb%3Fc");
  assert.equal(requests[1]!.url.searchParams.get("pageToken"), "previous/+=");
  assert.equal(requests[2]!.url.searchParams.get("select"), "version");
  for (const { init } of requests) { assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-secret"); }
  assert.doesNotMatch(JSON.stringify({ object, page, catalog: reader.catalog() }), /test-secret|privateField|tokenSetting/);
});

test("unknown types, links and caller-supplied connection fields never dispatch", async () => {
  let calls = 0;
  const reader = createOntologyDirectory(foundryConfig, () => "token", async () => { calls++; return new Response("{}"); })("one")!;
  await assert.rejects(reader.get({ objectType: "Unknown", primaryKey: "1" }), /not enabled/);
  await assert.rejects(reader.links({ objectType: "Service", primaryKey: "1", linkType: "admin" }), /not enabled/);
  await assert.rejects(reader.get({ objectType: "Service", primaryKey: "1", workspaceId: "two" }), /Unrecognized/);
  await assert.rejects(reader.list({ objectType: "Service", pageSize: 0 }), /greater than/);
  await assert.rejects(reader.get({ objectType: "Service", primaryKey: ".." }));
  assert.equal(calls, 0);
});

test("provider failures are bounded and redact upstream content", async () => {
  for (const response of [new Response("secret-token", { status: 403 }), new Response("not-json-secret"), new Response("x".repeat(128001)), new Response(JSON.stringify({ data: [{ __apiName: "Other", __primaryKey: "1" }] }))]) {
    const reader = createOntologyDirectory(foundryConfig, () => "secret-token", async () => response)("one")!;
    await assert.rejects(reader.list({ objectType: "Service" }), error => {
      assert.doesNotMatch(String(error), /secret-token|not-json-secret/); return true;
    });
  }
  let calls = 0;
  const reader = createOntologyDirectory(foundryConfig, () => "secret-token", async () => { calls++; throw new Error("secret-token"); })("one")!;
  await assert.rejects(reader.get({ objectType: "Service", primaryKey: "1" }, AbortSignal.abort()));
  assert.equal(calls, 0);
  await assert.rejects(reader.get({ objectType: "Service", primaryKey: "1" }), error => { assert.doesNotMatch(String(error), /secret-token/); return true; });
});

test("sample data is explicit, linked and preserved as a workflow evidence snapshot", async () => {
  const reader = createOntologyDirectory(sampleConfig)("one")!;
  const object = await reader.get({ objectType: "Service", primaryKey: "demo-service" });
  const material = ontologyMaterial(object);
  assert.equal(object.source.mode, "sample"); assert.equal(material.url, undefined);
  assert.match(material.title, /SAMPLE/); assert.match(material.content, /SHA-256: [a-f0-9]{64}/);
  assert.equal((await reader.links({ objectType: "Service", primaryKey: "demo-service", linkType: "dependencies" })).objects[0]!.objectType, "Dependency");
  const engine = memoryPipelines();
  const run = engine.execute("one", "owner", ["admin"], { action: "start", requestId: crypto.randomUUID(), title: "Review service dependency", brief: "Plan a maintenance task using this evidence.", materials: [material] }, 1).runs[0]!;
  material.content = "changed later";
  assert.match(run.materials![0]!.content, /synthetic-demo/);
  assert.notEqual(run.materials![0]!.content, material.content);
  assert.equal(run.status, "running"); assert.equal(run.current, 0);
});

test("actual MCP discovery exposes only configured read tools and rejects injected authority", async () => {
  const server = createWorkspaceMcpServer(ctx(), "one", createOntologyDirectory(sampleConfig)("one"));
  const client = new Client({ name: "ontology-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b as never); await client.connect(a as never);
    const { tools } = await client.listTools();
    assert.equal(tools.filter(tool => tool.name.includes("ontology")).length, 4);
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
    const result = await client.callTool({ name: "get_ontology_object", arguments: { objectType: "Service", primaryKey: "demo-service" } });
    assert.equal(result.isError, undefined); assert.match(JSON.stringify(result), /synthetic-demo/);
    const rejected = await client.callTool({ name: "get_ontology_object", arguments: { objectType: "Service", primaryKey: "demo-service", baseUrl: "https://other.example" } });
    assert.equal(rejected.isError, true);
  } finally { await client.close(); await server.close(); }
});

test("workspace agent reads Ontology through MCP and receives provenance", async () => {
  let calls = 0;
  await runWorkspaceAgent(ctx(), "one", "owner", [{ role: "user", content: "Inspect the demo service." }], { async invoke(prompt) {
    if (++calls === 1) return { content: JSON.stringify({ type: "tool", name: "get_ontology_object", arguments: { objectType: "Service", primaryKey: "demo-service" } }) };
    assert.match(prompt, /synthetic-demo/); assert.match(prompt, /retrievedAt/);
    return { content: JSON.stringify({ type: "answer", content: "This is a synthetic sample, not a live finding." }) };
  } }, new AbortController().signal, () => {}, createOntologyDirectory(sampleConfig)("one"));
  assert.equal(calls, 2);
  await assert.rejects(runWorkspaceAgent(ctx(), "two", "other", [{ role: "user", content: "Read it." }], { async invoke() {
    return { content: JSON.stringify({ type: "tool", name: "get_ontology_catalog", arguments: {} }) };
  } }, new AbortController().signal, () => {}), /unavailable/);
});

test("HTTP reference import requires membership and uses the authenticated workspace", async t => {
  const ontology = createOntologyDirectory(sampleConfig);
  const server = createWorkbenchServer({ context: ctx(), ontology, assets: new Map(), authenticate: async request => {
    if (request.headers.authorization === "owner") return { workspaceId: "one", actor: "owner" };
    if (request.headers.authorization === "other") return { workspaceId: "two", actor: "other" };
    return undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (actor: string, input: unknown) => fetch(`http://127.0.0.1:${address.port}/api/ontology/reference`, { method: "POST", headers: { Authorization: actor, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const input = { objectType: "Service", primaryKey: "demo-service" };
  assert.equal((await request("", input)).status, 401);
  assert.equal((await request("other", input)).status, 404);
  assert.equal((await request("owner", { ...input, workspaceId: "two" })).status, 400);
  const response = await request("owner", input); assert.equal(response.status, 200); assert.match((await response.json()).title, /SAMPLE/);
});

test("the reference form appears only for connected workspaces and identifies samples", () => {
  const engine = memoryPipelines();
  const absent = workspaceView(engine.snapshot("one"), undefined, "owner", ["admin"], { title: "", brief: "" }, []);
  assert.doesNotMatch(absent, /id="work-ontology"/);
  const present = workspaceView(engine.snapshot("one"), undefined, "owner", ["admin"], { title: "", brief: "" }, [], undefined, undefined, "", createOntologyDirectory(sampleConfig)("one")!.catalog());
  assert.match(present, /id="work-ontology"/); assert.match(present, /Synthetic data only/);
});
