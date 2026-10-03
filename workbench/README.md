# Magentic desktop developer space

Magentic is distributed as a downloaded, installed desktop application.
Users launch it from their desktop or Start menu. Its backend, interface,
workspace data, bot execution, and MCP integrations run on their computer.
The browser demo below is a development tool, not the product delivery model.

The current Windows preview bundles Node and the application, but uses an
installed copy of Edge for its window. A fully bundled desktop shell remains
required before calling the download self-contained. Model weights and
developer toolchains are separate; cloud models still require network access.

See [architecture and verification](ARCHITECTURE.md) for the current layers,
MCP contracts, phase tool controls, build commands and remaining work.

## Run the local demo

```sh
corepack pnpm build:workbench
corepack pnpm demo:workbench
```

Open http://127.0.0.1:4173. Use **Explore as** to switch between an author and
two reviewers. The demo requires two approvals. Try approving the research
assistant as Jordan, or creating a draft as Alex and reviewing it as Sam and
Jordan. All sample data is in memory and resets on restart.

`MAGENTIC_WORKBENCH_PORT` changes the port. The demo always binds to loopback,
never reads a real registry, and exposes only workspace configuration at `/api/mcp`. Public demo
identities are deliberately not authentication for a real workspace.

## Real workspace integration

`createWorkbenchServer` takes the existing store, audit sink, member directory,
and workflow through its context. Its required `authenticate(request)` callback
must return an identity verified by the deployment's authentication system.
There is no client-supplied actor or workspace field in write requests. A real
deployment needs its own sign-in UI and authentication adapter; the supplied
browser identity switcher is only for the local demo.

All API responses use `no-store`; there is no offline cache of workspace data
or queued offline approval. Serve real deployments over HTTPS. Calls that
change an existing definition include the hash the reviewer loaded and fail
if the content changed. Writes are serialized inside this process; multiple
instances require a transactional store. Do not point a second writable
process at the same file store.

An eligible record meets the approval gate. The existing MCP server builds its
catalog at startup, so restart that server to load registry changes. This
workbench does not claim an endpoint is live or dynamically revoke an already
loaded MCP catalog. Live catalog refresh is a separate integration step.

## Workflow file

Set `MAGENTIC_WORKFLOW_FILE` to a JSON file for the hosted workspace. The file
is validated at startup. Without it, the default workflow and existing
`MAGENTIC_REQUIRED_APPROVALS` setting continue to work. A configured workflow
file owns its approval threshold and takes precedence over that old setting.

```json
{
  "states": ["draft", "review", "approved", "retired"],
  "transitions": {
    "draft": ["review"],
    "review": ["draft", "approved"],
    "approved": ["retired"],
    "retired": []
  },
  "roles": {
    "author": "author",
    "submit": "author",
    "approve": "approver",
    "request-changes": "approver",
    "retire": "approver"
  },
  "requiredApprovals": 2
}
```

State names retain the four existing meanings. Missing transition lists allow
no outgoing move. Each action's configured role applies to every allowed move
it performs; admins retain access. Approval counts must be integers from one
to ten. Extra fields, duplicate names, unknown roles, and transitions naming
undeclared states fail validation. Workflow files cannot enable self approval.


## Email portal

Open **Email** to inspect your inbox and outbox. Submitting an agent creates
review requests for current reviewers; approvals, changes, and retirements
create updates for the author. Routing checks current workspace membership
and the workflow's approval role. Authors never receive their own review
request. Notification preferences affect future messages only.

Switch to **Taylor · Admin** to create or cancel invitation drafts. Email
addresses are validated and duplicate active drafts are refused. Drafting an
invitation does not send mail, create an account, or grant a role. Reviewers
and authors cannot create invitations. Only a recipient can mark their own
preview as viewed. Admins can inspect the workspace outbox; other people see
only messages they initiated or received.

The demo uses reserved `example.test` addresses and an in-memory preview
outbox. All messages, preferences, and invitation drafts reset on restart.
No SMTP or email provider is connected. There is no sent/delivered status,
no tracking pixel, no sign-in link, and no invitation acceptance endpoint.
Connecting real mail requires a verified sender domain, provider credentials,
a durable outbox with retries, and the deployment's membership onboarding
flow. Signatures and permissions remain enforced in the registry regardless
of how someone arrives from an email.

Email creation happens after a successful registry action. If notification
preparation fails, the API reports the action's success with `emailWarning`;
it never asks the user to repeat a signature that already succeeded. For
production, store the event and outbox entry in the same transaction and
process delivery separately.


## In-app AI chat

**Chat** is the portal landing page. The local demo defaults to the installed
Ollama model `qwen2.5-coder:7b` at `http://127.0.0.1:11434`. Start Ollama before
sending a message. The workbench does not install or download models.
Explicit `MAGENTIC_LLM_PROVIDER`, `MAGENTIC_LLM_CHAT_MODEL`, and
`MAGENTIC_LLM_BASE_URL` settings override the demo defaults through the existing
provider configuration. Its optional provider packages are reused unchanged.

The assistant chooses among the three read-only workspace MCP tools. Tool
calls use the MCP client and server over an in-memory transport, with the same
approval gate as `/api/mcp`. Each model decision is validated; tool names are
allowlisted, argument schemas are enforced by MCP, and the authenticated
workspace cannot be changed by a prompt. Tool activity appears in the chat.
The assistant can explain definitions and policy, but cannot approve records,
send mail, execute agent tools, or access relay conversations.

Messages are held only in the browser tab and sent to the configured model
through the workbench server. Reloading, switching identity, or **New chat**
clears them; the workbench does not persist chat history. Conversation storage
remains the relay's responsibility. Only the supplied local demo defaults to
Ollama; a deployment must explicitly supply `chat` to `createWorkbenchServer`.
A missing model configuration gives a setup state, not a simulated response.

**Stop** cancels a request. Calls have a two-minute deadline, at most three MCP
tool calls, a bounded context, and one active request per workspace identity
(four per process). Model replies are displayed as text, not executable HTML.
For a multi-instance deployment, apply shared rate limits at its existing
API boundary. The UI's model label identifies configuration; it does not
claim the provider is reachable before a real request completes.


The **Model** selector loads installed models from Ollama's `/api/tags` endpoint.
Use **Refresh models** after installing another model through Ollama. Selection
applies to the next message; each reply identifies the model that produced it.
Switching is disabled during a response. The server verifies model names against
its own list, so a browser cannot supply an arbitrary provider or endpoint.
Model downloads are not triggered by chat. The local chat instance uses JSON
output, four CPU threads, and a 512-token output limit per agent step to keep
CPU inference bounded; it does not change the relay's model instance.


The model selector also groups supported text models from OpenAI, Anthropic
(Claude), and Google (Gemini). These are curated choices, not a claim that every
model or account entitlement is supported. Disconnected choices remain visible
and explain setup; they cannot send messages. Set `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` (`GOOGLE_API_KEY` is also accepted) on the
server and restart to enable that provider. Keys are read through `setting()`;
only connection status reaches the browser. A configured key does not guarantee
that the account can access every listed model.

Cloud selection sends the conversation and relevant read-only MCP results to
the selected provider on the next message. The UI states this before sending.
Cloud calls use fixed HTTPS endpoints, honor cancellation, and never fall back
to another provider. OpenAI Responses uses `store: false`; provider retention
policies still apply. These adapters use built-in fetch and add no dependencies.
Ollama remains the demo default, with all installed models discovered live.

Catalog and protocol references (checked 2026-09-20):
- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/guides/text
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/api/messages/create
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/openai


## Development pipelines

The demo now opens on **Pipelines**. Authors can start a development run, record
stage outputs, block/retry or pause/resume work, and follow its history. Admins
can add, remove, reorder, and edit stages, responsibilities, instructions, model
IDs, context descriptions, review gates, and Jira mappings. Configuration changes
create a new version; existing runs retain their configuration and required
approval count. Reviewers approve an immutable output hash. Run owners and output
authors cannot approve their own handoffs, including when they have admin rights.

This is a manual workflow foundation: stage model/context settings are reserved
for future executors and do not make LLM calls. Usage is explicitly not measured.
A shared deterministic Jira agent produces create/update previews on run creation
and completed handoffs. It never contacts Jira or fabricates a created issue key.
Stages work for code, prototypes, research, documents, or process improvements.

The pipeline engine owns only workflow configurations, run state, stage outputs,
review events, and Jira previews in memory. It does not own relay conversations,
external credentials, connector execution, or repository operations. The demo's
runs reset on restart. Persistent storage and full agent/Jira execution are later
work; the existing relay Jira search connector cannot currently send these writes.

Standalone clients can connect through Streamable HTTP at `/api/pipeline-mcp`
with the deployment's authentication. The existing `/api/mcp` tools stay stable.
The new endpoint exposes `get_pipeline`, `get_pipeline_run`, `start_pipeline_run`,
and `update_pipeline_run`, using the same engine and permission checks as the UI.
Use a UUID `requestId` for run creation and the returned `revision` as
`expectedRevision` on mutations. Stale commands are rejected; run creation retries
with the same request ID and content do not duplicate runs or previews. The public
sample identities are valid only for the loopback demo, not production credentials.

## Installable Windows preview

Run `corepack pnpm build:desktop` under Windows with Node 22 after installing
the existing dependencies, including the optional Ollama peer. The output
`dist/desktop/Magentic-Developer-Windows.zip` contains the runtime, UI, bundled
Ollama adapter, installer, and notices. Extract it and double-click `Install.cmd`; launch
**Magentic Developer** from Start. The installer is per-user and refuses to
overwrite an existing directory. It never changes execution policy.

This first desktop shell uses the installed Microsoft Edge engine in app mode,
with a separate browser profile. It starts Node on an ephemeral loopback port;
closing the app process stops that backend. It is an unsigned Windows preview,
not a native Electron build or a hosted deployment. Other operating systems and
signed installers are not included. Ollama itself and model files remain separate.

The packaged local entry point uses persistent workspace storage and a local
owner identity. Phase bots run in isolated repositories with reviewed changes
and explicit validation. Unattended scheduling and independent reviewer
enrollment remain future work. Desktop-shell replacement is deferred while
the MCP and workflow layers are completed.
The local MCP address and diagnostics are in LocalAppData/MagenticDeveloper/data.
