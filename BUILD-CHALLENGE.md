# Magentic: Build Challenge submission

Virginia Tech x Accenture Federal Services Build Challenge. Final projects and
pitches on November 20, 2026. Repository: nsirivolu27/Magentic.AI, branch
`codex/published-main-preview`.

This document is the reading guide for reviewers: what the product is, what
works today, the engineering decisions behind it, how it is built and
verified, and what is left before the pitch. Every claim points at a file, a
test or a ticket, so it can be checked rather than believed.

## The problem

Delivery teams in federal work are allowed to use AI only where every output
has a chain of custody: which sources it came from, who produced it, who
reviewed it, and proof that nothing changed after the review. Most AI tools
give a chat box and leave that chain to the person. Magentic puts the chain in
the software.

## What Magentic is

A supervised AI workflow workspace. A workflow is a sequence of stages
(intake, discovery, design, build, review, release). An agent can draft a
stage; a person reads the draft next to the evidence it used, edits the
handoff, and an independent reviewer signs it. Nothing advances, publishes or
trains on its own. It runs on a laptop with a local model, or against a
company server with sign in and tenant isolation. It ships as an installable
Windows application.

## What works today

| Area | What a person can do | Where to look |
|---|---|---|
| Workflows | Start a run; see per run the current stage, who is responsible, the output state and the next action | `workbench/workflow-view.ts`, `output-review.ts` |
| Output review | Read the evidence (sources read, tool calls, checks), the agent's original output, edit the handoff, see the approval state, in one grid on the Workflows page and the work item page | `workbench/output-review.ts`, `tests/output-review.test.ts` |
| Approval gates | Independent reviewer signatures over a content hash; owner and output author can never approve their own stage; a changed output invalidates the signatures | `workbench/pipeline.ts`, `tests/workspace-focus.test.ts` |
| Agent Studio | Create an agent from an honest template, grant it read only repository tools with call limits, save test cases bound to the agent's configuration hash, run them, record execution, automated checks and human review as three separate facts, assign to a stage only after a passing test | `workbench/agent-studio-view.ts`, `agent-tests.ts`, `tests/agent-assignment-gate.test.ts` |
| Model Studio | Train, evaluate, approve and assign an assistant through six stages grouped as development, live tests and release | `workbench/guided-stages.ts`, `studio-view.ts` |
| Zenfluence | Read a Jira ticket or Confluence page from the company project and attach a reviewed, hashed snapshot to a run; read only, never writes to Atlassian | `workbench/zenfluence.ts`, `docs/zenfluence.md` |
| Chat and connections | Local Ollama or provider keys; the first run explains what to set up instead of failing | `workbench/model-setup.ts`, `chat-connections-view.ts` |
| Windows application | Bundled Node runtime, Edge app window, installer with a SHA256 manifest, Apps and features entry, uninstaller that keeps data, release notes, update feed check | `workbench/desktop/` |
| Standalone MCP | The same workflow operations and read only tools for any MCP client, scoped to the workspace | `workbench/pipeline-mcp.ts`, `mcp-portal.ts` |

Size: 116 source files in the workbench, 103 test files, about 27,800 lines
across the two. Verification at the time of writing: typecheck clean, 724
tests, 718 passed, 0 failed, 6 skipped (the skipped ones need a live model),
build and workbench build clean.

## What never weakens

Enforced on the server, not only shown in the interface:

- Authentication and tenant isolation on the company server; every API call is
  checked for current membership of the workspace it names.
- Source checks: an agent that must read a source and does not is failed, and
  the evidence block shows exactly which files were read, empty or missing.
- Release signatures: approvals sign a content hash; if the content changes the
  signatures stop counting.
- Approval gates: a single local owner cannot approve their own gated stage.
- Credentials are setting names in configuration files, never values; nothing
  echoes a key back to a page or a log.
- Every limit the interface shows (tool allowlist, call budget, timeout,
  passing test before assignment) is refused by the server when a client
  skips the interface.

## Engineering decisions and trade offs

**One process, one loopback server, files on disk.** No database, no queue,
no container. A workspace is a directory of JSON documents with a storage
version and atomic writes. This keeps the Windows package to a bundled Node
runtime and a browser window, and makes "where is my data" a one line answer.
The cost is no concurrent multi user editing on the local app; the company
server handles that with per tenant storage.

**Schemas at every boundary.** Every request body, stored document and
configuration file is parsed with zod before use. Unknown fields are refused,
not ignored. This is why a configuration written by a newer version is
refused with a message instead of being silently rewritten.

**String templated views with one React component.** Pages are functions
that return HTML strings, which makes them trivial to test (render, assert on
the markup) and keeps the bundle small. The work queue, the one interactive
list with filters and search, is a React component. This was a deliberate
choice against a full framework for a product whose value is in the engine,
not the view layer.

**Honest states over optimistic ones.** Every page shows seven states
explicitly: loading, empty, error, not connected, not assigned, blocked,
awaiting approval, each with the one step that resolves it. A stopped local
model is a setup notice with the install link and the pull command, not a
red error.

**Design tokens, measured.** One token sheet (`workbench/agency.css`) carries
every colour, radius, control height and easing. Contrast is measured on the
rendered pages, not read from the sheet: the lowest ratio in the product is
5.0:1. Layout is checked at 360 px on every route and keyboard focus is
visible on every control.

**Agents are tested like code.** A saved test case is bound to the hash of
the agent configuration it was written against. Editing the agent marks the
results out of date; the agent cannot be assigned to a stage until a test
passes on the current version. Execution success, automated checks and human
review are recorded separately, because a draft can run cleanly and still be
wrong.

## How the work is run

Every change follows the same path, and the path is the point:

1. Brief: a Jira story with goal, routes touched, constraints, acceptance.
2. Plan: files, tests to add, risks, as a comment on the story.
3. Build in an isolated copy of the tree; new tests only, existing tests are
   never edited to pass.
4. Verify: `typecheck`, `test`, `build`, `build:workbench`; counts recorded.
5. Diff review: the patch is attached to the story before anything is applied.
6. Apply: every target file's hash is checked before the write and after it.
7. Verify on Windows with the same four scripts; counts recorded separately.
8. Look at it live at 1440 and 360 px; screenshots on the story.

The Jira project (KAN) holds the plan: seven delivery epics (Windows
application, design system, workflows and output review, Agent Studio, Model
Studio, Zenfluence, parked decisions) with forty stories, each with
acceptance criteria and a comment trail of what was built, what was measured
and what is still open. Decisions that need a product owner are their own
tickets, with the options written out, so nothing blocks silently.

## Testing approach

- Engine tests drive the real pipeline, approvals and bot runtime in memory;
  agent tests run the real worker against a temporary Git checkout with a
  scripted model, so a source read is a real file read.
- View tests render pages for owner, reviewer and read only viewer and assert
  on the words and controls each one may see.
- HTTP tests start the server on a random port and check membership, role
  and refusal paths with real requests.
- Package tests guard the Windows scripts (shared names, no administrator
  rights, release notes for the shipped version) because the scripts
  themselves cannot run on the test machine.
- Browser checks (route walk at 360 px, keyboard walk, contrast measurement,
  reduced motion) run against the seeded demo and are kept as scripts.

## Security posture

- Loopback only by default; the local app never opens a public listener.
- Session credential claimed by the first window; MCP credentials are per
  workspace and revocable.
- Outbound reads (Atlassian, update feed) are https only, size capped, time
  capped, redirects refused, and the response is checked against what was
  asked for (project key, space id, version).
- Imported text is scanned for credential patterns before it is stored.
- The package installer verifies every file against a SHA256 manifest and
  installs under the current user without administrator rights.

## Run it

Windows PowerShell, in the repository folder:

```
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm build:workbench
node .\workbench\dev.mjs --port=4182
```

Then open http://127.0.0.1:4182. Without Ollama the chat page explains the
setup; with it, a workflow draft runs end to end on a local model. The Windows
package is `corepack pnpm build:desktop` (Node 22.23.2), then `Install.cmd`
in the output folder.

## Known limits

- The package is not code signed yet; SmartScreen warns on first run.
- Updates are detected, not installed; uninstall and reinstall keeps data.
- Confluence reads need a Confluence space on the Atlassian site; Jira reads
  work without one.
- Email and Jira delivery from workflows remain previews.
- Reviewer enrollment on the local app is not implemented; the company server
  provides the independent reviewers.

## Before November 20

1. Windows verification of the current tree and the first installable package.
2. Live Zenfluence read against the company Jira project.
3. Update install and rollback scripts; code signing decision.
4. Pitch demo path: install, connect Ollama, run one workflow with an agent
   draft, review it, approve it with a second account, attach a Jira ticket
   as evidence.

## What this project demonstrates

- Designing a system around a non negotiable (auditable human approval) and
  keeping it intact through forty tickets of change.
- Full stack ownership: engine, HTTP API, MCP server, interface, Windows
  packaging, release pipeline, documentation.
- Verification discipline: 724 tests, measured accessibility, hash checked
  deployment of every change, counts recorded per environment.
- Product judgement: honest states, honest templates, no publish button where
  one would be a lie, decisions surfaced as tickets instead of assumed.
- Working the way a delivery team works: Jira epics and stories with
  acceptance criteria, a written plan before code, a diff before an apply.

Built by a Virginia Tech CMDA student as a one person team during the Build
Challenge. Questions and a walkthrough on request.
