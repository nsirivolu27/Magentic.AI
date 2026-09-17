# Hosting agents

One process, one relay, several endpoints. A hosted adapter serves a catalog
of agents, each of which is a fixed set of tools with a description of what it
is for, at its own MCP URL.

## What an agent is

Configuration. Which tools are active, what the thing is for, what a
connecting model should be told, and which scopes it needs. That is the whole
record.

It is deliberately not a model, not a credential and not code. An agent cannot
name a relay, so it cannot point a caller at someone else's data. It cannot
carry a key, so adopting one grants nothing on its own. And it cannot widen
what the deployment allows, so a server running with `LNKZ_MCP_SCOPES=read`
stays read-only however an agent file is written.

This is the same definition `MARKETPLACE.md` gives a package, which is the
point: the catalog a server hosts and the packages a marketplace would one day
distribute are one object, not two that drift apart.

## Endpoints

| Path | What it is |
| --- | --- |
| `/` | A page listing what is hosted here. No key, no script. |
| `/agents` | The catalog, as `{ "object": "list", "data": [...] }`. No key. |
| `/agents/<name>` | One agent. No key. |
| `/mcp/<name>` | That agent's MCP endpoint. Your own relay key, as before. |
| `/mcp` | Every tool this deployment exposes, unfiltered. |
| `/health` | Liveness, plus how many agents are hosted. |

The catalog is public because deciding whether to connect should not require
already having a key, for the same reason a model listing is readable before
you have one. It carries no relay URL, no operator detail and no credential.
`/mcp` and `/mcp/<name>` are unchanged in how they authenticate: the adapter
holds nothing, and each request acts as whoever sent the key.

Cross-origin reads are allowed on the catalog and refused on `/mcp`, so a page
can list what is hosted but cannot spend a key it happens to have.

## The shipped agents

- **`conversation-relay`** is LNKZ's own use case: save or import a chat, mint
  a handoff, redeem one, and carry someone else's conversation forward.
- **`research-reader`** reads and changes nothing. Safe to hand to a
  collaborator, because no tool on it can save, alter, delete or send.
- **`handoff-desk`** is just the passing: mint, preview, redeem, revoke. No
  saving, no importing, no deleting.

## Writing one

A file in `agents/`, named whatever you like, containing:

```json
{
  "name": "support-triage",
  "title": "Support triage",
  "description": "What this is for, in a sentence someone deciding can read.",
  "category": "support",
  "version": "1.0.0",
  "publisher": "your-team",
  "scopes": ["read"],
  "tools": ["list_conversations", "get_conversation", "search_conversations"],
  "optionalTools": ["semantic_search"],
  "instructions": "What a connecting model should know about this endpoint."
}
```

`tools` must exist on the build or the server refuses to start, naming the
file and the tool. `optionalTools` are registered when present and reported at
boot when not, which is how an agent can use `semantic_search` without
refusing to load on a deployment that never configured a language model.

`scopes` is a request, not a grant. Asking for `write` gets write only if the
deployment allows writes at all.

Everything that can be wrong is wrong at boot: an unknown tool, two files
claiming one name, malformed JSON, an unrecognized field. A catalog that half
loaded is worse than one that did not, because the failure shows up later as
an agent missing the tool it was chosen for.

## Turning it on

```
LNKZ_BASE_URL=https://relay.example.com
LNKZ_AGENTS_DIR=agents
node dist/http-main.mjs
```

The container sets `LNKZ_AGENTS_DIR=/app/agents` and bakes `agents/` into the
image, so changing the hosted set means editing the files and redeploying.
There is no runtime registry yet, which is deliberate: a registry is
`MARKETPLACE.md`, and it is third for the reasons written there.
