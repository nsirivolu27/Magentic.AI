# Local mode

Two entry points, deliberately separate.

| | Demo | Local |
| --- | --- | --- |
| Entry | `workbench/demo.ts` | `workbench/local-main.ts` |
| Data | In memory, gone on exit | `%LOCALAPPDATA%\MagenticDeveloper\data\workspaces` |
| Identities | Four public sample actors | One local owner |
| Credentials | A bearer that is just an actor name | Session cookie, plus a separate MCP token |
| `demo` flag in `/api/workspace` | `true` | `false` |

Local mode never accepts a demo actor name as a credential, and never falls
back to memory. A workspace that cannot be opened stops startup.

## Startup

1. The launcher forks `local-main.mjs --desktop`.
2. The composition root resolves the data directory, then **takes the writer
   lock before binding a port**. A second instance fails here, while nothing
   is listening and no window is open.
3. It reads and validates the workspace document. A corrupt or
   unsupported-version file stops startup with the path named.
4. It mints a browser session secret in memory and loads or creates the MCP
   token.
5. It binds `127.0.0.1:0`, arms a 60 second bootstrap window, and sends the
   URL to the launcher over IPC. The URL carries no credential.
6. The window opens the page. That first `GET /` receives
   `Set-Cookie: magentic_session=...; HttpOnly; SameSite=Strict`. The window
   closes after one claim. A stale cookie from the previous process is replaced during this window.

## Credentials

**Browser session.** In memory, so every restart invalidates every previous
session and a stale tab is harmless. HttpOnly, so page scripts cannot read
it. SameSite=Strict plus an Origin check on every state changing request.

**MCP token.** For standalone clients. Lives at
`<data>/mcp-token`, mode 0600, and survives restarts so a client configured
once keeps working. Rotate it by deleting the file and restarting. Send it as
`Authorization: Bearer <token>`.

The initial token remains bound to the first workspace recorded in `workspaces.json`, even when the last opened workspace changes. In the UI, **Standalone MCP access → Prepare connection settings** creates a separate token file for another workspace and shows its path, never its contents. These grants live in `<data>/access/<workspace-id>.token`. Stop the app before removing a grant file to revoke it. Windows protection relies on the per-user directory ACL; POSIX mode bits alone do not establish Windows access control.

Bearer credentials are accepted only at `/api/mcp` and `/api/pipeline-mcp`, never at workspace management, chat or authoring routes. Standalone MCP calls may omit Origin; an explicitly foreign Origin is always rejected. Browser writes require a matching Origin. A bearer cannot switch workspace with a header or by opening a different UI workspace. The loopback address changes each launch and is displayed in connection settings and the launcher log.

The two are different secrets and are not interchangeable. A browser secret
presented as a bearer is refused, and the reverse is refused too.

## What this does and does not defend against

Defends against: a page on another origin reaching the server, a stale tab
from a previous run, a process that connects to the port after the bootstrap
window closed, and a request arriving with a Host we never bound.

**Does not defend against a malicious process running as the same OS user.**
That process can read `mcp-token`, and can reach the port during the
bootstrap window. A loopback application session is not enterprise
authentication. The operating system account is the real boundary, and no
arrangement of tokens here changes that.

## Review still requires a second person

The local owner holds `author` and `admin`. Admin is not permission to
self-approve: the registry refuses an author approving their own definition,
and the pipeline refuses the run owner or the output author approving a
handoff. On a single-user machine a gated stage therefore **stays blocked**,
and that is the correct outcome rather than a bug. `allowSelfApproval` is not
set, thresholds are not lowered, and no fake reviewers are seeded.

## Storage and recovery

One JSON document per workspace. A commit writes a temp file, fsyncs it, then
renames over the target. **The rename is the commit point**; the in-memory
state is replaced only after it returns.

What this gives you, precisely:

- **Ordinary operation:** a command that reports success has been written and
  renamed. A failed write leaves both the in-memory and on-disk state as they
  were.
- **Process crash:** the document on disk is either the previous version or
  the new one. A temp file may be left behind; the next start sweeps it while
  holding the lock.
- **OS failure or power loss:** the file content is fsynced before the
  rename, but the directory entry is not fsynced. POSIX would need that for a
  durability guarantee and Node exposes no portable Windows equivalent. The
  outcome depends on the filesystem and operating system. Power-loss
  recovery has not been tested and is not guaranteed.
- **Filesystem differences:** rename-over-existing is atomic on NTFS and on
  POSIX filesystems. Behaviour on network or synchronised folders, including
  OneDrive, is not characterised.

Workspace files are named from a sanitized name plus 128 bits of hash, so two
names cannot share a file in practice. Because "in practice" is not "never",
commit also refuses to replace a document that names a different workspace.

**Lock recovery.** The lock is one exclusive file create. There is no
automatic stale reclamation, because a PID can be reused and handing two
writers one directory is worse than refusing to start. If the application was
killed, verify that no Magentic backend is still running before removing
`<data>/.writer.lock` and starting again. Normal shutdown removes
the lock only if it still names this instance.

## Known limitations

- Phase bots run only when explicitly started. A configured model alone does not mean a stage ran. See BOT-TIMELINE.md for repository attachment and execution boundaries.
- Jira and email are previews. Nothing is sent.
- LLM usage is unknown where it is not measured, and is not reported as zero.
- Reviewer enrollment is not implemented. The single owner cannot clear their own review gates.
- There is no automatic stale-lock recovery, cloud sync, workspace deletion or filesystem migration.
- Chat uses Ollama by default; the service and downloaded model must be available separately. Configured cloud providers require their own credentials.

## Workspace operations

`GET /api/workspaces` lists saved workspaces. `POST /api/workspaces` accepts a strict `{ name, requestId }` body; the UUID request ID makes retries idempotent. `POST /api/workspaces/open` accepts `{ workspaceId }` and stores the startup preference. The browser sends `X-Magentic-Workspace` on each request, so another window opening a workspace cannot redirect a pending operation. A failed open keeps the existing view and scope together.

The directory supports up to 50 workspaces. Names are labels; generated IDs identify new workspaces. A new workspace document is saved before its catalog entry. If the catalog write fails, an unlisted document can remain for manual recovery; the UI does not report creation as successful. The catalog is validated at startup and never silently replaced after corruption. Existing single-workspace data is adopted on first catalog creation.

The default workspace is `workspace` on first start and the last opened workspace thereafter. `MAGENTIC_WORKSPACE` can select an existing ID explicitly. Registry definitions and audit history use their existing file stores alongside the pipeline documents.

## Build and launch

Run `corepack pnpm build:workbench`, then `corepack pnpm local:workbench`. The desktop build bundles the same entry point and browser assets. `launcher.mjs --smoke-test` uses an isolated temporary directory and checks the local cookie handshake, file-backed workspace, real browser bundle and bundled Ollama adapter. `launcher.mjs --demo` explicitly opens the disposable demo instead.

## Settings

| Setting | Meaning |
| --- | --- |
| `MAGENTIC_WORKSPACES_DIR` | Override the data directory |
| `MAGENTIC_WORKSPACE` | Existing workspace ID to open, or initial ID on first start |
| `MAGENTIC_WORKFLOW_FILE` | Validated workflow policy loaded at startup |
| `MAGENTIC_WORKBENCH_PORT` | Fixed port when not launched by the desktop |
| `MAGENTIC_WORKBENCH_ASSETS` | Serve static assets from elsewhere, for development |
