import assert from "node:assert/strict";
import test from "node:test";
import { ontologyPage } from "../workbench/ontology-view.js";
import { createOntologyDirectory, ontologyMaterial, type OntologyCatalog } from "../workbench/ontology.js";

const catalog: OntologyCatalog = { mode: "foundry", ontology: "company-ontology", objectTypes: [
  { apiName: "Service", properties: ["name", "owner"], links: [{ apiName: "dependencies", targetType: "Dependency" }] },
  { apiName: "Dependency", properties: ["version"], links: [] },
] };

test("configured Foundry is not presented as a verified connection", () => {
  const html = ontologyPage("one", catalog, new URLSearchParams()).body;
  assert.match(html, /Foundry configured/);
  assert.match(html, /Read an object to verify access/);
  assert.doesNotMatch(html, /Object read succeeded|Connected to Foundry/);
});

test("ontology search covers properties and relationships with a clear empty state", () => {
  const html = ontologyPage("one", catalog, new URLSearchParams("q=owner")).body;
  assert.match(html, /type=Service/);
  assert.doesNotMatch(html, /type=Dependency/);
  assert.match(ontologyPage("one", catalog, new URLSearchParams("q=dependencies")).body, /type=Service/);
  const empty = ontologyPage("one", catalog, new URLSearchParams("q=absent")).body;
  assert.match(empty, /No matching object types/);
  assert.match(empty, /Clear search/);
});

test("unconfigured and unknown object types cannot offer a read form", () => {
  const missing = ontologyPage("one", undefined, new URLSearchParams("type=Service")).body;
  assert.match(missing, /Not configured/);
  assert.doesNotMatch(missing, /id="ontology-read"/);
  const denied = ontologyPage("one", catalog, new URLSearchParams("type=Private")).body;
  assert.match(denied, /not allowed in the current workspace/);
  assert.doesNotMatch(denied, /id="ontology-read"/);
});

test("sample evidence is labelled and only authors can add it to a work draft", async () => {
  const reader = createOntologyDirectory({ version: 1, workspaces: [{ workspaceId: "one", mode: "sample" }] })("one")!;
  const material = ontologyMaterial(await reader.get({ objectType: "Service", primaryKey: "demo-service" }));
  const preview = { objectType: "Service", primaryKey: "demo-service", material };
  const html = ontologyPage("one", reader.catalog(), new URLSearchParams("type=Service"), preview, true).body;
  assert.match(html, /Synthetic data/);
  assert.match(html, /Object read succeeded/);
  assert.match(html, /SHA-256/);
  assert.match(html, /data-ontology-use/);
  assert.doesNotMatch(ontologyPage("one", reader.catalog(), new URLSearchParams("type=Service"), preview, false).body, /data-ontology-use/);
  assert.doesNotMatch(ontologyPage("one", reader.catalog(), new URLSearchParams("type=Dependency"), preview, true).body, /Object read succeeded/);
});

test("errors are escaped and setup names the selected workspace without a credential input", () => {
  const html = ontologyPage("one", catalog, new URLSearchParams("type=Service"), { objectType: "Service", primaryKey: '"><script>', error: "<script>alert(1)</script>" }).body;
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  const setup = ontologyPage("company-one", catalog, new URLSearchParams("tab=setup")).body;
  assert.match(setup, /company-one/);
  assert.match(setup, /MAGENTIC_ONTOLOGY_FILE/);
  assert.match(setup, /never paste it into this page/);
  assert.doesNotMatch(setup, /type="password"/);
});
