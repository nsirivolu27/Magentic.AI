# Documentation

Start with the [repository README](../README.md) for the engineering summary, stack, company workflow, and latest recorded verification.

## Run and use the workspace

| Guide | Use it for |
| --- | --- |
| [Presentation website](site/README.md) | Guided sample workflow, frontend/backend explanation and submission checklist |
| [Local workspace](../workbench/LOCAL-MODE.md) | Saved local state and execution boundaries |
| [Workspace deployments](workspace-deployments.md) | Current workflow checks, release bindings, rollout prerequisites and report export |
| [Accounts and company workspaces](account-portal.md#company-workspaces) | Clerk Organizations, role mapping, workspace isolation, and company launch settings |
| [Agent Studio demonstration](agent-studio-demo.md) | A repeatable agent test and review walkthrough |
| [Operations UI](operations-ui.md) | Work queues, evidence, and review interactions |
| [Chat and model connections](universal-chat.md) | Provider setup and chat usage controls |
| [VS Code extension](../extensions/vscode/README.md) | Use Magentic from an editor |

The current onboarding page is `/#/onboarding`. It shows the selected workspace's roles and saved setup facts. A recorded configuration is not proof of model connectivity, quality, or approval.

## Integrations

| Guide | Use it for |
| --- | --- |
| [Ontology and Foundry](../workbench/ONTOLOGY.md) | Synthetic examples, validated CSV ingestion, local datasets, and configured Foundry reads |
| [Zenfluence](zenfluence.md) | Jira and Confluence evidence snapshots |
| [Company Slack](slack.md) | Reviewed audit summaries, team updates and delivery receipts |
| [Automation units](automation-units.md) | Reviewed AWS Lambda invocation and delivery receipts |
| [Relay adapter](relay-adapter.md) | The original standalone conversation-relay MCP interface |
| [Relay catalog](catalog.md) | Hosted definitions and relay MCP endpoints |
| [Local relay setup](local.md) | Running the separate relay and its adapter; not the workspace quick start |
| [LangChain](langchain.md) | Optional model/adapter integration |
| [Adapter deployment](../deploy/README.md) | Relay-adapter containers and hosting boundaries |

External services need real credentials and permissions. Synthetic examples and fixture tests do not prove a live connection.

## Implementation and design

- [Security controls and AWS design](aws-security.md): implemented application controls, proposed cloud protections and verification evidence.
- [Audit package](audit-package.md): one run's chain of custody as a file, with offline hash verification (`audit:verify`).
- [Handling marking](handling-marking.md): the agency's marking on every page and every export, from one setting.
- [Federal readiness](federal-readiness.md): product behaviour mapped to NIST SP 800-53 control families, Section 508 notes, data handling and known gaps.
- [Architecture and verification](../workbench/ARCHITECTURE.md): engine and MCP design; early milestone descriptions are historical where newer company or packaging code supersedes them.
- [Bot timeline](../workbench/BOT-TIMELINE.md): repository execution and evidence.
- [Design tokens](design-tokens.md) and [UI components](ui-components.md): interface conventions.
- [Workflow map](workflow-map.md): design direction, including work originally marked as planned.
- [Internal documentation plan](internal-documentation-plan.md): use-case planning.
- [Development handoff](assistant-handoff.md): a dated baseline, not the status of the current working tree.
- [Challenge presentation](site/index.html): presentation material, separate from the engineering README.
- [Previous product narrative](product-overview.md): the earlier README retained with its historical measurements and roadmap.

When a dated note and current source differ, inspect the implementation and tests before treating a capability as available.
