# Magentic

## Developer workspace preview

The optional workbench runs locally; its Ontology sample needs no LNKZ relay.
See the [Foundry/Ontology guide](workbench/ONTOLOGY.md) for repository startup,
VS Code MCP setup, and live-connection requirements. After building the
workbench and configuring a workspace, `corepack pnpm ontology:mcp` starts
the standalone read-only Ontology server. Application packaging is deferred
while the API and agent loop is verified.

The sections below describe the original relay adapter.

Magentic is the Model Context Protocol server for the
[LNKZ relay](https://github.com/nsirivolu27/LNKZ). It exposes conversation
tools, resources and prompts to MCP clients, using the relay's authenticated
REST API for every operation.

Magentic owns MCP. LNKZ owns conversations and serves REST. REST is the seam
between the two, and this repository is on the MCP side of it: no database, no
conversation store, no import pipeline, no connector implementation, no
authentication implementation, no console. Run a relay separately and point
this at it.

That boundary is worth stating plainly because it is easy to erode. If this
repository ever needs to import from the relay's source, the boundary is wrong
and the fix belongs here.

## Naming

This server used to be called LNKZ MCP, and its settings were named `LNKZ_*`.
They are `MAGENTIC_*` now. Every renamed setting still accepts its old name and
prints one warning naming the replacement, and resources answer on both
`magentic://` and the old `magentic://` addresses, so a deployment configured
before the rename keeps working. Both fallbacks go away in the next major
version; `MAGENTIC_LEGACY_URIS=0` drops the old addresses today.

Three settings keep their LNKZ names on purpose. `LNKZ_BASE_URL` and
`LNKZ_API_KEY` are the address of and the key for the relay this server talks
to, and `LNKZ_MCP_TARGETS` is configured on the relay. Renaming those would
hide the boundary above rather than move it.

## Requirements

- Node.js 22
- pnpm 10.26.1 through Corepack
- A running LNKZ relay
- A relay API key with the scopes needed by the tools you use

## Install and build

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The server fails closed unless both settings are present:

```text
LNKZ_BASE_URL=http://127.0.0.1:3100
LNKZ_API_KEY=replace-with-a-dedicated-relay-key
```

Do not commit API keys or put them in command-line arguments. Supply them through your MCP client's environment configuration or a secret manager.

### Exposing fewer tools

`MAGENTIC_SCOPES=read` hides the tools that change things: saving, importing,
appending, deleting, minting, redeeming, continuing and revoking. Everything
that only reads stays, and `preview_handoff` counts as reading because it
spends nothing.

Omit the setting for everything, which is the default and what every existing
deployment already has.

This controls what a model can see, not what it is permitted to do. The relay
enforces the key's real scopes and refuses a write on a read-only key whatever
is registered here. The reason to set it anyway is that a model cannot build a
plan around a tool it never sees, so a reader-only deployment stops being
offered deletions it was never going to be allowed to perform.

### Semantic search and grounded answers

Setting `MAGENTIC_LLM_PROVIDER` adds two read-only tools. `semantic_search` ranks
conversation passages by meaning rather than by shared words, and
`ask_conversations` answers a question from the stored conversations with a
citation on every claim and an explicit refusal when the answer is not there.
Both name the conversation and the message ids behind every result.

Leaving the setting unset registers neither tool, and no LangChain package is
installed or imported. Turning it on means passage text leaves this instance
for the provider you name, so `ollama` against a server you run is the
configuration that keeps conversations on your own hardware.

```
pnpm add @langchain/ollama          # or @langchain/openai
MAGENTIC_LLM_PROVIDER=ollama
MAGENTIC_LLM_BASE_URL=http://127.0.0.1:11434
```

`LANGCHAIN.md` explains why this lives in the adapter rather than in the
relay, and what each per-query cost ceiling in `.env.example` bounds.

## Claude Desktop (stdio)

Build the repository, then add an entry like this to Claude Desktop's MCP configuration. Replace the path and placeholder key locally.

```json
{
  "mcpServers": {
    "magentic": {
      "command": "node",
      "args": ["C:\\path\\to\\magentic-mcp\\dist\\stdio.mjs"],
      "env": {
        "LNKZ_BASE_URL": "http://127.0.0.1:3100",
        "LNKZ_API_KEY": "replace-with-a-dedicated-relay-key"
      }
    }
  }
}
```

The adapter uses local stdio for MCP traffic. It does not open a port or mount `/mcp`; network access is only from the adapter to the configured LNKZ REST base URL.

## Preserved MCP surface

Magentic serves all 24 tool names:

```text
save_conversation          import_conversation       get_conversation
list_conversations         search_conversations      append_messages
export_conversation        build_context_graph       list_publish_targets
prepare_publish            delete_conversation       create_handoff
redeem_handoff             continue_handoff          revoke_handoff
list_handoffs              build_context_packet      analyze_conversation
find_conflicts             find_duplicates           search_context
list_connectors            workspace_stats           audit_log
```

It also preserves the `magentic://connectors`, `magentic://stats`, `magentic://conversations`, `magentic://conversation/{id}`, and `magentic://graph` resources, plus the four existing prompts.

## Repository boundary

- Product UI, relay REST API, stores, authentication, managed OIDC membership, connectors, import/export implementation, intelligence, graph construction, and publish-target discovery belong in [LLMM](https://github.com/nsirivolu27/LLMM).
- MCP registration, stdio transport, REST wire contract, and the authenticated REST client belong here.
- RSNA work belongs only in [rsna-knee-abnormality-detection](https://github.com/nsirivolu27/rsna-knee-abnormality-detection).

## Run it yourself

Two terminals and no deployment: the relay on 3100, the adapter built from
this checkout, and either your desktop client or a browser. `LOCAL.md` has
the whole path, including the Claude Desktop entries and how to add an agent
of your own. `corepack pnpm agents` prints what this checkout hosts without
starting anything.

## Agents hosted here

One hosted process can serve several agents, each a fixed set of tools at its
own MCP URL. `/agents` is the machine-readable catalog, `/` is a page listing
what is hosted, and `/mcp/<name>` is an agent's endpoint. Three ship with the
adapter: `conversation-relay` for passing conversations between people,
`research-reader` for everything that reads and nothing that changes, and
`handoff-desk` for minting and receiving links.

An agent is configuration and nothing else: no relay, no key, no code. It
narrows what this deployment offers and can never widen it, so
`MAGENTIC_SCOPES=read` makes every agent read-only whatever its own scopes
say. `CATALOG.md` has the record format and the rules.

## Hosting it

`pnpm start:http` runs the adapter as an HTTP server instead of a subprocess,
for clients that speak Streamable HTTP or for one adapter shared by several
people.

```text
LNKZ_BASE_URL=https://relay.example.com
HOST=0.0.0.0
PORT=8080
```

**A hosted adapter holds no key.** Each caller sends their own relay key as
`Authorization: Bearer <key>`, and the adapter builds a client with it for
that one request. The relay then decides what that caller may do, exactly as
if they had connected to it directly.

This is the difference between hosting and running locally, and getting it
wrong is quiet. An adapter that read `LNKZ_API_KEY` and listened on a port
would let everyone who reached the URL act as that one key. `LNKZ_API_KEY` is
therefore ignored in hosted mode rather than used as a fallback, and the
server says so at startup if it is set. A caller without a key gets 401.

`GET /health` answers without a credential and returns only whether the
process is up and which relay it points at, because a probe that needs a key
is a probe nobody runs.

One thing to be clear about with your users: pointing a client at someone
else's hosted adapter means handing them your relay key. Host one for people
who already trust you with it, and tell them what they are sending.

### Deploying it

```bash
set -eu
corepack enable
pnpm install --frozen-lockfile
pnpm test
fly auth login
APP="magentic-mcp-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
fly apps create "$APP"
fly deploy --app "$APP" --env LNKZ_BASE_URL=https://your-relay.example.com
curl -fsS "https://$APP.fly.dev/health"
```

No volume, no database, no secrets. The adapter keeps nothing between
requests, so machines suspend when idle and start on the next call, and
restarting one loses nothing. `min_machines_running` is 0 for the same reason,
which the relay cannot do because it owns a file.

Do not set `LNKZ_API_KEY` on a deployment. There is no use for it here and
setting one hands every caller the same access. The server logs a warning if
it finds one.

Point a client at it with the hosted form of the config, sending your own
relay key:

```json
{
  "mcpServers": {
    "magentic": {
      "type": "streamable-http",
      "url": "https://your-adapter.fly.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_RELAY_KEY" }
    }
  }
}
```

## Moving a conversation between two relays

Four tools cover the crossing, and the differences between them are the point.

| Tool | What it does | Cost |
| --- | --- | --- |
| `preview_handoff` | Reports title, provider, message count, uses left and whether redaction is on | Nothing. No transcript, no use spent |
| `import_from_url` | Stores a copy here and records where it came from | One use |
| `continue_from_link` | Stores your continuation of their conversation as a new conversation | One use |
| `continue_handoff` | The same, for a link this relay minted | One use |

Preview first when you are not sure what someone sent you. A share link is a
bearer link and every redemption spends one of its uses, so on a one-use link
finding out what is inside would otherwise cost you the thing itself.

Importing and then appending is not the same as continuing. It edits your copy
and leaves nothing recording that the work moved on or which client carried it.
`continue_from_link` records both, and the chain root survives so the sender can
still resolve the conversation to their own original if it comes back to them.

The relay does the fetching in every case. This adapter never dials a share
link itself, which keeps the protocol allowlist, the credential check, the
public-address requirement, the size cap and the timeout in one place rather
than in two copies that drift.


## Local workspace portal

Run `pnpm build:workbench` and `pnpm demo:workbench`, then open
`http://127.0.0.1:4173/`. The portal includes agent reviews, workflow policy,
email previews, and an MCP inspector. The demo binds to loopback, uses public
sample identities, and resets its in-memory data on restart. Email previews
never send mail or grant membership.

The **MCP** page connects to a real, read-only Streamable HTTP endpoint at
`/api/mcp`. It supports initialization, tool discovery, and these tools:

- `list_approved_agents`: metadata for definitions that pass the current gate.
- `get_approved_agent`: the reviewed definition for a supplied `name`.
- `get_workspace_policy`: the authenticated workspace's active policy.

Every call checks current signatures and content hashes. Missing required
tools, retirement, insufficient approvals, and edits withhold a definition.
The portal also explains withheld records to workspace members. One sample
agent starts fully approved; Research assistant still needs its second review.

Use **Connect & inspect**, select a tool, and choose **Run tool** to see its
actual protocol response. Connection settings show the local URL and selected
public demo token. Native MCP clients use POST with a bearer token and accept
`application/json, text/event-stream`; this endpoint uses stateless JSON
responses and does not provide a persistent GET stream.

These tools read configuration. They do not execute an agent or access LNKZ
conversations. The existing relay adapter and its `/mcp/<name>` endpoints remain
separate. A real deployment must supply `createWorkbenchServer` with its
existing authentication callback, member directory, and persistent registry;
the sample identity selector is only a local demo frontend. Credentials are
not saved in browser storage. The workbench does not issue production tokens.

### Live local development

Run `corepack pnpm dev:workbench` with Node 22 to open the real local app at
`http://127.0.0.1:4317/`. Source edits rebuild the UI and restart the backend.
The page reloads automatically until you edit a form; after editing, use the
**Reload latest build** button to avoid losing unsaved work. Development data
lives in the ignored `.magentic-dev/data` directory and survives rebuilds.

Use `--port=4318` to choose another port or `--data-dir=<directory>` to select
a different development data directory. Stop with Ctrl+C so the backend can
release its writer lock. A failed compilation leaves the last working server
running. Backend edits interrupt running bots and chat, so finish important
attempts before changing server code. This mode binds only to loopback.

Within a workflow run, **Review Jira action** shows the exact proposed content
and destination. Confirming **Save local preview** records it without sending
anything. **Saved actions & evidence** shows persisted outcomes, including
uncertain attempts. Standalone MCP can read these through `get_jira_actions`.
Live Jira credentials and delivery are not enabled by development mode.

### Persistent desktop workspaces

The Windows desktop launcher now opens the local entry point by default.
Create, select and reopen workspaces in the workspace panel. Pipeline runs,
registry records and audit data are stored under the user's local application
data directory. Browser requests use a temporary HttpOnly session cookie;
standalone MCP clients use a separate credential bound to one workspace.

Run `corepack pnpm build:workbench` followed by `corepack pnpm local:workbench`
for the local browser entry point, or build the Windows package with
`corepack pnpm build:desktop`. See [local mode](workbench/LOCAL-MODE.md) for
storage, credentials, settings and recovery. The demo entry point remains
available explicitly. Existing stages stay manual until bots are configured;
Jira is a preview, and the local owner cannot approve their own work.

### Bot timelines

Local workspaces can attach an existing Git repository and assign a planner,
coder, validator, or reviewer to each workflow phase. Bot attempts use a
separate checkout and expose their progress, model calls, file proposals and
check results in the timeline. Apply reviewed changes and hand off results
without leaving your existing editor. See [bot timelines](workbench/BOT-TIMELINE.md)
for execution boundaries and setup. Existing review gates remain enforced.

For the current layer map, per-phase MCP tool controls, and repeatable build/test
commands, see [architecture and verification](workbench/ARCHITECTURE.md).
