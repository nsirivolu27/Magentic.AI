# Federal readiness

How Magentic's behaviour lines up with the control families federal
delivery teams are asked about. This is a map from product behaviour to
control intent, written so an assessor can check each line against the code
and tests named. It is not a claim of compliance with any framework; an
authorization decision belongs to the agency and its assessors.

Families follow NIST SP 800-53 Rev. 5 naming.

| Family | What Magentic does | Where |
|---|---|---|
| AC, Access control | Every API call is checked for current membership of the workspace it names. Roles (admin, author, approver) gate every command on the server, not only in the interface. | `workbench/server.ts`, `registry/roles.ts`, `tests/ontology.test.ts` (membership paths) |
| AC-5, Separation of duties | The run owner and the output author cannot approve their own stage. A gated stage needs the configured number of independent approvals. | `workbench/pipeline.ts`, `tests/workspace-focus.test.ts` |
| AU, Audit and accountability | Every run keeps an ordered event log with actor, time, stage and action. Approvals record the hash they signed. The audit package exports the whole record with a package hash, and `audit:verify` checks it offline. | `workbench/audit-package.ts`, `docs/audit-package.md`, `tests/audit-package.test.ts` |
| AU-9, Protection of audit information | The definition audit log is append only; nothing updates or deletes an entry. A changed output invalidates the signatures on it. | `registry/audit.ts`, `workbench/pipeline.ts` |
| CM, Configuration management | Every request body, stored document and configuration file is parsed with a strict schema; unknown fields are refused. A workspace folder carries a storage version and a newer version is refused with a message instead of being rewritten. | `workbench/workspace-directory.ts`, `tests/first-run.test.ts` |
| CM-7, Least functionality | The local application listens on loopback only. Agents get an explicit tool allowlist, call budget and timeout, enforced by the server. | `workbench/bot-worker.ts`, `workbench/agent-configurables.ts`, `tests/agent-assignment-gate.test.ts` |
| IA, Identification and authentication | Credentials are referenced by setting name and never stored, logged or shown. The company server uses sign in with per tenant storage; the local app has a session claimed by the first window. | `env.ts`, `workbench/zenfluence.ts`, `workbench/ontology.ts` |
| SA-11, Developer testing | Agents are tested like code: a saved test case is bound to the hash of the agent configuration, and an agent version without a passing test cannot be assigned to a stage. 806 automated tests run on every change. | `workbench/agent-tests-model.ts`, `tests/agent-tests.test.ts` |
| SC-7, Boundary protection | Outbound reads (Atlassian, Foundry, update feed) are https only, size capped, time capped, redirects refused, and checked against what was asked for. Connectors never write to the source system. | `workbench/zenfluence.ts`, `workbench/ontology.ts`, `workbench/desktop/update.ts` |
| SC-28, Protection of information at rest | A workspace is a folder of plain documents under the user's own account, written atomically. Uninstall keeps it. Disk encryption is the operating system's job and is documented as such. | `workbench/workspace-directory.ts`, `workbench/desktop/README.txt` |
| SI-7, Software and information integrity | The Windows package installs from a SHA256 manifest and verifies every file. Reference snapshots carry a content hash. Text imported from Atlassian is scanned for credential patterns and refused when one is found. | `workbench/desktop/Install.ps1`, `workbench/studio/dataset.ts` (`findSecretKinds`), `workbench/zenfluence.ts` |
| SI-10, Information input validation | Zod schemas at every boundary; imported source text is treated as untrusted and never as instructions. | `workbench/*.ts` schemas, `workbench/ONTOLOGY.md` |

## Section 508

Contrast is measured on the rendered pages, lowest ratio 5.0:1. Every route
is checked at 360 px, every control has a visible keyboard focus state, and
reduced motion is respected. Status is carried by a mark as well as a colour.
See `docs/design-tokens.md` and `docs/ui-components.md`.

## Data handling

- Handling marking: one setting (`MAGENTIC_HANDLING_MARKING`) puts the
  agency's marking, for example `CUI//SP-PRVCY`, on every page and into every
  audit package. See `handling-marking.md`.
- No cloud by default. Nothing leaves the machine unless a model provider or
  a read only connector is configured by the operator.
- Model providers receive selected excerpts when a stage runs; the excerpts
  are listed in the run's evidence.
- Public datasets enter through `ontology:ingest`, which records each source
  file's hash and row count, so a snapshot can be traced to its input.

## Known gaps

- No PIV or CAC sign in; the company server uses the configured identity
  provider.
- The package is not code signed yet.
- Audit log export is per run; a workspace wide export is not built.
- FIPS validated cryptography depends on the Node build in use; the
  application uses SHA-256 through Node's crypto module.
