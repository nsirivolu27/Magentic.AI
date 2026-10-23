# OpenFEMA disaster declarations

A public dataset for the reproducible ingestion path. FEMA publishes Disaster
Declarations Summaries through the OpenFEMA API in the public domain, one row
per designated area. The blueprint maps that file to a `Declaration` object
type linked to a `State` reference table, which is the shape a person would
create in Foundry's Ontology Manager.

Files in this folder are design and reference data only. No Foundry
environment, dataset or connection is created by them.

## Download the excerpt

Windows PowerShell, from the repository root. The query asks for the newest
200 designated areas and only the columns in the blueprint:

```powershell
$query = '$top=200&$orderby=declarationDate desc&$select=id,disasterNumber,state,declarationType,declarationDate,incidentType,declarationTitle,designatedArea,fipsStateCode,fipsCountyCode&$format=csv'
Invoke-WebRequest -Uri "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$query" -OutFile .\examples\ontology\openfema\data\Declaration.csv
```

Record the download date beside the file when you commit it. The ingest
output carries the file's SHA-256, so a reviewer can tell which excerpt a
snapshot came from.

## Ingest and read

```powershell
corepack pnpm build:workbench
corepack pnpm ontology:ingest --blueprint .\examples\ontology\openfema\blueprint.json --data .\examples\ontology\openfema\data --out .\.magentic-dev\openfema-dataset.json
```

Then point a workspace at the dataset in `.magentic-dev\ontology.json`:

```json
{ "version": 1, "workspaces": [{ "workspaceId": "workspace", "mode": "dataset", "file": "openfema-dataset.json" }] }
```

and start the local workbench with `MAGENTIC_ONTOLOGY_FILE` set to that
configuration. On a work item, choose **Declaration**, paste one `id` from
the CSV and read it as a reference; the snapshot records the dataset name,
retrieval time and hash. `list_ontology_links` with link type `state` returns
the one State the declaration belongs to.

## What stops ingestion

A column the blueprint does not list, a missing column, a non integer
`disasterNumber`, a `declarationDate` that is not ISO 8601, an empty `id`, a
duplicate `id`, or a `state` code that is not in `State.csv`. Each message
names the file, row and column. Fix the data or the blueprint and run again;
nothing partial is written.

## Moving to Foundry

Create the two object types from `blueprint.json` in Ontology Manager, back
`Declaration` with the downloaded CSV and `State` with `State.csv`, then
switch the connection to `"mode": "foundry"` as described in
`workbench/ONTOLOGY.md`. The adapter, tools, reference form and tests are the
same in both modes.

Source: [OpenFEMA Disaster Declarations Summaries v2](https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2).
