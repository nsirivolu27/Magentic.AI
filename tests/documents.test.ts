import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocuments, documentRecords, fileDocumentStore, memoryDocumentStore, DocumentError } from "../workbench/documents.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { memoryPipelines } from "../workbench/pipeline.js";

/**
 * The documentation portal: any document given to the workspace connects to
 * the LLM workspace in three ways, from one copy. It can be attached to a
 * running workflow as reference material, added to an assistant's project
 * as a dataset, or both. Secrets are counted and never shown; content is
 * stored once by hash; nothing is trained or approved by adding a document.
 */

const W = "docs-workspace";
type Roles = ("author" | "approver" | "admin")[];

const SOP = `Grant Inquiry Routing SOP (v3)

1. Purpose. Portal inquiries must reach the regional team within one business day.
2. Regions. Northeast, Southeast, Central, Mountain, Pacific. Each has a queue named GI-<Region>.
3. Programs. Research, Infrastructure, Community. Program is read from the portal form, never inferred.
4. Catch all. Inquiries with no region or program go to GI-Triage and page the duty officer.
5. Evidence. Every routing change is recorded as evidence for control AC-3 before it is deployed.`;

function fixture() {
  const studio = memoryModelStudio({ now: () => "2026-10-02T09:00:00.000Z" });
  const pipelines = memoryPipelines();
  const documents = createDocuments({ store: memoryDocumentStore(), studio, pipelines, now: () => "2026-10-02T09:00:00.000Z" });
  const exec = (actor: string, roles: Roles, command: Record<string, unknown>) => documents.execute(W, actor, roles, command);
  return { studio, pipelines, documents, exec };
}

test("adding a document stores it once by hash, counts secrets without showing them, and refuses the empty and the huge", () => {
  const { exec, documents } = fixture();
  let s = exec("maya", ["author"], { action: "add_document", title: "Grant Inquiry Routing SOP", text: SOP });
  const doc = s.documents[0]!;
  assert.equal(doc.title, "Grant Inquiry Routing SOP");
  assert.equal(doc.addedBy, "maya");
  assert.equal(doc.bytes, Buffer.byteLength(SOP));
  assert.match(doc.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(doc.secretFindings, 0);
  assert.match(doc.excerpt, /^Grant Inquiry Routing SOP \(v3\)/);
  assert.ok(doc.excerpt.length <= 300);
  assert.deepEqual(doc.runs, []); assert.deepEqual(doc.datasets, []);
  // The same text under another title is one stored copy with two records; the snapshot never carries the content.
  s = exec("maya", ["author"], { action: "add_document", title: "Routing SOP (copy)", text: SOP });
  assert.equal(s.documents.length, 2);
  assert.equal(s.documents[1]!.contentHash, doc.contentHash);
  assert.equal(JSON.stringify(s).includes("GI-Triage"), false, "content stays in the store, not in the snapshot");
  assert.equal(documents.content(W, doc.id), SOP);
  // A credential inside a document is counted, the document is kept, and a later attach says why it is refused.
  s = exec("maya", ["author"], { action: "add_document", title: "Integration notes", text: "Connect with api_key = sk_live_1234567890abcdefghij and retry twice.\nThen call the endpoint." });
  assert.equal(s.documents[2]!.secretFindings, 1);
  assert.equal(s.documents[2]!.excerpt, "Then call the endpoint.", "the excerpt is built from the clean lines only");
  assert.equal(JSON.stringify(s).includes("sk_live"), false);
  assert.throws(() => exec("maya", ["author"], { action: "add_document", title: "Empty", text: "   " }), DocumentError);
  assert.throws(() => exec("maya", ["author"], { action: "add_document", title: "Huge", text: "x".repeat(200_001) }), DocumentError);
  assert.throws(() => exec("guest", ["approver"], { action: "add_document", title: "Not mine to add", text: SOP }), (error: unknown) => error instanceof DocumentError && error.status === 403);
});

test("a document attaches to a running workflow as reference material the stage prompt will carry", () => {
  const { exec, pipelines } = fixture();
  const doc = exec("maya", ["author"], { action: "add_document", title: "Grant Inquiry Routing SOP", text: SOP }).documents[0]!;
  const run = pipelines.execute(W, "maya", ["author"], { action: "start", requestId: randomUUID(), title: "Grant inquiry routing", brief: "Route by region and program." }, 2).runs[0]!;
  const s = exec("maya", ["author"], { action: "attach_to_run", documentId: doc.id, runId: run.id });
  assert.deepEqual(s.documents[0]!.runs, [run.id]);
  const after = pipelines.snapshot(W).runs[0]!;
  assert.equal(after.materials!.length, 1);
  assert.equal(after.materials![0]!.title, "Grant Inquiry Routing SOP");
  assert.match(after.materials![0]!.content, /GI-Triage/);
  assert.equal(after.materials![0]!.id, doc.id, "the material is the document, so a reader can trace it back");
  assert.ok(after.events.some((event) => event.action === "materials" && /Grant Inquiry Routing SOP/.test(event.detail)), "the run's timeline records the attachment");
  // Attaching again is a no op; another person cannot attach to a run they do not own.
  assert.deepEqual(exec("maya", ["author"], { action: "attach_to_run", documentId: doc.id, runId: run.id }).documents[0]!.runs, [run.id]);
  assert.throws(() => exec("noah", ["author"], { action: "attach_to_run", documentId: doc.id, runId: run.id }), (error: unknown) => error instanceof DocumentError && error.status === 403);
  // A document with a secret finding never reaches a prompt.
  const leaky = exec("maya", ["author"], { action: "add_document", title: "Integration notes", text: "password: hunter2hunter2hunter2 for the sandbox" }).documents[1]!;
  assert.throws(() => exec("maya", ["author"], { action: "attach_to_run", documentId: leaky.id, runId: run.id }), /credential|secret/i);
});

test("a document becomes a knowledge dataset on a project, in the shape the recipe wants, without training anything", () => {
  const { exec, studio } = fixture();
  const project = studio.execute(W, "maya", ["author"], { action: "create_project", name: "Agency knowledge", recipeId: "internal-knowledge", purpose: "Answer from agency SOPs." }, 2).projects[0]!;
  const doc = exec("maya", ["author"], { action: "add_document", title: "Grant Inquiry Routing SOP", text: SOP }).documents[0]!;
  const s = exec("maya", ["author"], { action: "add_to_project", documentId: doc.id, projectId: project.id });
  const dataset = studio.snapshot(W).datasets[0]!;
  assert.deepEqual(s.documents[0]!.datasets, [dataset.id]);
  assert.equal(dataset.name, "Grant Inquiry Routing SOP (document)");
  assert.equal(dataset.status, "valid", "the records are validated on the way in so the person sees the count at once");
  assert.ok(dataset.validation!.records >= 5, "one record per numbered section or paragraph");
  assert.equal(dataset.validation!.secretFindings, 0);
  assert.equal(studio.snapshot(W).jobs.length, 0, "adding a document never trains");
  // The records keep the document's own wording and say where they came from.
  const records = documentRecords("Grant Inquiry Routing SOP", SOP, "messages");
  assert.ok(records.every((line) => JSON.parse(line).messages[0].content.startsWith("Grant Inquiry Routing SOP")));
  assert.ok(records.some((line) => /GI-Triage/.test(line)));
  const pairs = documentRecords("Grant Inquiry Routing SOP", SOP, "prompt-completion");
  assert.ok(pairs.every((line) => "prompt" in JSON.parse(line) && "completion" in JSON.parse(line)));
  // Adding the same document twice to the same project is refused with the dataset named.
  assert.throws(() => exec("maya", ["author"], { action: "add_to_project", documentId: doc.id, projectId: project.id }), /already/);
});

test("removing a document keeps what runs and datasets already received; the file store survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "magentic-docs-"));
  const studio = memoryModelStudio({ now: () => "2026-10-02T09:00:00.000Z" });
  const pipelines = memoryPipelines();
  const open = () => createDocuments({ store: fileDocumentStore(dir), studio, pipelines, now: () => "2026-10-02T09:00:00.000Z" });
  let documents = open();
  const doc = documents.execute(W, "maya", ["author"], { action: "add_document", title: "Grant Inquiry Routing SOP", text: SOP }).documents[0]!;
  const run = pipelines.execute(W, "maya", ["author"], { action: "start", requestId: randomUUID(), title: "Routing", brief: "Route." }, 2).runs[0]!;
  documents.execute(W, "maya", ["author"], { action: "attach_to_run", documentId: doc.id, runId: run.id });
  // A second engine on the same directory sees the record and the content.
  documents = open();
  assert.equal(documents.snapshot(W).documents[0]!.id, doc.id);
  assert.equal(documents.content(W, doc.id), SOP);
  assert.ok(readdirSync(dir).length > 0);
  // Only the adder or an admin removes; the run keeps its material because it was frozen at attach time.
  assert.throws(() => documents.execute(W, "noah", ["author"], { action: "remove_document", documentId: doc.id }), (error: unknown) => error instanceof DocumentError && error.status === 403);
  const s = documents.execute(W, "sam", ["admin"], { action: "remove_document", documentId: doc.id });
  assert.equal(s.documents.length, 0);
  assert.equal(pipelines.snapshot(W).runs[0]!.materials!.length, 1);
  assert.throws(() => documents.content(W, doc.id), DocumentError);
});

// ------------------------------------------------------------ over the MCP

import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

test("a standalone MCP client can add a document and connect it, but never read its content back", async (t) => {
  const studio = memoryModelStudio({ now: () => "2026-10-02T09:00:00.000Z" });
  const pipelines = memoryPipelines();
  const documents = createDocuments({ store: memoryDocumentStore(), studio, pipelines });
  const server = createWorkbenchServer({ assets: new Map(), pipelines, studio, documents,
    context: { store: memoryStore(), audit: memoryAudit(), workflow: DEFAULT_WORKFLOW, members: memoryMembers([{ workspaceId: W, actor: "maya", roles: ["author", "admin"] }]) },
    authenticate: async (req) => req.headers.authorization === "Bearer secret-token" ? { workspaceId: W, actor: "maya" } : undefined,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/pipeline-mcp`), { requestInit: { headers: { Authorization: "Bearer secret-token" } } });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { value: JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "null"), isError: !!response.isError };
  };
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(["list_documents", "add_document", "connect_document"].every((name) => tools.includes(name)));
  const added = await call("add_document", { title: "Grant Inquiry Routing SOP", text: SOP });
  assert.equal(added.isError, false); assert.equal(added.value.title, "Grant Inquiry Routing SOP");
  const listed = await call("list_documents", {});
  assert.equal(listed.value.length, 1);
  assert.equal(JSON.stringify(listed.value).includes("GI-Triage"), false, "content never crosses the MCP");
  const run = pipelines.execute(W, "maya", ["author"], { action: "start", requestId: randomUUID(), title: "Routing", brief: "Route." }, 2).runs[0]!;
  const both = await call("connect_document", { documentId: added.value.id, runId: run.id, projectId: run.id });
  assert.equal(both.isError, true); assert.match(both.value.error, /exactly one/);
  const attached = await call("connect_document", { documentId: added.value.id, runId: run.id });
  assert.deepEqual(attached.value.runs, [run.id]);
  assert.equal(pipelines.snapshot(W).runs[0]!.materials!.length, 1);
});
