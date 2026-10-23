# Foundry Ontology integration

Run Magentic from the repository while the API and agent loop matures. Application packaging is a later milestone. Node 22 and the pinned pnpm are sufficient; this adapter adds no dependency.

## Try the complete local path

From the repository root in PowerShell:

```powershell
corepack pnpm build:workbench
$env:MAGENTIC_ONTOLOGY_FILE = (Resolve-Path ./workbench/ontology.sample.json).Path
$env:MAGENTIC_WORKSPACE = 'workspace'
corepack pnpm local:workbench
```

The sample is explicitly synthetic, not a live Foundry connection or a public dataset. Stop an existing server before starting another against the same saved workspace. Configuration is read at startup; restart a running dev watcher after setting environment variables so its child inherits them. Use the actual workspace ID in the sample configuration when yours differs.

1. Open the printed local address. Create a new work item.
2. Under **Reference material**, choose **Service**, enter **demo-service**, then **Read and add reference**.
3. Review the saved snapshot. Describe a development task and start the work item.
4. Enable phase agents and connect a committed Git repository through Workspace setup if needed. Start the requirements/planning agent. The same saved reference accompanies subsequent phases; it is not fetched silently again.
5. Review proposals and run configured checks. Evidence does not grant approval or authorize deployment.

Workspace chat can also call `get_ontology_catalog`, `list_ontology_objects`, `get_ontology_object`, and `list_ontology_links`. For example: “Read the demo-service Service object and its dependencies. Clearly distinguish synthetic facts from unknowns.” The existing MCP inspector discovers these tools when configured.

## Ingest a dataset and read it locally

The dataset mode is the reproducible path when no Foundry tenant is available yet. A blueprint (the same design document used to create object types in Ontology Manager) and one CSV file per object type become a single dataset file:

```powershell
corepack pnpm build:workbench
corepack pnpm ontology:ingest --blueprint .\examples\ontology\company\blueprint.json --data .\examples\ontology\company\data --out .\.magentic-dev\company-dataset.json
```

Every row is checked before anything is written: unknown or missing columns, values that do not match the declared type, empty or duplicate keys, links whose target does not exist, and links that cross the blueprint's scope property. The first failure stops the run and names the file, row and column. The output records each source file's SHA-256 and row count, so a reference snapshot can be traced back to the exact input.

Point a workspace at the file (the path is relative to the configuration file):

```json
{ "version": 1, "workspaces": [{ "workspaceId": "workspace", "mode": "dataset", "file": "company-dataset.json" }] }
```

Set `MAGENTIC_ONTOLOGY_FILE` to that configuration and start the workbench as above. The reference form, the four MCP tools and the standalone `ontology:mcp` server read the dataset with real paging (`pageSize` up to 10, explicit `nextPageToken`) and links that follow the blueprint's foreign keys, so `list_ontology_links` returns the one object a link points at. An optional `objectTypes` list on the connection narrows the dataset to fewer types, properties or links; it can never add one the blueprint does not define. `get_ontology_catalog` includes the lineage block (dataset name, ingestion time, file hash, source files).

`examples/ontology/openfema` applies the same path to a public dataset, FEMA's Disaster Declarations Summaries, with the download command and a State reference table.

## Connect a real development environment

Create a local configuration outside the repository or in an ignored directory:

```json
{
  "version": 1,
  "workspaces": [{
    "workspaceId": "workspace",
    "mode": "foundry",
    "baseUrl": "https://YOUR-FOUNDRY-HOST",
    "ontology": "YOUR-ONTOLOGY-API-NAME-OR-RID",
    "tokenSetting": "MAGENTIC_FOUNDRY_TOKEN",
    "objectTypes": [
      { "apiName": "Service", "properties": ["name"], "links": [{ "apiName": "dependencies", "targetType": "Dependency" }] },
      { "apiName": "Dependency", "properties": ["name", "version"], "links": [] }
    ]
  }]
}
```

Replace the example object, property and link API names with those in your Ontology Manager. Set `MAGENTIC_ONTOLOGY_FILE` to its absolute path and inject `MAGENTIC_FOUNDRY_TOKEN` through your local environment or secret manager. Never put the token in configuration, prompts, source files or screenshots. Missing credentials or invalid configuration fail startup. No configured file means no Ontology tools or form.

The token's Foundry permissions are the upstream authority. Magentic's object/property/link allowlist further narrows what this connection returns. Everyone authorized to use that Magentic workspace can read its selected data under this connection identity. Use a narrowly scoped development identity; this release does not implement per-user OAuth or token refresh. Palantir recommends OAuth2 for production applications: [authentication documentation](https://www.palantir.com/docs/foundry/api/general/overview/authentication).

## Connect from VS Code or another MCP client

After building, `corepack pnpm ontology:mcp` starts the standalone stdio server. A client launches it as a child process; a waiting terminal is normal. Only protocol messages go to stdout. Example `.vscode/mcp.json` (replace absolute paths and inherit the token from the launching environment):

```json
{
  "servers": {
    "magentic-ontology": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/Magentic.AI/dist/workbench/ontology-main.mjs"],
      "env": {
        "MAGENTIC_ONTOLOGY_FILE": "C:/private/magentic-ontology.json",
        "MAGENTIC_WORKSPACE": "workspace"
      }
    }
  }
}
```

This is a separate MCP connection usable by a developer's MCP client. The Magentic VS Code coding sidebar does not yet call Ontology directly. Workflow integration is through workspace chat and explicit reference snapshots. No new agent framework or ECC dependency is required; existing requirements, planning, implementation, validation, review and delivery agents consume the reference material.

## Data flow and verification boundary

Public source → Foundry ingestion/transforms → Ontology objects and links → bounded read-only API adapter → reviewed reference snapshot → Magentic phase agents → reviewed code and checks.

Foundry owns ingestion and semantic modeling; this adapter consumes existing Ontology data. It does not upload datasets, modify Foundry records or execute Ontology Actions. API routes follow Palantir's [List Objects](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-objects/list-objects) and [List Linked Objects](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/linked-objects/list-linked-objects) contracts. Each read has a ten-second deadline and 128 KB response limit. Paging is explicit. Foundry may return more objects than the requested page size; responses above 50 objects are rejected, never silently dropped.

Each returned object includes its identity, retrieval time, mode and API source URL. Workflow snapshots include a content hash for comparison, not a cryptographic approval or proof that upstream data was true. Imported source text is untrusted. Configured model providers receive selected excerpts when a chat or phase runs.

Automated tests exercise mocked Foundry HTTP responses, ingested datasets, and real local MCP transports, authentication, projections, links, paging and the workflow reference path. A real Foundry tenant has not been verified until its live object read succeeds. The dataset mode gives the challenge a selected public dataset and a reproducible local demonstration today; ingestion into a Foundry environment follows the same blueprint when a tenant is available.
