# Agent Studio demo

From the Magentic checkout:

```sh
corepack pnpm build:workbench
corepack pnpm demo:agents
```

Open the printed Agent Studio URL (port 4183 by default). This starts a separate
workspace with a synthetic SOP, two editable agents, a disposable Git repository,
and two independent reviewers. Existing local workspaces are not opened.
`MAGENTIC_AGENT_DEMO_PORT` selects another loopback port.

The default model is **scripted**. MCP file reads, workflow state, command checks,
hash checks, and approvals are real; answers are canned and token counts are
unavailable. This demonstrates product flow, not model quality or Auto routing.

## Walkthrough

Use **Services → Agent Studio** from the compact console bar. Services are
searchable by name or group; Escape closes the dialog and returns keyboard
focus. **Choose company and workspace** opens workspace selection. The
**Account** menu contains demo identity selection and Dark, Light, or System
appearance. Appearance is a browser preference, not an account credential.

Agent Studio has one page per agent step: Purpose & setup, Test, Assignment.
The header keeps the selected agent, its saved version and the next action in view.

1. On the overview, choose **Start with a job → Internal documentation assistant**.
   The model, the read file tool and **Require a source read** are prefilled.
   Save. The job's example becomes the agent's first saved test and the Test
   page opens.
2. **Run test**. The result shows the task, expected behaviour, source-read
   evidence and answer. Expand **Evidence — tools and execution** for every
   tool call, model, model calls, provider reported tokens (none for the
   scripted model), elapsed time and execution log. "Execution finished"
   means the run completed; it is not a judgement of the answer.
3. Record a **quality review** (pass, fail or unsure, with a note) as an
   approver or admin. The review is stored beside the run, separately from the
   execution outcome, and only once per run.
4. On **Assignment**, assign the saved agent to Read and answer. The page states
   what the stage receives, what it produces, which tools it may use, who
   reviews it and what comes next. Open runs keep the configuration they
   started with.
5. On that same Assignment page, **Start workflow** with the example task, then run
   the planner from the work item, accept its result, run the reviewer in
   Check the answer and submit it for review.
6. Open **Account**, switch Acting as to Reviewer 1 and approve the handoff. It remains pending.
   Switch to Reviewer 2 and approve. The workflow is now complete.
7. Edit the agent's instructions and save. The Test page marks the earlier run
   **Out of date** (it names the version it tested); the completed workflow run
   is unchanged. Run the test again before relying on it.

Tests are saved under the workspace data directory (`agent-tests/`) in the
local application and in memory in this demo.

Browser regressions for this journey run with
`corepack pnpm exec playwright test --config tests/studio-journey.config.mjs`.
The existing operations checks remain in `tests/operations-ui.config.mjs`.
Both accept `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and `PLAYWRIGHT_LOW_MEMORY=1`
for hosts using a system browser. Screenshots default to
`test-results/studio-screenshots/`; `MAGENTIC_UI_ARTIFACTS` overrides that directory.
If the low-memory single-process Chromium crashes when opening another context,
run each test separately with `--grep` rather than treating a browser crash as
an application assertion failure.

The operator cannot self-approve; a repeated signature cannot count twice.
Changing a saved agent requires reassigning it to future runs. Existing runs
retain their instructions, model, tools, and review policy.

## Live local model

Stop the scripted demo before reusing its port, then run:

```sh
corepack pnpm demo:agents --live
```

This uses the native Ollama HTTP transport and configured local model (default
`qwen2.5-coder:7b`). Ollama must be running and the model installed. Cloud model
IDs and remote Ollama hosts are refused by this demo. No model is downloaded.
Reported input/output tokens and elapsed time appear on each attempt; missing
usage remains unavailable. Check the actual output against the synthetic SOP:
team owner approval, two business days after approval, missing approval returned
to the requester. A failure stays visible and does not advance the workflow.

Each launch creates new disposable data under `.testbuild/agent-demo-*` and keeps
its evidence on exit. Workflow state in this demo is in memory and resets on
restart. Use the regular local application for durable workflows. This is not
a trained model release, a deployed service, or an enterprise login environment.
Local single-owner workspaces still require independent reviewer enrollment
before they can finish gated handoffs; demo identities do not bypass that rule.

The demo enables **Require a source read**. A final answer without a successful, nonempty file read is blocked within the same call budget. This proves access to evidence, not answer accuracy; review the answer against SOP.md. Existing agents keep their policy until explicitly changed and reassigned.
