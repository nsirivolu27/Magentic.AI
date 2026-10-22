# Zenfluence

Zenfluence is the company's Jira + Confluence workspace in Magentic. Open
`#/zenfluence`, read a ticket or page, then attach a reviewed snapshot to an
open workflow. Jira ticket creation, comments and transitions remain in the
existing Jira action layer; this connector performs no Atlassian writes.

## Connection

Set `MAGENTIC_ZENFLUENCE_FILE` to a JSON file based on
`examples/zenfluence.json`. Use the actual company workspace UUID, Atlassian
site, Jira project key and numeric Confluence space ID. Credentials are setting
names, never values in that file. Supply the corresponding email and API token
through server settings, then restart the company server.

This first adapter supports Atlassian Cloud site URLs and email/basic API-token
authentication for tokens that support site-based REST access. OAuth and scoped
API tokens requiring the api.atlassian.com gateway are not implemented. Use a
dedicated service account limited to the company project and space. Every member
of this Magentic workspace can read those configured sources using that account;
this is shared company access, not each member's individual Atlassian permissions.

No credentials, account or Confluence space are created automatically. An empty
configuration displays setup state, not sample data or a claimed connection.

## Local development

The local workbench loads the same connector, so a developer can read real
tickets and pages against the dev server. The local workspace id is a name
(`workspace` by default), not a UUID; the page shows the exact id to use when
nothing is configured. Settings are environment variables of the server
process. Windows PowerShell, before starting the dev server in that window:

```
$env:MAGENTIC_ZENFLUENCE_FILE = "C:\path\to\zenfluence.json"
$env:MAGENTIC_ATLASSIAN_EMAIL_COMPANY = "service-account@example.com"
$env:MAGENTIC_ATLASSIAN_TOKEN_COMPANY = "<api token>"
node .\workbench\dev.mjs --port=4182
```

The token is an Atlassian API token for that account. Keep the file outside
the repository or under an ignored folder; never commit the token anywhere.
The page reports four states: not connected (no file for this workspace),
credentials needed (file loaded, a named setting missing), ready, and error.

## Contract

- `GET /api/zenfluence`: connection summary, never credentials.
- `POST /api/zenfluence`: `{ "action": "read", "source": { "kind": "jira", "id": "KAN-123" } }`.
  Use `kind: "confluence"` with a numeric page ID for documentation.
- Attach using `action: "attach"`, the same source, `runId`, `expectedRevision`
  and `expectedSourceHash` from the read response. Owner/author or admin only.
- Pipeline MCP exposes the read-only `get_zenfluence_source` tool when configured.
  It cannot attach, create tickets, publish pages or change permissions.

Reads are bounded to ten seconds and 128 KB; redirects are refused. Returned
project/space and resource IDs are checked as well as the requested IDs. Page
HTML is never rendered. Text comes from Atlassian Document Format text nodes.
Known credential patterns refuse import; this is not comprehensive DLP.

An attachment rereads the source and refuses a changed fingerprint. It preserves
the source URL, revision, retrieval time and content fingerprint in the workflow's
existing reference store. Excerpts are limited to 4,500 characters and labelled
when truncated. Nothing trains, publishes, advances or approves automatically.

API contracts:
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/
