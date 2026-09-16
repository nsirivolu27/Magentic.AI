import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LnkzClient } from "./client.js";
import { createLnkzMcpServer, type McpServerOptions } from "./mcp.js";

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

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle(baseUrl, options, request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "Internal server error." });
    });
  };
}

export function createAdapterHttpServer(config: AdapterHttpConfig) {
  return createServer(createRequestHandler(config));
}

async function handle(
  baseUrl: string,
  options: McpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Unauthenticated on purpose and carrying nothing: hosting platforms need a
  // probe, and a probe that requires a credential is a probe nobody runs.
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, relay: baseUrl });
    return;
  }

  const path = (request.url ?? "").split("?")[0];
  if (path !== "/mcp") {
    json(response, 404, { error: "Not found." });
    return;
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
  const server = createLnkzMcpServer(new LnkzClient(baseUrl, apiKey), options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  await server.connect(transport);
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

