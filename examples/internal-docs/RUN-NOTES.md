# DOCS-001 run notes

Recorded 2026-09-29 UTC (2026-09-28 local evening).

## Automated checks

- Typecheck passed.
- Full suite: 512 tests, 509 passed, 0 failed, 3 skipped, 0 cancelled.
- Server and workbench builds passed.
- Four new scenario tests verify template review boundaries, attached source
  handoff, immutable run inputs, stage context, accepted-output handoff,
  duplicate job prevention, distinct reviewers and an unfetched-link warning.
- These tests use a deterministic model double. They prove orchestration and
  prompt construction, not the correctness of generated answers.

## Real local model attempt

Model: `qwen2.5-coder:7b` through the configured Ollama integration.

The source-check stage timed out under the harness's 180-second limit. The job
reported `The model did not answer in time.` after approximately 189 seconds
including setup and cancellation. No draft was produced. The run remained at
**Check the sources / active**; later model stages did not run. No approval,
publication, access change or Jira delivery occurred.

This is a failed live execution, not a failed factual-answer score. The output
does not identify whether model warm-up, resource pressure or inference time
caused the delay. Investigate readiness and response time before retrying or
changing the prompt/model budget.

Raw local evidence is at
`../../../.tmp/internal-docs-case/live/live-result.json` relative to this folder.
It includes the frozen fictional sources, job state and simulated request-owner
handoff. It is a generated artifact and is not part of the source test fixture.

## Model Studio walkthrough

Project: **Internal docs — Employee onboarding**.

Three separate synthetic reference examples were saved and validated. They
teach citing a document owner, avoiding unsupported access assumptions, and
reporting missing documentation metadata. The held-out Atlas access question
is not one of those examples. The reference set is available as
`reference-examples.jsonl`.

No training job, model-quality evaluation, release or approved assistant was
created for this project. Three examples do not meet the recipe's coverage
target. Validation establishes format and credential-check results only.

Next: get the bounded live run to produce drafts, score those drafts against
the eight cases in `scenario.json`, then test source retrieval and permission
boundaries before connecting real organizational documents.
