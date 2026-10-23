# lnkz-mcp

Standalone MCP adapter for the LLMM/LNKZ REST relay.

This repository intentionally contains no LLMM console, database, stores,
connectors, or product branding. It owns only the MCP surface and a small
authenticated REST client. The relay remains the source of truth.

## Configure

The adapter fails at startup unless both variables are present:

```bash
export LNKZ_BASE_URL=http://localhost:3100
export LNKZ_API_KEY=your-relay-key
npm ci
npm run build
npm start
```

Claude Desktop / other stdio clients:

```json
{
  "mcpServers": {
    "lnkz": {
      "command": "node",
      "args": ["/absolute/path/lnkz-mcp/dist/stdio.js"],
      "env": {
        "LNKZ_BASE_URL": "https://llmm.example.com",
        "LNKZ_API_KEY": "replace-with-a-secret"
      }
    }
  }
}
```

The API key is sent only as an `Authorization: Bearer` header to
`LNKZ_BASE_URL`. Never commit it or print it in logs.

## Stable MCP contract

The adapter preserves all existing names:

- **Tools:** `save_conversation`, `import_conversation`, `get_conversation`,
  `list_conversations`, `search_conversations`, `append_messages`,
  `delete_conversation`, `create_handoff`, `redeem_handoff`,
  `continue_handoff`, `revoke_handoff`, `list_handoffs`,
  `build_context_packet`, `analyze_conversation`, `find_conflicts`,
  `find_duplicates`, `search_context`, `list_connectors`, `workspace_stats`,
  `audit_log`, `build_context_graph`, `export_conversation`,
  `list_publish_targets`, and `prepare_publish`.
- **Resources:** `lnkz://connectors`, `lnkz://stats`,
  `lnkz://conversations`, `lnkz://graph`, and
  `lnkz://conversation/{id}`.
- **Prompts:** `continue_shared_conversation`, `research_brief`,
  `prepare_handoff`, and `reconcile_conflicts`.

All data operations go through the relay REST API. The adapter does not
silently fall back to local storage or invent a response when the relay
returns an error.

## Context forwarding

For trusted downstream MCP targets, a context envelope may be signed with
`LNKZ_MCP_CONTEXT_SECRET`. It contains a workspace ID, actor ID, scopes,
short expiry, and trace ID. Plain workspace headers are never trusted. API-key
and managed-auth identity take precedence over forwarded context, and
production authentication must fail closed.

```bash
LNKZ_MCP_CONTEXT_SECRET=...
LNKZ_CONTEXT_WORKSPACE_ID=...
LNKZ_CONTEXT_ACTOR_ID=...
LNKZ_CONTEXT_SCOPES=conversations:read,conversations:write
LNKZ_CONTEXT_TRACE_ID=...
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use a stub REST client, so they never need a database, a relay process,
credentials, or network access.