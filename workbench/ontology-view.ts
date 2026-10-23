import type { OntologyCatalog } from "./ontology.js";
import type { Material } from "./materials.js";
import type { Page } from "./studio-view.js";
import { escape, status, panel, detail, table, cellLink, more } from "./ui.js";

export interface OntologyPreview {
  objectType: string;
  primaryKey: string;
  material?: Material;
  error?: string;
  loading?: boolean;
}

export function ontologyPage(workspaceId: string, catalog: OntologyCatalog | undefined, query: URLSearchParams, preview?: OntologyPreview, canAuthor = false): Page {
  const tab = query.get("tab") === "setup" ? "setup" : "objects";
  const selected = catalog?.objectTypes.find(type => type.apiName === query.get("type"));
  const search = query.get("q")?.trim() ?? "";
  const types = (catalog?.objectTypes ?? []).filter(type =>
    [type.apiName, ...type.properties, ...type.links.map(link => link.apiName + " " + link.targetType)].join(" ").toLowerCase().includes(search.toLowerCase()));
  const mode = catalog ? { sample: "Sample data", dataset: "Ingested dataset", foundry: "Foundry configured" }[catalog.mode] : "Not configured";
  const environment = panel("Environment", detail([
    ["Source", status(catalog ? "info" : "neutral", mode)],
    ["Ontology", escape(catalog?.ontology ?? "No source selected")],
    ["Allowed types", String(catalog?.objectTypes.length ?? 0)],
    ["Access", "Read only · workspace scoped"],
  ], true) + `<p class="text-2">${catalog?.mode === "foundry" ? "Configuration is loaded. Read an object to verify access." : catalog?.mode === "sample" ? "Synthetic data for demonstrations. No Foundry connection." : catalog?.mode === "dataset" ? "Local imported data. No live Foundry connection." : "An administrator must configure a source before objects can be read."}</p>`,
    { actions: '<a class="secondary" href="#/ontology?tab=setup">Connection setup</a>' });
  const navigation = `<nav class="ontology-tabs" aria-label="Ontology pages"><a href="#/ontology" ${tab === "objects" ? 'aria-current="page"' : ""}>Object types</a><a href="#/ontology?tab=setup" ${tab === "setup" ? 'aria-current="page"' : ""}>Setup</a></nav>`;
  const filter = `<form id="ontology-filter" class="ontology-toolbar"><label for="ontology-query" class="visually-hidden">Search object types</label><input id="ontology-query" name="q" type="search" maxlength="100" value="${escape(search)}" placeholder="Find a type, property or relationship"><button class="secondary">Search</button>${search ? '<a class="quiet" href="#/ontology">Clear</a>' : ""}</form>`;
  const rows = types.map(type => ({ cells: [
    cellLink(`#/ontology?type=${encodeURIComponent(type.apiName)}`, type.apiName),
    String(type.properties.length), String(type.links.length), status("neutral", "Read only"),
  ], selected: selected?.apiName === type.apiName }));
  const resources = panel("Object types", filter + table([
    { label: "Type" }, { label: "Properties" }, { label: "Relationships" }, { label: "Access" },
  ], rows, { label: "Allowed object types", empty: `<div class="empty"><p>${!catalog ? "No source configured." : search ? "No matching object types." : "No object types available."}</p><a href="${search ? "#/ontology" : "#/ontology?tab=setup"}">${search ? "Clear search" : "View setup"}</a></div>` }), { count: String(types.length) });
  let inspector = "";
  if (selected) {
    const current = preview?.objectType === selected.apiName ? preview : undefined;
    const relationships = selected.links.length ? selected.links.map(link => `<li><code>${escape(link.apiName)}</code> → <a href="#/ontology?type=${encodeURIComponent(link.targetType)}">${escape(link.targetType)}</a></li>`).join("") : "<li>No allowed relationships.</li>";
    inspector = panel(selected.apiName, `<div class="ontology-type-details"><section><h3>Allowed properties</h3><div class="ontology-properties">${selected.properties.map(property => `<code>${escape(property)}</code>`).join("")}</div></section><section><h3>Relationships</h3><ul class="plain">${relationships}</ul></section></div>
      <form id="ontology-read" class="ontology-toolbar" data-type="${escape(selected.apiName)}"><label>Object ID<input name="primaryKey" required maxlength="200" value="${escape(current?.primaryKey ?? "")}" placeholder="${catalog?.mode === "sample" ? selected.apiName === "Service" ? "demo-service" : "demo-library" : "Object primary key"}"></label><button class="primary" ${current?.loading ? "disabled" : ""}>${current?.loading ? "Reading…" : "Read object"}</button></form>
      <p class="text-3">This read does not send data to a model or change the source.</p>
      ${current?.error ? `<p class="callout bad" role="alert">${escape(current.error)}</p>` : ""}
      ${current?.material ? `<section class="ontology-preview" aria-label="Reference preview"><div class="ontology-toolbar"><h3>${escape(current.material.title)}</h3>${status("ok", "Object read succeeded")}${canAuthor ? '<button class="secondary" data-ontology-use>Use in work item</button>' : ""}</div><p class="text-2">This read verified one object. It does not verify every type or relationship.</p>${more("View raw evidence", `<pre>${escape(current.material.content)}</pre>`)}<p class="text-3">Adding this snapshot to a work item shares it with that workflow's agents when they run.</p></section>` : ""}`);
  } else if (query.has("type")) {
    inspector = '<p class="callout warn" role="status">This object type is not allowed in the current workspace. Choose one from the table.</p>';
  }
  const lineage = catalog?.lineage ? panel("Dataset lineage", detail([
    ["Dataset", escape(catalog.lineage.name)], ["Imported", escape(catalog.lineage.ingestedAt)],
  ]) + table([{ label: "Source" }, { label: "Type" }, { label: "Rows" }], catalog.lineage.sources.map(source => ({ cells: [escape(source.file), escape(source.objectType), String(source.rows)] }))) + more("View lineage evidence", `<pre>${escape(JSON.stringify(catalog.lineage, null, 2))}</pre>`)) : "";
  return { title: "Ontology", context: "Data and relationships for workspace agents.", actions: '<a class="secondary" href="#/mcp">MCP inspector</a>',
    body: `<div class="ontology-console">${environment}${navigation}${tab === "setup" ? setup(workspaceId) : resources + inspector + lineage}</div>` };
}

function setup(workspaceId: string): string {
  const foundry = { version: 1, workspaces: [{ workspaceId, mode: "foundry", ontology: "YOUR_ONTOLOGY_RID", baseUrl: "https://your-foundry.example", tokenSetting: "MAGENTIC_FOUNDRY_TOKEN", objectTypes: [{ apiName: "Service", properties: ["name", "description"], links: [] }] }] };
  const sample = { version: 1, workspaces: [{ workspaceId, mode: "sample" }] };
  return panel("Connection setup", `<ol class="ontology-steps"><li><strong>Choose a source</strong><p>Foundry, an imported dataset, or local sample data.</p></li><li><strong>Configure access</strong><p>Your administrator selects the types and properties this workspace can read.</p></li><li><strong>Verify an object</strong><p>Read a known object before using it in a workflow.</p></li></ol>
    ${more("Administrator instructions", '<p>Save the configuration in a server file and set <code>MAGENTIC_ONTOLOGY_FILE</code> to its path. Merge this workspace into existing configuration, preserving other companies. Restart the workspace server to load it.</p>')}
    ${more("View Foundry configuration", `<p>Replace the example URL, ontology ID and object types. Set the token through the server environment; never paste it into this page.</p><pre>${escape(JSON.stringify(foundry, null, 2))}</pre>`)}
    ${more("View sample configuration", `<p>This config enables synthetic Service and Dependency objects only.</p><pre>${escape(JSON.stringify(sample, null, 2))}</pre>`)}
    <p class="text-3">This console does not provision a Foundry tenant, edit source objects, or grant access.</p>`);
}
