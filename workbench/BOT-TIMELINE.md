# Bot timeline and developer environments

Magentic is a companion application for an existing Git repository and editor.
Attach a repository, configure validation commands, assign a bot and model to
each phase, and start a run. The development template assigns planners,
coding, validation, and review bots without lowering existing approval gates.
Existing runs retain their saved assignments; they are never migrated silently.

## Layers

- `bot-schema.ts`: strict configuration, attempt records, and operator commands.
- `bot-project.ts`: repository attachment, isolated Git worktrees, bounded file
  access, reviewed changes, and explicit validation commands.
- `bot-worker.ts`: bounded model/tool loop. Repository tools use the existing
  MCP SDK. Planner, reviewer and validator roles cannot propose file edits.
- `bot-runtime.ts`: durable attempts, cancellation, replay protection, role and
  revision checks, and submission through the existing pipeline approval gate.
- `bot-view.ts`: phase timeline, assigned models and tools, before/after file
  review, actual check output, attempts and editor checkout paths.

The runtime keeps bot activity separate from pipeline transitions. Finishing
a model call never completes a phase automatically. The operator reviews and
applies proposals, runs configured checks, and submits the result. An AI review
is not a human approval. Authors and run owners still cannot approve their own
gated handoffs. A single-owner installation can therefore stop at a review gate.

## Execution boundaries

Each run starts a detached worktree from committed HEAD. Uncommitted changes
in the developer's original folder are not copied. Worktrees persist for review;
open their displayed paths in any editor. Magentic does not install dependencies,
commit, merge, push, publish, or send Jira updates automatically.

Model access is limited to project file listing, UTF-8 reads and project diffs.
Symlinks, hard links, traversal paths and common credential files are refused.
This is a bounded file API, not a guarantee that source contains no secrets.
Selected file content goes to the phase's configured model provider. Choose a
local model when code must remain local. Model output cannot invoke commands.

Validation commands are configured by the local owner when attaching the repo,
shown in the UI, and run only on request. They execute with the user's OS account;
a Git worktree is not an operating-system sandbox. Commands use a program and
argument array, without a shell. On Windows use a native executable or invoke a
script through its runtime; `.cmd` scripts and shell pipelines are unsupported.
`node` uses the application's bundled Node runtime. Other languages use the
developer's installed executables, such as Python, Go, dotnet or Java.

## Persistence and integration

Bot documents live below the application's workspace data directory in `bots/`.
The existing application writer lock protects them. Running attempts become
interrupted on restart. A cancelled or failed attempt never hands off work.
Changing configuration applies only to new pipeline runs. Repository bindings
and validation commands are fixed once attempts exist; create a new workspace
to use a different environment. Maximums: 100 attempts per workspace, two active
model workers, 12 model calls per attempt and five proposed files per result.
Tokens and cost remain unavailable unless measured; model invocation counts and
check exit codes are recorded rather than inferred from model prose.

Local browser API: `GET /api/bots`, `POST /api/bots` for attach, start, cancel,
apply, checks and accept. Standalone pipeline MCP gains a read-only
`get_bot_timeline` tool. MCP credentials cannot invoke repository-changing bot
commands; those require the local browser session. The existing registry MCP
continues to serve only approved definitions with current content signatures.

This is supervised execution, not unattended Factory parity. Dynamic task
decomposition, automatic scheduling, arbitrary third-party tool execution,
reviewer enrollment, measured billing and live Jira delivery are future layers.

## Per-phase MCP controls

Each phase can set `allowedTools` and `maxToolCalls` in its bot policy. Omitted
fields retain the original behavior. An empty list disables repository tools,
and zero calls prevents dispatch. The worker enforces these limits before a
tool runs. A saved run keeps its original policy when configuration changes.

Standalone clients can use `get_pipeline_capabilities`, `list_bot_attempts`
and `get_bot_attempt` to inspect effective policies and evidence within their
authenticated workspace. These are read-only and do not grant bot execution.
See [architecture and verification](ARCHITECTURE.md) for schemas, endpoints,
build commands, test coverage and the remaining product layers.
