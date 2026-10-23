# Magentic.AI

**Supervised AI workflow automation for company teams.**

Magentic helps teams turn internal documents and tasks into reviewed, traceable outputs. Employees work with configured agents in a shared workspace; the server controls tool access, records evidence, and checks approvals before a gated handoff.

[Demo & presentation](docs/site/README.md) · [Architecture](workbench/ARCHITECTURE.md) · [Documentation](docs/README.md)

## What the project demonstrates

- **Company workspaces:** organization sign-in, team roles, shared agents, and work queues.
- **Agent workflows:** configure instructions, models, reference material, tools, and test cases.
- **Reviewed automation:** drafts, source evidence, independent approvals, and recorded handoffs.
- **MCP integration:** workspace tools available to agents and compatible external clients.

Approvals bind to the reviewed content. Editing that content invalidates its approvals.

## Stack

| Layer | Technologies and use |
| --- | --- |
| Frontend | TypeScript, HTML/CSS, React — workspace views and interactive work queues |
| Backend | Node.js 22, TypeScript, Zod — APIs, workflow rules, and validation |
| Agents | MCP SDK, Ollama, configured model APIs — model execution and granted tools |
| Identity | Clerk Organizations — company membership and workspace roles |
| Storage & tooling | Atomic JSON files, pnpm, esbuild, Node tests, Playwright |

## Security

- **Implemented:** company roles, workspace access checks, agent tool allowlists, request validation, and content-bound approval gates.
- **AWS deployment design:** IAM/STS, private VPC networking, WAF, KMS/Secrets Manager, CloudTrail/CloudWatch, threat detection, vulnerability scanning, and tested recovery. These cloud controls are proposed, not yet deployed.
- **Evidence and rollout checks:** [Security controls and AWS architecture](docs/aws-security.md).

## Example company workflow

**Documentation request → SOP reference → agent draft → evidence review → independent approval → handoff**

An employee asks how to request repository access. The agent reads the attached SOP and drafts a cited answer. Reviewers check the output before the workflow advances; the agent does not grant access.

## Run the demo

Requires Node.js 22.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build:workbench
corepack pnpm demo:agents
```

Open the printed URL. The demo uses synthetic data and a scripted model with real workflow and approval checks.

For the presentation website: `node docs/site/serve.mjs --port=4184`.

## Status

Working prototype. Latest local verification, October 22, 2026: **801 passed, 0 failed, 1 skipped**; typecheck and both builds passed.

Live providers need configuration. Model Studio training is simulated, and storage currently assumes a single writer. Production scaling and compliance validation remain future work.
