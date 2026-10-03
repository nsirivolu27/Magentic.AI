# DOCS-001: Internal documentation assistant

An employee joins a project and asks how to obtain access. The assistant must
reconcile a current access policy, an archived welcome checklist, a documentation
gap procedure, and an unverified ticket comment. All people, policies and
documents in this example are fictional.

The expected answer is: submit an Atlas Access request in the Service Portal;
include team, business reason and role; obtain manager then application-owner
approval; allow a target of two business days after both approvals. Contractor
exceptions are undocumented and must go to Identity Operations. Each statement
needs a document and section citation. An urgent release does not establish an
exception.

## The workflow

| Stage | Who works | Input | Output and boundary |
| --- | --- | --- | --- |
| Ask a question | Request owner | Employee question and authorized source excerpts | Scope and audience; no account access changes |
| Check the sources | Source checker agent | Frozen source pack | Current, archived, conflicting and missing guidance |
| Draft the answer | Documentation agent | Sources plus accepted source check | Numbered answer with citations and open questions |
| Review the evidence | Evidence reviewer agent, then people | Original sources and accepted answer | Claim checks; two distinct reviewers must approve the recorded output |
| Prepare the follow-up | Documentation owner | Reviewed answer and remaining gaps | Draft documentation task; another review gate; no automatic publication or Jira delivery |

Select **Workflows → Choose a workflow template → Internal documentation** as
an administrator. Applying a template replaces the workspace configuration;
existing runs retain their original configuration. Assign approved assistants
to the three agent stages under **Stage settings**. Unassigned stages are manual.
Create a run with the title, brief and four material excerpts in `scenario.json`.

An assistant drafts each assigned stage. A person checks the draft and accepts
it or records their own output. This workflow does not search a document store,
fetch URLs, grant permissions, publish answers or send Jira actions.

## Repeatable checks

`scenario.json` contains eight acceptance cases, including outdated sources,
precise timing, missing exceptions, an embedded malicious instruction, distinct
reviewers and a link with no excerpt. Treat these as a held-out review checklist,
not training examples or a claim that a model passed.

The automated tests exercise the scheduler, frozen reference handoff, template
configuration and review gates with a model double. They do not score prose:

```powershell
corepack pnpm exec tsc -p tsconfig.test.json
node --test .testbuild/tests/internal-docs-workflow.test.js
```

To exercise a real local model, start Ollama with `qwen2.5-coder:7b` already
installed, compile as above, then run:

```powershell
node examples/internal-docs/run-live.mjs ../.tmp/internal-docs-live
```

The harness uses the production scheduler with fixture assistant bindings and
fictional source excerpts. It accepts intermediate drafts as a test operator to
exercise handoffs, then stops at **Review the evidence / awaiting review** with
zero reviewer approvals. It does not create an approved Studio release or train
model weights. Inspect `live-result.json` against all eight acceptance cases.
If a model call fails, the harness records the failure and stops at that stage.
Only the primary scenario runs live; URL-only behavior has a separate automated
prompt check and still needs a live-model trial.

The Model Studio project **Internal docs — Employee onboarding** contains a few
reference examples for exploring the stages. Those examples are not enough to
meet the internal-knowledge recipe's data coverage threshold. Do not inflate
the dataset with repeated examples to turn the gate green.

## What this demonstrates

The useful unit is a sourced, reviewable work result: source assessment, cited
answer, evidence review and a proposed follow-up. The model does not own access
control or approval decisions. Prompt instructions help distinguish source text
from commands, but are not a security guarantee or an automated citation check.

See [the next build plan](../../docs/internal-documentation-plan.md) for the path
from this bounded reference-pack test to an internal documentation product.
