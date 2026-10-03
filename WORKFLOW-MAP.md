# Development workflow and Jira automation map

Status: persistent workflows and supervised phase bots implemented; external
connectors, unattended orchestration and live Jira remain planned.
This map covers general development: software, prototypes, research, documents,
and process improvements. Stage names and responsibilities are configurable.
This map also defines a future Jira automation agent inside the workflow system.
It is not a request to file a Jira issue. See
[architecture and verification](workbench/ARCHITECTURE.md) for the current build
and test workflow. Desktop packaging is deferred until the backend layers mature.
Repository: nsirivolu27/Magentic.AI.

Magentic is an open-source development workflow automation platform. Agents
perform stages of work; configurables expose the controls that steer their
LLM use, tool access, context, handoffs, and execution limits. The portal and
standalone MCP clients should use the same permitted integration capabilities.

## Implemented foundation

The portal now supports configurable ordered stages, versioned configuration
snapshots, manual outputs, distinct-reviewer gates, pause/resume, block/retry,
and execution history. The independent `/api/pipeline-mcp` endpoint exposes the
same run operations to authenticated MCP clients. A shared deterministic mapper
generates Jira previews; no Jira request is sent.

The local application now saves workspaces and runs, attaches Git repositories,
runs bounded planner/coder/reviewer/validator bots, and exposes proposals and
check evidence on the bot timeline. Tool allowlists and call limits are saved
per phase and enforced before MCP dispatch. Standalone clients can inspect
capabilities and scoped attempts. The separate demo remains in memory.

## Delivery boundary

Live Jira delivery, external MCP connector execution, unattended scheduling,
provider usage accounting and independent reviewer enrollment are not yet
implemented. The Jira responsibilities and acceptance criteria below remain a
target architecture, not a claim that those integrations are live.

Magentic owns its local workflow configuration, runs, stage evidence and bot
attempts. LNKZ continues to own relay credentials, conversation storage and
external connectors behind its REST API. The workspace store does not replace
the relay's conversation store. No bot output counts as a human approval.

## Jira automation agent

The Jira automation agent is a reusable participant across the engineering
pipeline. Stage agents provide structured results; the Jira agent translates
those results into permitted Jira actions using MCP tools. The orchestrator
owns stage progression, and the connector enforces authorization.

Example handoff:

User request -> planning agent -> Jira agent creates or links work items ->
coding agent -> Jira agent links the pull request and updates progress ->
testing/review agents -> Jira agent records evidence and blockers ->
approved release -> Jira agent records completion.

| Capability | Input from the workflow | Result returned to the workflow |
| --- | --- | --- |
| Create or reuse tickets | Approved requirements, project mapping, existing issue reference | Issue key and URL, linked to the run |
| Break work into linked items | Approved plan and task breakdown | Parent/child or dependency links, when supported by the project |
| Update progress | Stage started, blocked, reviewed, or completed event | Confirmed field changes or valid status transition |
| Keep evidence attached | Plan, branch, PR, test, review, or release references | Jira links and concise progress comments |
| Read changes back | Eligible Jira event or explicit issue lookup | Normalized issue context for the next stage |
| Report failure | Rejected action, missing information, or connector error | Structured failure and recovery state; no false success |

Inputs include workspace ID, run ID, stage ID, event ID, configuration version,
issue reference, artifact references, and any required approval. Outputs include
the issue key/URL, confirmed action, correlation ID, and success, blocked,
failed, or awaiting-approval status. Downstream stages consume that structured
result rather than inferring success from an LLM's prose.

Users configure project/issue-type mappings, allowed fields and transitions,
trigger conditions, comment frequency, model/instructions, context, tool access,
budgets, retries, and human checkpoints. Existing automation permissions govern
routine updates; configured gates govern actions requiring review.

The same permitted Jira MCP capabilities should also be available to standalone
clients. A standalone client does not need to run the complete Magentic pipeline.
This is a planned interface, not a claim that the current three workspace MCP
tools already create or modify Jira issues.

## Pipeline-to-Jira mapping

The Jira automation column is owned by the shared Jira agent. Other stage
agents supply the events and artifacts; they do not each implement a Jira
connector. Jira status names below are examples, not required project statuses. An admin
maps each stage to the target project's actual fields and valid transitions.

| Stage | Future agent / current executor | Trigger and input | Jira automation | Output / handoff | Gate |
| --- | --- | --- | --- | --- | --- |
| Intake | Intake agent / user submission | Feature request or eligible Jira issue | Create and link a ticket when none exists; reuse the source issue when it does | Issue key, requirements, acceptance criteria | Configured project and create permission |
| Planning | Planning agent / manual completion | Intake complete | Map to a planning status; add an approved plan summary | Versioned plan and open questions | Required clarifications resolved |
| Design | Architecture agent / manual completion | Plan accepted | Link design artifacts; optionally create linked work items | Design decisions, dependencies, implementation tasks | Human checkpoint when configured |
| Implementation | Coding agent / test executor | Design accepted | Map to an in-progress status; link branch or pull request | Change reference and implementation summary | Repository and tool permissions |
| Validation | Testing agent / test executor | Change ready | Attach or link test results; record blockers and failures | Check results and failure details | Required checks pass |
| Review | Review agent / manual review | Validation passed | Map to review status; post approved findings and review links | Reviewer decision and revision requests | Required human approval |
| Release | Release agent / manual confirmation | Approved change | Link release evidence; transition to done only after confirmed delivery | Delivery reference and completion summary | Separate authorization for merge/deployment |

A blocked or failed stage records its reason in the run and optionally updates
Jira according to the configured mapping. It must not mark the issue done.
A Jira automation event generated by this run must not start the same run again.

## Configurables and monitoring

| Area | Configuration | Visible evidence |
| --- | --- | --- |
| Pipeline | Stage IDs, ordering, dependencies, input/output contracts, handoff rules | Stage status, artifact references, execution history |
| LLM direction | Model/provider, instructions, context sources, output schema, explicit fallback policy | Model used and configuration version |
| Tool access | MCP servers, allowed tools, workspace/project scope, read/write permissions | Tool name, action outcome, approval reference |
| Budgets | Token/cost limits, timeouts, retries, maximum tool calls | Reported tokens, estimated cost, duration, limit events |
| Jira mapping | Project, issue type, field mapping, transition IDs, allowed automation actions | Issue key, Jira result, correlation ID, sanitized errors |
| Human review | Checkpoints, eligible reviewers, actions requiring approval | Approval decision and actor |

Show unavailable token/cost data as unknown rather than zero. Identify estimated
costs and their pricing source/version. Logs expose execution events, not private
model reasoning, credentials, or unrestricted prompt contents. Configuration
versions must remain linked to the runs that used them.

## Future implementation scope: Jira automation agent

### Problem

The current portal coordinates manual development handoffs and Jira previews,
but does not execute complete agents or keep a live Jira project aligned with
progress. Users need visible, versioned controls for LLM direction and usage,
plus Jira automation that can be reused through standalone MCP.

### Scope

- Define and validate pipeline stages, handoff contracts, human gates, and
  configurable model/tool/usage controls using the mapping above.
- Map Magentic workflow events to a chosen Jira project's fields and valid
  transitions; do not assume universal status names.
- Define the Jira agent as a configurable pipeline participant with explicit
  inputs, outputs, handoffs, tool permissions, and observable execution.
- Support authorized ticket creation, reading, field updates, comments, links,
  and transitions through the existing connector ownership boundary.
- Allow a Jira issue or an explicit user request to start a run, with configurable
  trigger conditions and a stable link between Jira issue and workflow run.
- Provide an action preview for Jira writes, with execution governed by the
  workspace's explicit automation permissions and approval policy.
- Expose the integration to the portal and standalone MCP clients with consistent
  schemas and authorization. Preserve existing exported names and behavior.
- Record stage events, model usage, duration, tool outcomes, configuration version,
  and Jira correlation IDs in an inspectable run history.
- Use manual and test executors for this phase. Implement complete agents later.

### Acceptance criteria

1. A workspace can validate, save, version, and inspect a pipeline configuration
   containing stage, LLM, tool, budget, handoff, and Jira mapping settings.
2. Unknown configuration keys, missing required fields, invalid stage references,
   and unsupported Jira mappings fail with actionable field-specific errors.
3. An authorized intake action creates exactly one Jira issue and stores the issue
   key on the run. Intake from an existing issue reuses it. Duplicate events or
   retries do not create duplicate issues or comments; uncertain write outcomes
   are reconciled before retrying.
4. Manual or test-executor stage events exercise the full mapped pipeline and
   produce only valid, permitted Jira transitions. Failed checks or missing
   approvals prevent progression to release/done.
5. Jira authentication failures, rate limits, outages, and invalid transitions
   leave a visible recoverable run state, preserve the last confirmed result,
   and never report a write as successful without confirmation.
6. Jira-originated events are authenticated, deduplicated, and protected against
   automation loops. Repository content and issue text cannot grant tool access.
7. Portal and standalone MCP clients can discover and invoke the same authorized
   Jira capabilities. Cross-workspace/project access and unauthorized writes
   are refused, and secrets never appear in tool results or monitoring.
8. Usage monitoring shows available input/output token counts, estimated costs,
   duration, failures, retries, and tool calls per stage/model/run. Unknown
   measurements are explicitly identified.
9. Changes preserve content-hash approval checks and self-approval restrictions.
   Tests exercise duplicate delivery, failed writes, workspace isolation,
   approval gates, and an end-to-end synthetic Jira workflow.
10. Document one configuration example, one portal journey, and one standalone
    MCP journey, clearly identifying manual/test stages and future agents.

### Deferred work

- Complete Jira automation agent and its live connector integration.
- Complete autonomous planning, coding, testing, review, and release agents.
- Automatic merges or deployments without their own explicit authorization.
- Agent marketplace, payments, or claims of live Jira/cloud-model readiness.

### Dependencies and follow-up

- When implementation begins, choose a Jira project and inspect its available
  issue types, fields, workflow
  transitions, and connector permissions before implementing the mapping.
- Verify the relay connector's actual capabilities and implement missing REST
  contracts there; do not assume prepare_publish sends an issue.
- Fix the separately identified hosted MCP stale-catalog and Origin-validation
  issues before enabling production standalone access. Those fixes are outside
  this document's initial mapping scope and require their own tracked follow-up.
- Break complete agent execution into later tickets linked to this foundation.
