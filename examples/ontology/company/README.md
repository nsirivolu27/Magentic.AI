# Company automation ontology

Design and synthetic seed data for a future Palantir Foundry environment. No Foundry account, dataset, ontology, or connection has been created by these files. `blueprint.json` is a readable design specification, not an official Foundry API or import format.

## Objects and links

Company owns Workflows and Agents. A Run links to its Company, Workflow and Agent. Evidence and Approval link to their Company and Run. IDs are immutable; names are labels. Each non-company row carries companyId for lineage and validation, not authorization.

The CSV files contain one synthetic example each. The approval is pending, the agent is a draft, and hashes are explicitly unverified placeholders. Never use these records as release evidence. Magentic remains authoritative for membership, content hashes, signatures and release gates; importing an Approval object cannot approve a release.

## Ingest locally today

`blueprint.json` is also the input for `ontology:ingest`, which checks the six CSV files against it and writes one dataset file that the workbench reads in `"mode": "dataset"`. `scopeProperty` is `companyId`, so a link between two rows with different companies stops the run. See the ingestion section in `workbench/ONTOLOGY.md`.

## Create in Foundry when an environment is available

1. Create a project with access limited to the intended company. Upload the six CSV files as separate synthetic backing datasets. For actual use, replace them with authorized company datasets and preserve source lineage.
2. In Ontology Manager, create the six object types from blueprint.json. Map their backing datasets, primary keys and property types. The timestamp on an undecided Approval is nullable.
3. Create each many-to-one link using the listed foreignKey and the target object's primaryKey. Use the exact API names from the blueprint. Check that every link stays within the same company.
4. Apply Foundry dataset/object permissions and use an identity restricted to this company's permitted data. A companyId property or a client-side filter does not provide tenant isolation. If an ontology contains multiple companies, use company-restricted permissions or separate backing data/identities before enabling it here.
5. Copy connection.example.json to private operator configuration. Replace the workspace ID with the ID returned by Magentic's company setup, the Foundry origin with your environment, and ontology with its real RID/API name. Keep only the properties and links agents need.
6. Put the scoped bearer token in MAGENTIC_FOUNDRY_TOKEN_COMPANY on the server. Set MAGENTIC_ONTOLOGY_FILE to the private configuration path, then restart company:workbench. Do not put tokens in JSON or commit them. Credentials belong to the server operator; ordinary members cannot choose an endpoint or token.
7. Sign in as a company member. Read one object through the Ontology reference form or the workspace MCP tools. Verify its source and company before attaching it to a work item. Test a second company and confirm the first company's connection is unavailable.

## Current boundary

The connector exposes catalog, object listing, individual reads and configured links. It projects allowlisted properties, bounds pages and responses, and never follows redirects. Reference snapshots carry the source, retrieval time and a hash of the snapshot. They are evidence, not instructions or automatic proof of accuracy.

The scheduler can use references explicitly attached to a workflow. It does not continuously synchronize Foundry or execute Foundry Actions. Writeback, ingestion jobs, change subscriptions and company-specific OAuth require separate implementation. This ontology complements the application's persistence; it does not replace its account, workflow or approval stores.

Official guidance: [Ontology overview](https://www.palantir.com/docs/foundry/ontology/overview/), [Ontology Manager](https://www.palantir.com/docs/foundry/ontology-manager/overview/).
