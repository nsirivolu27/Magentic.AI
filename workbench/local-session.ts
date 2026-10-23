import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceIdentity } from "./server.js";

/**
 * The local application's session boundary.
 *
 * What this defends against, honestly: a page in the user's browser on
 * another origin reaching this server, a stale tab from a previous run, and
 * a process that connects to the port after startup without a credential.
 *
 * What it cannot defend against: a malicious process running as the same OS
 * user. That process can read this user's files, including the MCP token,
 * and can attach to this user's browser profile. A loopback application
 * session is not enterprise authentication and no arrangement of tokens here
 * changes that. The operating system account is the real boundary.
 *
 * Two credential classes, deliberately separate:
 *
 *   The browser session is a cookie, HttpOnly and SameSite=Strict, minted in
 *   memory at startup and gone when the process exits. It is never written
 *   to disk, never put in a URL, and never logged.
 *
 *   A standalone MCP client uses a bearer token kept in the data directory
 *   with owner-only permissions. It survives restarts on purpose, because a
 *   client configured once should keep working, and it is rotated by
 *   deleting the file.
 *
 * The browser can never present the MCP token and the MCP client can never
 * present the cookie, so revoking one does not touch the other.
 */

export const SESSION_COOKIE = "magentic_session";
const TOKEN_FILE = "mcp-token";

export function loadMcpToken(tokenPath: string): string {
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid MCP credential file. Restore or explicitly remove it before restarting.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = secret();
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  }
  try { chmodSync(tokenPath, 0o600); } catch { /* Windows relies on the per-user directory ACL. */ }
  return token;
}

export interface LocalSessionOptions {
  /** Where the MCP token lives. The same data directory the store uses. */
  dataDir: string;
  /** The workspace this session is scoped to. Enforced server-side. */
  workspaceId: string;
  /** The single local owner. Requests never choose their own actor. */
  actor: string;
  /** The loopback port, for Host and Origin checks. Set once bound. */
  port?: number;
  /** How long after arming the UI may claim its session. Default 60s. */
  bootstrapWindowMs?: number;
  now?: () => number;
  resolveMcpWorkspace?: (token: string) => string | undefined;
}

export interface LocalSession {
  /** Open the one-shot window in which the application window may claim a session. */
  arm(): void;
  /** Called once the server has a port. Host and Origin checks need it. */
  setPort(port: number): void;
  /** Runs before anything else. Returns an error to send, or undefined to continue. */
  guard(request: IncomingMessage, response: ServerResponse): { status: number; message: string } | undefined;
  /** The authenticate callback the workbench server takes. */
  authenticate(request: IncomingMessage): Promise<WorkspaceIdentity | undefined>;
  /** The bearer a standalone MCP client presents. Shown on request, never logged. */
  mcpToken(): string;
  /** True once the application window has taken its session. */
  claimed(): boolean;
  browserAuthenticated(request: IncomingMessage): boolean;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant time, and false rather than throwing on a length mismatch. */
export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieFrom(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Only these hosts, and only on the port we actually bound. */
function hostAllowed(host: string | undefined, port: number | undefined): boolean {
  if (!host || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function originAllowed(origin: string | undefined, port: number | undefined): boolean {
  if (port === undefined) return false;
  // A same-origin fetch from our own page sends one of these. Anything else,
  // including a null origin, is another site and is refused.
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}

export function createLocalSession(options: LocalSessionOptions): LocalSession {
  const { dataDir, workspaceId, actor } = options;
  const now = options.now ?? Date.now;
  const windowMs = options.bootstrapWindowMs ?? 60_000;

  // In memory only. A restart invalidates every browser session, which is
  // what makes a stale tab from the last run harmless.
  const browserSecret = secret();
  let port = options.port;
  let armedUntil = 0;
  let taken = false;

  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, TOKEN_FILE);
  const token = loadMcpToken(tokenPath);
  const browserAuthenticated = (request: IncomingMessage) => sameSecret(cookieFrom(request.headers.cookie, SESSION_COOKIE) ?? "", browserSecret);
  const bearerWorkspace = (request: IncomingMessage): string | undefined => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    const presented = header.slice(7).trim();
    return sameSecret(presented, token) ? workspaceId : options.resolveMcpWorkspace?.(presented);
  };

  return {
    browserAuthenticated,
    arm() {
      armedUntil = now() + windowMs;
      taken = false;
    },

    setPort(value) {
      port = value;
    },

    claimed() {
      return taken;
    },

    mcpToken() {
      return token;
    },

    guard(request, response) {
      if (!hostAllowed(request.headers.host, port)) {
        // A Host we did not bind means DNS rebinding or a proxy, not our own
        // window. Refused before anything else looks at the request.
        return { status: 400, message: "Unexpected Host header." };
      }

      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const origin = request.headers.origin;

      // Browser writes require our origin. A standalone MCP client has no
      // browser origin, so its separately scoped credential authenticates it.
      const standalone = (path === "/api/mcp" || path === "/api/pipeline-mcp") && bearerWorkspace(request) !== undefined;
      if (method !== "GET" && method !== "HEAD" && !originAllowed(origin, port) && !(origin === undefined && standalone)) {
        return { status: 403, message: "Cross-site requests are not accepted." };
      }
      // A foreign page must not claim the bootstrap cookie through navigation.
      if ((origin !== undefined && !originAllowed(origin, port)) || request.headers["sec-fetch-site"] === "cross-site") {
        return { status: 403, message: "Cross-site requests are not accepted." };
      }

      // The one-shot bootstrap. The application window asks for the page it
      // was told to open; if the window is open and nobody has claimed a
      // session yet, this response carries one. After that the window closes
      // and later arrivals get nothing.
      if (method === "GET" && path === "/" && !browserAuthenticated(request)) {
        if (!taken && now() < armedUntil) {
          taken = true;
          armedUntil = 0;
          response.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${browserSecret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          );
        }
      }
      return undefined;
    },

    async authenticate(request) {
      if (browserAuthenticated(request)) return { workspaceId, actor };
      const boundWorkspace = bearerWorkspace(request);
      if (boundWorkspace !== undefined) return { workspaceId: boundWorkspace, actor };
      return undefined;
    },
  };
}
