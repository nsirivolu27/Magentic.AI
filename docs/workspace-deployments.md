# Workspace deployment preparation

Open **Workspace → Controls → Workflow checks** (`#/workspace?controls=deployment`). The old `#/deployments` address opens these same controls. This view
inspects the current primary workflow, not saved runs or every library agent.

1. Resolve blocked stages in Workflows, Assistants or Connections.
2. Verify the release and the model named on each assistant stage.
3. Run one supervised task with real references and the intended provider.
4. Review the output and test independent handoff approval.
5. Download the report for the operator responsible for rollout.

The server resolves each assistant through the existing Model Studio release
gate on every workspace refresh and report download. Membership is checked
before these reads. No client-supplied workspace, approval or status is trusted.
A retired or disabled assistant appears blocked on the next check.

`GET /api/deployment-report` returns the report for the authenticated workspace.
It is a read, available to existing workspace members, and starts no jobs.
The report contains workflow version and hash, stage summaries, current release
identifiers and checks. It omits prompts, raw references, credentials and local
repository paths. It is not an executable manifest or an approval certificate.

A configured connection is not a successful model call. The page always
requires live validation, including when the configuration checks find no
blocker. Development artifacts remain labeled: they contain no trained weights.
Repository execution remains unavailable in company mode until isolated workers
exist. Readiness does not bypass assignment tests or runtime approval gates.

## Running the company application

Use the existing [company setup](account-portal.md#company-workspaces) for Clerk
identity, organization membership, provider configuration and persistent data.
The company server uses the company workspace directory; do not expose the
development watcher or use its local session as company authentication.

The [container deployment guide](../deploy/README.md) currently packages only
the relay adapter. It does not package this company application. A hosted
company rollout still needs an explicit design for TLS, backups, durable shared
storage, worker isolation, health checks and rollback.

The next implementation slice can turn a verified report into a versioned
deployment request with an operator-owned target, approval and rollout history.
This page does not claim those features exist today.
