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
 * adopts. It is one static string with no script and no network calls: the
 * point is that someone handed a URL can see what is here and copy the
 * endpoint they want into their client.
 *
 * The relay this server talks to is deliberately not printed, and is not
 * even passed in. Which relay an operator points at is their business, and
 * this page is public.
 */
function indexPage(agents: readonly CatalogEntry[]): string {
  const cards = agents.length
    ? agents.map((entry) => {
        const { definition } = entry;
        const tools = [...entry.activeTools].sort();
        return `<article>
  <h2>${escapeHtml(definition.title)} <code>${escapeHtml(definition.name)}</code></h2>
  <p>${escapeHtml(definition.description)}</p>
  <p class="meta">${escapeHtml(definition.category)} &middot; v${escapeHtml(definition.version)} &middot; ${escapeHtml(definition.publisher)} &middot; ${entry.writesAllowed ? "read and write" : "read only"}</p>
  <p class="endpoint"><code>${escapeHtml(entry.endpoint)}</code></p>
  <details><summary>${tools.length} tools</summary><p class="tools">${tools.map((tool) => `<code>${escapeHtml(tool)}</code>`).join(" ")}</p></details>
</article>`;
      }).join("\n")
    : "<article><p>No agents are configured on this server. Every tool is still available at <code>/mcp</code>.</p></article>";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LNKZ MCP</title>
<style>
:root { color-scheme: light dark; --edge: #8883; }
body { margin: 0 auto; padding: 2rem 1rem 4rem; max-width: 46rem; font: 16px/1.6 system-ui, sans-serif; }
h1 { margin-bottom: .25rem; font-size: 1.5rem; }
.lede { margin-top: 0; opacity: .75; }
article { border: 1px solid var(--edge); border-radius: .5rem; padding: 1rem 1.25rem; margin: 1rem 0; }
h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
h2 code { font-size: .8rem; opacity: .6; font-weight: 400; }
.meta { font-size: .85rem; opacity: .7; }
.endpoint code { padding: .15rem .4rem; border: 1px solid var(--edge); border-radius: .25rem; }
.tools code { display: inline-block; font-size: .8rem; margin: .1rem .2rem .1rem 0; opacity: .8; }
footer { margin-top: 2rem; font-size: .9rem; opacity: .7; }
</style></head>
<body>
<h1>LNKZ MCP</h1>
<p class="lede">Agents hosted here. Each is a fixed set of tools over one conversation relay. Point an MCP client at an endpoint below and send your own relay key as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
${cards}
<footer>
<p>Machine-readable catalog: <code>/agents</code> and <code>/agents/&lt;name&gt;</code>. Every tool this deployment has, unfiltered: <code>/mcp</code>. Liveness: <code>/health</code>.</p>
<p>This server holds no credential. It reads nothing and writes nothing on its own behalf; each request acts as whoever sent the key.</p>
</footer>
</body></html>`;
}
