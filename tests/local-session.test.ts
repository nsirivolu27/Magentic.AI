import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalSession, SESSION_COOKIE, type LocalSession } from "../workbench/local-session.js";

const WS = "local-workspace";
const OWNER = "local-owner";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "magentic-session-"));
}

/**
 * A server that runs the real guard and authenticate against real requests,
 * so these tests exercise headers and cookies rather than function calls.
 */
async function hosted(session: LocalSession) {
  const server = createServer(async (request, response) => {
    const refusal = session.guard(request, response);
    if (refusal) { response.writeHead(refusal.status); response.end(refusal.message); return; }
    if ((request.url ?? "/") === "/") { response.writeHead(200); response.end("<!doctype html>"); return; }
    const identity = await session.authenticate(request);
    if (!identity) { response.writeHead(401); response.end("unauthenticated"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(identity));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  session.setPort(address.port);
  return { server, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

function makeSession(dir: string, overrides: Partial<Parameters<typeof createLocalSession>[0]> = {}): LocalSession {
  return createLocalSession({ dataDir: dir, workspaceId: WS, actor: OWNER, ...overrides });
}

test("the application window claims a session once, and later arrivals get none", async (t) => {
  const session = makeSession(scratch());
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  session.arm();
  const first = await fetch(`${base}/`);
  const cookie = first.headers.get("set-cookie");
  assert.ok(cookie?.startsWith(`${SESSION_COOKIE}=`), "the window that opens first is handed the session");
  assert.match(cookie!, /HttpOnly/);
  assert.match(cookie!, /SameSite=Strict/);
  assert.equal(session.claimed(), true);

  const second = await fetch(`${base}/`);
  assert.equal(second.headers.get("set-cookie"), null, "a second arrival gets nothing");
});

test("no session is issued outside the bootstrap window", async (t) => {
  const session = makeSession(scratch(), { bootstrapWindowMs: 1, now: () => 1_000 });
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  // Never armed.
  assert.equal((await fetch(`${base}/`)).headers.get("set-cookie"), null);
});

test("the session cookie authenticates, and a wrong one does not", async (t) => {
  const session = makeSession(scratch());
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  session.arm();
  const cookie = (await fetch(`${base}/`)).headers.get("set-cookie")!.split(";")[0]!;

  const good = await fetch(`${base}/api/workspace`, { headers: { cookie } });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { workspaceId: WS, actor: OWNER });

  const bad = await fetch(`${base}/api/workspace`, { headers: { cookie: `${SESSION_COOKIE}=not-the-secret` } });
  assert.equal(bad.status, 401);
});

test("local mode rejects the public demo bearer values", async (t) => {
  const session = makeSession(scratch());
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  for (const demo of ["alex.writer", "sam.reviewer", "jordan.reviewer", "taylor.admin"]) {
    const response = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${demo}` } });
    assert.equal(response.status, 401, `${demo} must not be a credential in local mode`);
  }
});

test("a standalone MCP client authenticates with its own token, not the cookie", async (t) => {
  const dir = scratch();
  const session = makeSession(dir);
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  const token = session.mcpToken();
  assert.ok(token.length >= 32);
  const response = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);

  // The cookie secret is not a bearer, and the bearer is not a cookie.
  session.arm();
  const cookie = (await fetch(`${base}/`)).headers.get("set-cookie")!.split(";")[0]!;
  const secret = cookie.split("=").slice(1).join("=");
  assert.notEqual(secret, token, "the two credential classes must be different secrets");
  const asBearer = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(asBearer.status, 401, "a browser secret is not accepted as an MCP bearer");
  const asCookie = await fetch(`${base}/api/workspace`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(asCookie.status, 401, "an MCP token is not accepted as a browser session");
});

test("session secrets are unpredictable and change on restart", () => {
  const dir = scratch();
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const session = makeSession(dir);
    seen.add(session.mcpToken());
  }
  // The MCP token is stable on purpose: a client configured once keeps working.
  assert.equal(seen.size, 1, "the MCP token survives restarts");

  // The browser secret must not. Two starts, two different cookies.
  const cookies = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const session = makeSession(dir);
    session.setPort(1);
    session.arm();
    let issued = "";
    session.guard(
      { method: "GET", url: "/", headers: { host: "127.0.0.1:1" } } as never,
      { setHeader: (_: string, value: string) => { issued = value; } } as never,
    );
    cookies.add(issued);
  }
  assert.equal(cookies.size, 2, "every start mints a new browser session");
});

/** fetch refuses to forge a Host header, so this speaks HTTP directly. */
function rawRequest(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET /api/workspace HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("timed out")); });
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

test("an unexpected Host is refused before anything else runs", async (t) => {
  const session = makeSession(scratch());
  const { server, port } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  const refused = await rawRequest(port, "evil.example");
  assert.match(refused.split("\r\n")[0] ?? "", /400/, "a Host we never bound is refused");

  const accepted = await rawRequest(port, `127.0.0.1:${port}`);
  assert.match(accepted.split("\r\n")[0] ?? "", /401/, "the right Host gets as far as authentication");
});

test("cross-site requests are refused, with and without a valid credential", async (t) => {
  const session = makeSession(scratch());
  const { server, base } = await hosted(session);
  t.after(() => { server.close(); server.closeAllConnections(); });

  session.arm();
  const cookie = (await fetch(`${base}/`)).headers.get("set-cookie")!.split(";")[0]!;

  const post = await fetch(`${base}/api/workspace`, {
    method: "POST", headers: { cookie, origin: "http://evil.example", "content-type": "application/json" }, body: "{}",
  });
  assert.equal(post.status, 403, "a state changing request from another origin is refused");

  const read = await fetch(`${base}/api/workspace`, { headers: { cookie, origin: "http://evil.example" } });
  assert.equal(read.status, 403, "and so is a cross-origin read of an API route");

  const same = await fetch(`${base}/api/workspace`, { headers: { cookie, origin: base } });
  assert.equal(same.status, 200, "our own page still works");
});

test("the MCP token file is created with owner-only permissions", () => {
  const dir = scratch();
  const session = makeSession(dir);
  const path = join(dir, "mcp-token");
  assert.equal(readFileSync(path, "utf8").trim(), session.mcpToken());
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o077, 0, "no group or world access");
  }
});
