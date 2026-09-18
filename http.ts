import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer, type McpServerOptions } from "./mcp.js";
import { toPublicAgent, type CatalogEntry } from "./catalog/schema.js";
import type { Catalog } from "./catalog/load.js";

/**
 * The adapter, hosted.
 *
 * stdio.ts runs this adapter as a subprocess of one person's client, holding
 * that person's relay key. Hosting it is a different problem, and the obvious
 * translation is wrong: an adapter that reads LNKZ_API_KEY and listens on a
 * port lets everyone who reaches the URL act as that one key.
 *
 * So hosted mode carries no credential. The caller presents their own relay
 * key on each request and the adapter builds a client with it, which means
 * the relay decides what each caller may do, exactly as it would if they had
 * connected to it directly. The adapter stores nothing, remembers nothing
 * between requests, and has no key of its own to leak.
 *
 * LNKZ_API_KEY is deliberately ignored here rather than used as a fallback.
 * A fallback is how a deployment ends up quietly serving one person's key to
 * anyone who forgets to send their own.
 *
 *   LNKZ_BASE_URL=https://relay.example.com HOST=0.0.0.0 PORT=8080 \
 *     node dist/http.mjs
 */

const MAX_BODY_BYTES = 1_000_000;

export interface AdapterHttpConfig {
  /** The one relay this adapter talks to. Fixed by configuration, never by a caller. */
  baseUrl: string;
  options?: McpServerOptions;
  /**
   * The agents this server hosts, each served at its own MCP endpoint.
   *
   * One process, several endpoints, one relay. An agent narrows the tool
   * list a connecting client sees, which is the difference between handing
   * someone "the LNKZ server" and handing them a reader that cannot write or
   * a handoff desk that cannot delete. Omit it and only /mcp exists, which
   * is what every deployment before this had.
   */
  catalog?: Catalog;
}

/**
 * The request handler, with no listening and no environment reading, so a
 * test can exercise it without starting a process. The entry point in
 * http-main.ts is the part that reads configuration and binds a port.
 */
export function createRequestHandler(config: AdapterHttpConfig) {
  const baseUrl = config.baseUrl.trim();
  if (!baseUrl) throw new Error("LNKZ_BASE_URL is required. Refusing to start without a relay to talk to.");
  const options = config.options ?? {};
  const catalog = config.catalog;

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle({ baseUrl, options, catalog }, request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "Internal server error." });
    });
  };
}

export function createAdapterHttpServer(config: AdapterHttpConfig) {
  return createServer(createRequestHandler(config));
}

interface Resolved {
  baseUrl: string;
  options: McpServerOptions;
  catalog: Catalog | undefined;
}

async function handle(
  config: Resolved,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { baseUrl, options, catalog } = config;
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const agents = catalog?.entries ?? [];

  // Unauthenticated on purpose and carrying nothing: hosting platforms need a
  // probe, and a probe that requires a credential is a probe nobody runs.
  if (request.method === "GET" && path === "/health") {
    // The agent count appears only when this deployment hosts agents, so a
    // server configured the way every earlier one was answers the way every
    // earlier one did.
    json(response, 200, { ok: true, relay: baseUrl, ...(catalog ? { agents: agents.length } : {}) });
    return;
  }

  // The catalog is public. Deciding whether to connect to an agent should not
  // require already having a key, which is the same reason a model listing is
  // readable before you have one. Nothing here names the relay, the operator
  // or a credential: only what the agent is for and which tools it exposes.
  if (request.method === "GET" || request.method === "HEAD") {
    if (path === "/agents") {
      catalogHeaders(response);
      json(response, 200, { object: "list", data: agents.map(toPublicAgent) });
      return;
    }
    if (path.startsWith("/agents/")) {
      const entry = catalog?.byName.get(decodeURIComponent(path.slice("/agents/".length)));
      catalogHeaders(response);
      if (!entry) {
        json(response, 404, { error: "No agent by that name is hosted here.", known: agents.map((item) => item.definition.name) });
        return;
      }
      json(response, 200, toPublicAgent(entry));
      return;
    }
    // A page only where there is something on it. Without a catalog this
    // stays a 404, which is what a deployment predating agents already had.
    if (path === "/" && catalog) {
      catalogHeaders(response);
      html(response, indexPage(agents));
      return;
    }
  }

  // A browser fetching the catalog from a page sends a preflight. Answered
  // for the catalog only: /mcp carries a bearer key, and a cross-origin page
  // should not be able to spend one it happens to have.
  if (request.method === "OPTIONS" && (path === "/agents" || path.startsWith("/agents/"))) {
    catalogHeaders(response);
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.writeHead(204);
    response.end();
    return;
  }

  // /mcp is every tool this deployment exposes. /mcp/<agent> is one agent's
  // subset. Both talk to the same relay with the caller's own key; the only
  // difference is what got registered before the client saw the list.
  let requested: CatalogEntry | undefined;
  if (path !== "/mcp") {
    if (!path.startsWith("/mcp/")) {
      json(response, 404, { error: "Not found.", catalog: "/agents" });
      return;
    }
    requested = catalog?.byName.get(decodeURIComponent(path.slice("/mcp/".length)));
    if (!requested) {
      json(response, 404, {
        error: "No agent by that name is hosted here.",
        known: agents.map((item) => item.definition.name),
        catalog: "/agents",
      });
      return;
    }
  }

  // The SDK's stateless transport answers POST. GET and DELETE belong to
  // session-based transports, and answering them here would suggest a session
  // this server does not keep.
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    json(response, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed for this stateless MCP server." },
      id: null,
    });
    return;
  }

  const apiKey = bearer(request);
  if (!apiKey) {
    // 401 with a challenge, because a client that omitted the header should be
    // told what to send rather than left guessing at a generic refusal.
    response.setHeader("www-authenticate", 'Bearer realm="lnkz"');
    json(response, 401, { error: "Send your LNKZ relay key as Authorization: Bearer <key>." });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too-large";
    json(response, tooLarge ? 413 : 400, {
      error: tooLarge ? "Request body is too large." : "Malformed JSON request.",
    });
    return;
  }

  // A client and a server per request. Both are cheap, and neither outliving
  // the request is what keeps one caller's key from reaching another's call.
  //
  // The agent's options are derived here rather than at load time, so the
  // deployment's own scope setting is re-applied on every request. An agent
  // asking for write on a read-only host gets read, whatever the catalog was
  // built with.
  const perRequest: McpServerOptions = requested
    ? {
        ...options,
        allowWrites: (options.allowWrites ?? true) && requested.definition.scopes.includes("write"),
        tools: requested.activeTools,
        instructions: requested.definition.instructions,
      }
    : options;
  const server = createLnkzMcpServer(new LnkzClient(baseUrl, apiKey), perRequest);

  // Omitted rather than set to undefined. Stateless is the absence of a
  // session id generator, and under exactOptionalPropertyTypes an optional
  // property cannot be handed an explicit undefined. Same object at runtime.
  const transport = new StreamableHTTPServerTransport({});
  response.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  // The cast is friction between the SDK's types and
  // exactOptionalPropertyTypes, not a real mismatch: the transport declares
  // `onclose?: (() => void) | undefined` where the Transport interface asks
  // for `onclose?: () => void`, which that flag treats as incompatible even
  // though every implementation satisfies both. Narrow and commented rather
  // than relaxing the flag for the whole project.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(request, response, body);
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // Checked as it arrives rather than after. A cap enforced once the body is
    // already in memory is not a cap.
    if (size > MAX_BODY_BYTES) throw new Error("too-large");
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}


function catalogHeaders(response: ServerResponse): void {
  // Public, so readable from anywhere. Applied to the catalog and never to
  // /mcp, which takes a bearer key.
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

/**
 * A page, because a hosted catalog nobody can look at is a catalog nobody
 * adopts. One static string, no script, no network: someone handed a URL can
 * see what is here and copy the endpoint they want into their client.
 *
 * The colour, type and depth values are Magentic's, inlined rather than
 * linked so this page has no runtime file dependency. brand/tokens.css is
 * the source of truth and is right when the two diverge.
 *
 * The relay this server talks to is deliberately not printed, and is not
 * even passed in. Which relay an operator points at is their business, and
 * this page is public.
 */
function indexPage(agents: readonly CatalogEntry[]): string {
  const toolTotal = agents.reduce((sum, entry) => sum + entry.activeTools.size, 0);

  const rows = agents.length
    ? agents.map((entry, position) => {
        const { definition } = entry;
        const tools = [...entry.activeTools].sort();
        const access = entry.writesAllowed ? "read + write" : "read";
        // The first one leads. Equal weight on every row is how a list stops
        // having a shape.
        const lead = position === 0;
        return `<article class="${lead ? "agent lead" : "agent"}">
  <div class="agent-main">
    <h2>${escapeHtml(definition.title)}<span class="ver">v${escapeHtml(definition.version)}</span></h2>
    <p>${escapeHtml(definition.description)}</p>
    <p class="endpoint"><code>${escapeHtml(entry.endpoint)}</code></p>
  </div>
  <div class="agent-meta">
    <span class="count">${tools.length} tools</span>
    <span>${access}</span>
    <span>${escapeHtml(definition.publisher)}</span>
  </div>
  <details><summary>What it can do</summary><p class="tools">${tools.map((tool) => `<code>${escapeHtml(tool)}</code>`).join(" ")}</p></details>
</article>`;
      }).join("\n")
    : `<article class="agent"><div class="agent-main"><h2>No agents configured</h2><p>Every tool this deployment has is still available at <code>/mcp</code>.</p></div></article>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magentic</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0A0610; --surface-1:#130D1C; --surface-2:#1B1327;
  --line:#2C2140; --line-strong:#3E2F58;
  --text:#F2EDF8; --text-2:#B0A4C4; --text-3:#8B7DA3;
  --accent:#E84BA3; --on-accent:#12060E; --live:#34E0B0;
  --sans:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#FAF7FD; --surface-1:#FFFFFF; --surface-2:#F3EEFA;
    --line:#E4DCF0; --line-strong:#CFC2E4;
    --text:#140D1F; --text-2:#4E4361; --text-3:#6B5F80;
    --accent:#B22273; --on-accent:#FFFFFF; --live:#0C8F70;
  }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); -webkit-font-smoothing:antialiased; }
.wrap { width:min(960px, 100% - 32px); margin:0 auto; padding:56px 0 72px; }
.mark { font-family:var(--mono); font-size:13px; color:var(--text-3); letter-spacing:.02em; }
.mark b { color:var(--text); font-weight:500; }
.mark i { color:var(--accent); font-style:normal; }
h1 { margin:14px 0 0; font-size:clamp(40px,9vw,64px); font-weight:600; letter-spacing:-.04em; line-height:.96; }
.lede { margin:18px 0 0; max-width:34em; font-size:17px; line-height:1.6; color:var(--text-2); }
.counts { display:flex; gap:32px; margin:28px 0 0; }
.counts div { font-family:var(--mono); font-size:24px; font-weight:500; font-variant-numeric:tabular-nums; }
.counts span { display:block; font-family:var(--sans); font-size:12px; font-weight:400; color:var(--text-3); }
hr { border:0; border-top:1px solid var(--line); margin:40px 0 0; }
.agent { padding:24px 0; border-bottom:1px solid var(--surface-2); display:grid; grid-template-columns:1fr auto; gap:8px 24px; }
.agent.lead { padding-top:28px; }
.agent-main h2 { margin:0; font-size:19px; font-weight:500; letter-spacing:-.01em; }
.agent.lead .agent-main h2 { font-size:30px; font-weight:600; letter-spacing:-.025em; }
.ver { margin-left:10px; font-family:var(--mono); font-size:12px; font-weight:400; color:var(--text-3); letter-spacing:0; }
.agent-main p { margin:8px 0 0; max-width:52ch; font-size:14px; line-height:1.55; color:var(--text-2); }
.agent.lead .agent-main p { font-size:15px; line-height:1.6; }
.endpoint code { display:inline-block; margin-top:4px; padding:4px 8px; border:1px solid var(--line); border-radius:4px; font-family:var(--mono); font-size:12px; color:var(--text-2); }
.agent-meta { text-align:right; font-family:var(--mono); font-size:12px; font-variant-numeric:tabular-nums; color:var(--text-3); display:flex; flex-direction:column; gap:3px; }
.agent-meta .count { color:var(--text); }
details { grid-column:1 / -1; margin-top:10px; }
summary { font-size:13px; color:var(--text-3); cursor:pointer; }
summary:hover { color:var(--text-2); }
.tools { margin:10px 0 0; }
.tools code { display:inline-block; margin:2px 4px 2px 0; padding:3px 7px; border-radius:4px; background:var(--surface-2); font-family:var(--mono); font-size:11px; color:var(--text-2); }
footer { margin-top:44px; font-size:13px; line-height:1.7; color:var(--text-3); }
footer code { font-family:var(--mono); font-size:12px; color:var(--text-2); }
footer p { margin:0 0 10px; max-width:60ch; }
.live { display:inline-flex; align-items:center; gap:8px; }
.live i { width:6px; height:6px; border-radius:999px; background:var(--live); font-style:normal; }
a { color:var(--accent); }
:focus-visible { outline:3px solid color-mix(in srgb, var(--accent) 24%, transparent); outline-offset:2px; }
@media (max-width:640px) {
  .agent { grid-template-columns:1fr; }
  .agent-meta { text-align:left; flex-direction:row; gap:14px; }
}
</style></head>
<body>
<div class="wrap">
<p class="mark"><b>magentic</b><i>.ai</i></p>
<h1>Agents</h1>
<p class="lede">Each one is a fixed set of tools over one conversation relay. Point an MCP client at an endpoint below and send your own relay key as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
<div class="counts">
  <div>${agents.length}<span>hosted here</span></div>
  <div>${toolTotal}<span>tools across them</span></div>
</div>
<hr>
${rows}
<footer>
<p class="live"><i></i> This server holds no credential. It reads nothing and writes nothing on its own behalf; each request acts as whoever sent the key.</p>
<p>Machine-readable catalog at <code>/agents</code> and <code>/agents/&lt;name&gt;</code>. Every tool this deployment has, unfiltered, at <code>/mcp</code>. Liveness at <code>/health</code>.</p>
</footer>
</div>
</body></html>`;
}
