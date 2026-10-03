# Internal documentation: next build plan

## First usable workflow

An employee asks a question. Magentic finds documents they can access, identifies
the applicable version, drafts an answer with citations, and escalates gaps to
the documentation owner. The current slice accepts attached excerpts and passes
them through staged agents. Source retrieval and answer-quality evaluation still
need implementation. Studio's development evaluator measures dataset readiness,
not factual correctness, and its development provider trains no model.

## Build order

| Priority | Slice | Acceptance evidence |
| --- | --- | --- |
| 0 | Model readiness and recovery: check that the selected model is installed and responsive before starting; show warm-up, timeout and retry states | The DOCS-001 local run completes all three draft stages within a declared budget; a timeout preserves the question and sources and offers retry or manual completion; never silently switch providers |
| 1 | Document library: start with a selected local Markdown folder; track document ID, section, owner, version, status and content hash | A changed policy produces a new version; archived material is visibly marked; a deleted source cannot silently support a fresh answer |
| 2 | Permission-aware retrieval behind read-only MCP tools: search documents and read an authorized section | Two users with different access receive different allowed results; blocked titles/snippets never reach model context; search and reads enforce access independently |
| 3 | Evidence validation: structured claim-to-source references, source-version checks, unsupported-claim and missing-answer labels | The held-out DOCS-001 cases detect wrong approval order, stale timing, fabricated citations and contractor exceptions; manual reviewers verify automated judgments |
| 4 | Review inbox: show the question, draft, cited passages, conflicts, owner and next action together | A nontechnical reviewer can inspect and return or approve a draft; authors cannot approve their own output; the signature binds to the reviewed content |
| 5 | Documentation follow-ups: draft Jira work with an owner, source versions and evidence | Preview first; exact-payload authorization, idempotency and delivery receipts are required before external writes; uncertain delivery is reconciled before retrying |
| 6 | Source change notifications and answer expiry | Changing an approved policy marks affected answers for recheck; retired content cannot remain silently authoritative |

Implement and prove each slice before adding the next connector. Preserve the
small stage UI: **what happens, what evidence was used, who reviews, what next**.
Keep provider tuning, schema details and integration configuration in advanced
settings. Retrieval facts should remain outside model weights so policy changes
do not require retraining. Consider fine-tuning later for writing style and
consistent output structure, using separately curated training and test sets.

## Other useful workflows using the same foundation

| Use case | Agent work | Human boundary |
| --- | --- | --- |
| New-hire onboarding | Assemble a role-specific reading list and answer setup questions | Manager confirms role and access; agent cannot grant access |
| Support runbook assistant | Find the right troubleshooting sequence and flag missing conditions | Operator authorizes system changes and escalation |
| Incident handover | Assemble a sourced timeline, separate confirmed facts from hypotheses, draft follow-ups | Incident owner verifies severity, cause and external communications |
| Documentation maintenance | Compare a changed feature with its guides and propose updates | Documentation owner approves edits and publication |
| Internal policy comparison | Compare versions and list changed procedures and open ambiguities | Policy owner resolves conflicts; agent cannot create policy |

## Evaluation and release decisions

Use distinct training and held-out questions. Include missing sources, policy
conflicts, expired versions, ambiguous questions, restricted documents and
prompt-injection excerpts. Record the model, prompt/template version, source
hashes, latency and review outcome with each run. Repeat after model or source
changes; one passing local run is insufficient for release.

For the small release suite, require every citation to resolve to the exact
visible source version, no restricted-source leakage, no unsupported access
exception, and all consequential policy claims supported. Track task completion,
reviewer correction rate and latency separately. Do not turn these targets into
claimed performance until measured on a representative evaluation set.

## Current limits

- Material excerpts are bounded snapshots, not a connected knowledge base.
- Scheduled agents currently draft text; they do not retrieve through MCP tools.
- Citation correctness and resistance to source instructions require evaluation;
  the prompt alone cannot enforce either.
- The live example uses test assistant identities and a stock local model.
- The demo server holds project state in memory. Restarting it loses demo data.
- A running server must reload the rebuilt scheduler before attached excerpts
  reach agents there. The isolated live harness exercises the updated scheduler.
- No deployment or third-party connector setup is included in this slice.

The first live attempt is recorded in
[the test notes](../examples/internal-docs/RUN-NOTES.md). It timed out during
source checking, so it provides no evidence of answer quality yet.
