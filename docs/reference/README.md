# Reference material and what it means for Magentic

Two short videos pointed at six tools. This folder keeps the parts of them that
are worth reading (text only, with their licenses) and records how each one
maps onto the architecture sections in Jira (KAN-4 and its children).

Nothing here is a dependency. Everything is an idea to be built inside the
existing engines, or a tool a person can run beside the workbench.

## What was pulled

| Folder or file | Source | License | Why it is here |
|---|---|---|---|
| `third-party/prompt-audit/` | anthropics/skills, `claude-api/shared` | Apache 2.0 | The audit procedure and pattern tables for finding instructions written for older models. |
| `third-party/task-observer/` | rebelytics/one-skill-to-rule-them-all | CC BY 4.0 | The observation log format and the signal catalogue for turning corrections into skill improvements. |
| `third-party/headroom-llms.txt` | headroomlabs-ai/headroom | Apache 2.0 | Context compression and token accounting as a local proxy. Index only; the repo is large. |
| `third-party/omniroute-llm.txt` | diegosouzapw/OmniRoute | MIT | One OpenAI compatible endpoint in front of many providers. Index only. |
| `third-party/claude-mem-how-it-works.md` | thedotmack/claude-mem | Apache 2.0 | The three layer memory search pattern: index, timeline, details. |

`claude-code-setup` is an editor plugin that inspects a repository and
recommends hooks and configuration. Nothing to vendor; the idea is recorded
below.

## Mapping to the architecture

### 1. prompt-audit → Model Studio evaluation (KAN-6, KAN-10)

An assistant is a release plus a profile's instructions, and a recipe carries
the instructions a profile starts with. Those instructions are exactly the
surface prompt-audit is written for. Two concrete additions:

- **An instruction audit metric in the readiness suite.** `studio/evaluation.ts`
  already scores record validity, uniqueness, secret hygiene and coverage.
  Add `instructionHygiene`: the greppable signals from Group 1 (density of
  MUST / NEVER / ALWAYS / CRITICAL, `STEP \d` choreography for judgment tasks,
  "think step by step", numeric output caps, retired model names). Score is
  a ratio, findings are listed on the evaluation with file and line, nothing
  is rewritten automatically.
- **A learning cycle step.** The cycle is import → validate → train →
  evaluate → release. The audit belongs inside evaluate, so a schedule that
  keeps training on a profile with cruft in its instructions stops with a
  reason a person can read.

The keep list in the audit ("context is never cruft", "fragile operations
keep exact scripts") is the rule for what the metric must not penalise.

### 2. task-observer → the learning schedule's input (KAN-10, KAN-32)

KAN-32 asks what counts as new personal content beyond files in the import
folder. task-observer answers it: corrections are the content. Its
observation log is one file per observation with frontmatter
(`id`, `title`, `status`, `skill`, `proposes_skill`), and its signal
catalogue says what is worth logging and what is not (the generalisability
test).

Where corrections already happen in Magentic:

- a person edits a scheduler draft before completing the stage (the diff is
  the correction);
- a person rejects or changes a diff the editor proposed;
- a person answers an assistant in chat with "no, do it this way".

Proposed shape: an `observations` timeline per project, written by those
three places, read by the learning cycle's import step as a dataset source
next to the import folder. A person marks an observation as "use it" before
it is imported; nothing is trained from a correction nobody confirmed.

One principle from the skill worth adopting as written: from a rule's second
failure onward, propose a barrier, not better wording. Magentic already does
this with guards on bind and start; the learning cycle should do the same
when an evaluation keeps failing on the same metric.

### 3. claude-mem → timelines and MCP search (KAN-11, KAN-13)

The three layer search (a compact index, then a timeline around a hit, then
full details for chosen ids) is a better shape for the pipeline MCP than
returning whole timelines. Add `search_timeline` and `get_timeline_entries`
to `pipeline-mcp.ts` over the existing bot attempts, scheduler jobs and
learning runs. No new store: the timelines are already on disk.

Session memory itself stays out. Personal content belongs in the training
portal's dataset, where it is validated and released, not in a side store
that bypasses the release rule.

### 4. headroom → Providers and token accounting (KAN-14)

prompt-audit's Group 4 says token accounting comes first, because without it
no cleanup can be measured. Magentic records none today. Ollama returns
`prompt_eval_count` and `eval_count` on every reply; put them on the
scheduler job, the learning run's train and evaluate steps, the chat turn
and the editor attempt. The home page can then show tokens per assistant
per week next to the agentic units table.

Compression is a person's choice, not the platform's: headroom runs as a
local proxy, so pointing the model base URL at it is enough. That needs
item 5.

### 5. OmniRoute → Providers (KAN-14)

`chat-config.ts` reads `MAGENTIC_LLM_BASE_URL`, but `editor-session.ts`
still hard codes `http://127.0.0.1:11434/api/chat`. Make every model call go
through one `modelEndpoint()` that reads the workspace setting, and accept an
OpenAI compatible `/v1/chat/completions` shape as well as Ollama's
`/api/chat`. Then OmniRoute, headroom, or a hosted provider sit in front
without a code change. The base model named on a release stays the model the
gateway is asked for.

### 6. claude-code-setup → marketplace import (KAN-15, KAN-41)

The plugin looks at a repository and recommends configuration. The
marketplace's import step should do the same for a workspace: look at what
the person has (recipes in use, workflow template, import folder contents)
and recommend a configurable from the catalogue, rather than showing a flat
list.

## Suggested order

1. Token accounting (small, unblocks measuring everything else).
2. One model endpoint setting (small, unblocks gateways and compression).
3. Instruction audit metric in the readiness suite.
4. Observations timeline feeding the learning cycle.
5. MCP timeline search.
6. Marketplace recommendations, when the marketplace exists.
