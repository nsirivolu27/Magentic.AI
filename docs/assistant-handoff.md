# Magentic.AI development handoff

Repository: https://github.com/nsirivolu27/Magentic.AI  
Branch to start from: `main`  
Recorded on: 2026-10-11  
Verified implementation baseline: `5a7a406564ef7a139ea3e462aa6177a283c40d28`

Read `AGENTS.md` before making changes. This file records the completed work
and verification, not permission for a new deployment or production action.

## Completed and pushed

- PR #5 is merged: the workbench is an internal-operator operations interface,
  retaining the approved layout with Accenture purple (`#A100FF`), a
  near-black violet sidebar, and explicit operational states.
- The work queue, desktop/mobile navigation, keyboard/focus behavior,
  automated accessibility checks, and local/demo disclosures are implemented.
- Stage settings save instructions, context, staffing, and review gates.
  Unsaved checked/unchecked drafts survive navigation and refresh; existing
  workflow runs retain their frozen configuration.
- Scheduled stage prompts receive the exact saved reference excerpts as
  untrusted JSON data, with requested context. URLs are not treated as fetched
  evidence, and references cannot grant tools or change approval requirements.
- Oversized HTTP uploads retain the one-million-byte limit, return 413, and
  close the connection without Node 22 teardown cancellations.
- PR #6 is merged: optional LangChain peers are aligned, Google/Azure loader
  coverage is added, installed-package import failures are not silently
  skipped, and strict peer checking is enabled in `.npmrc`.
- Security dependency updates are included: MCP SDK 1.32.1, proxy-addr 2.0.8,
  fast-uri 3.1.8, ip-address 10.7.3, and esbuild 0.28.2. No dependency overrides
  were needed.

The 30 changed source files across the interface and dependency work were
compared with the merged GitHub tree and matched. Local dirty status in the
earlier sandbox checkouts was a result of publishing through GitHub's Git Data
API, not unpublished application changes.

## Verified results

- Post-merge GitHub CI on the baseline: 553 tests, 551 passed, two skipped,
  zero failures and zero cancellations; installation, typecheck, and root
  build passed.
- Local root and workbench builds passed with the patched dependencies.
- All six browser scenarios passed, including Accenture colors, stage
  settings, queue/deep links, desktop/mobile checks, and local identity.
- Both full and production package audits reported zero known vulnerabilities
  after the dependency updates. This is an audit snapshot, not a guarantee
  of complete application security.
- No deployment or live model-provider/agency-service test was performed.

An optional high/critical audit gate could not be published: GitHub rejected
the tree containing the workflow-file edit, while accepting the dependency
changes without it. The edit was removed. The existing CI workflow is
unchanged and does **not** include a dependency-audit gate.

Automated accessibility checks are not Section 508 certification. There is no
claim of FedRAMP, ATO, FISMA, or production agency readiness.

## Continue development

Use Node 22 and the pinned pnpm 10.26.1. Start with a fresh checkout of `main`,
not an earlier feature branch.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm build:workbench
corepack pnpm audit
corepack pnpm audit --prod
```

For a synthetic local preview:

```sh
corepack pnpm demo:workbench
```

For browser checks, install the browser as documented in
`docs/operations-ui.md`, then run `corepack pnpm test:ui`.

Preserve the approved interface unless a new request changes it. Keep the
Magentic adapter/LNKZ relay boundary, backend authorization, body limit,
frozen-run configuration, reference-data treatment, and human-review gates.
Never commit credentials, tokens, private runtime records, or generated output.

## ChatGPT / Codex handoff

For continuing code development, authorize this repository in Codex and start
from `main`. A suitable first instruction is:

> Open nsirivolu27/Magentic.AI on main. Read AGENTS.md,
> docs/assistant-handoff.md, docs/operations-ui.md, and LANGCHAIN.md.
> The Accenture-purple operator interface, stage/reference fixes, aligned
> providers, and security updates are already merged. Preserve the approved
> layout and existing authorization/review controls. Inspect current repository
> state before changing anything, and verify the requested changes using the
> pinned pnpm scripts. Do not deploy without explicit approval.

OpenAI documents its ChatGPT GitHub app as read-only for repository analysis;
it directs code editing and pushing to Codex:
https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt

Using Magentic's MCP tools inside ChatGPT is a **separate** integration task.
No ChatGPT MCP connection or public endpoint was deployed or verified in this
work. The hosted relay adapter uses Streamable HTTP at `/mcp` or an agent
endpoint, with a caller-supplied relay bearer key; see the hosting section of
`README.md`. The local workspace `/api/mcp` is loopback-bound and uses a
different workspace token. Do not expose it or substitute credentials between
these surfaces. Confirm ChatGPT's current remote-endpoint and authentication
requirements before configuring a connection.
