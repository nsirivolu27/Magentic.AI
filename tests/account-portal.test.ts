import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { accountsSchema, clerkActor, validateClerkKey, type AccountsConfig } from "../workbench/accounts.js";
import { createBilling } from "../workbench/billing.js";
import { accountPage } from "../workbench/account-view.js";
import { accountPublicConfig, loginPage } from "../workbench/account-portal.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { memoryAudit } from "../registry/audit.js";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalWorkbench } from "../workbench/local.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: AccountsConfig = {
  clerk: { issuer: "https://example.clerk.accounts.dev", publishableKey: `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), authorizedParties: ["http://127.0.0.1:4184"] },
  members: [{ workspaceId: "workspace", actor: "user_admin", roles: ["admin"] }, { workspaceId: "workspace", actor: "user_reader", roles: ["author"] }],
  billing: { priceId: "price_team", customers: [{ workspaceId: "workspace", customerId: "cus_team" }] },
};
const now = Math.floor(Date.now() / 1000);
function token(overrides: object = {}, header: object = {}) {
  const data = [Buffer.from(JSON.stringify({ alg: "RS256", ...header })).toString("base64url"), Buffer.from(JSON.stringify({ iss: config.clerk.issuer,
    azp: config.clerk.authorizedParties[0], sub: "user_admin", sid: "sess_one", iat: now, nbf: now - 1, exp: now + 60, ...overrides })).toString("base64url")].join(".");
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url")}`;
}
test("Clerk verification refuses altered, expired, premature, pending and foreign sessions", () => {
  validateClerkKey(config);
  assert.equal(clerkActor(token(), config), "user_admin");
  for (const invalid of [token({ exp: now - 1 }), token({ nbf: now + 100 }), token({ iat: now + 100 }), token({ sts: "pending" }),
    token({ azp: "https://foreign.example" }), token({ iss: "https://foreign.example" }), token({ sub: "local-owner" }), token({}, { alg: "none" }),
    token().replace(/.$/, "!"), "not-a-token"]) assert.equal(clerkActor(invalid, config), undefined);
  const parts = token().split(".");
  parts[1] = Buffer.from(JSON.stringify({ sub: "user_other" })).toString("base64url");
  assert.equal(clerkActor(parts.join("."), config), undefined);
});
test("account configuration rejects unknown keys, duplicate membership and shared billing customers", () => {
  assert.ok(accountsSchema.safeParse(config).success);
  assert.equal(accountsSchema.safeParse({ ...config, unknown: true }).success, false);
  assert.equal(accountsSchema.safeParse({ ...config, members: [...config.members, config.members[0]] }).success, false);
  assert.equal(accountsSchema.safeParse({ ...config, billing: { ...config.billing, customers: [{ workspaceId: "one", customerId: "cus_shared" }, { workspaceId: "two", customerId: "cus_shared" }] } }).success, false);
  assert.throws(() => validateClerkKey({ ...config, clerk: { ...config.clerk, issuer: "https://other.example" } }));
});
test("public login config contains no membership, public verification key or billing data", () => {
  assert.deepEqual(Object.keys(accountPublicConfig(config)).sort(), ["enabled", "issuer", "publishableKey"]);
  assert.match(loginPage(), /Open local workspace/);
  assert.doesNotMatch(loginPage(config), /Open local workspace/);
  assert.match(accountPage({ managed: false, actor: "<script>", workspaceId: "workspace", canManageBilling: true }).body, /&lt;script&gt;/);
});

function stripeFake(options: { active?: boolean; pending?: boolean; badUrl?: boolean; failure?: boolean } = {}) {
  const calls: { path: string; fields: URLSearchParams; headers: Record<string, string> }[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.stripe.com/v1/", "");
    calls.push({ path, fields: new URLSearchParams(String(init?.body ?? "")), headers: init?.headers as Record<string, string> });
    if (options.failure) throw new Error("secret test credential must not leak");
    const data = path.startsWith("subscriptions?") ? { data: options.active ? [{ status: "active" }] : [], has_more: false }
      : path.startsWith("prices/") ? { unit_amount: 2900, currency: "usd", recurring: { interval: "month", interval_count: 1 }, active: true, livemode: false }
      : path.startsWith("checkout/sessions?") ? { data: options.pending ? [{ mode: "subscription", metadata: { magentic_workspace: "workspace", magentic_price: "price_team" }, url: "https://checkout.stripe.com/pending" }] : [], has_more: false }
      : { url: options.badUrl ? "https://attacker.example" : path === "billing_portal/sessions" ? "https://billing.stripe.com/session" : "https://checkout.stripe.com/session" };
    return Response.json(data);
  }) as typeof fetch;
  return { calls, billing: createBilling(config.billing, "sk_test_example", transport) };
}
test("Stripe checkout binds the server's customer and price and uses an idempotency key", async () => {
  const { billing, calls } = stripeFake();
  await billing.open("workspace", { action: "checkout", requestId: randomUUID() }, "http://127.0.0.1:4184");
  const created = calls.find(call => call.path === "checkout/sessions")!;
  assert.equal(created.fields.get("customer"), "cus_team");
  assert.equal(created.fields.get("line_items[0][price]"), "price_team");
  assert.match(created.headers["Idempotency-Key"]!, /^[a-f0-9]{64}$/);
  await assert.rejects(billing.open("workspace", { action: "checkout", requestId: randomUUID(), customer: "cus_other" }, "http://127.0.0.1:4184"));
  await assert.rejects(billing.open("other", { action: "checkout", requestId: randomUUID() }, "http://127.0.0.1:4184"), /configure Stripe/);
});
test("existing subscriptions block checkout and pending sessions are reused", async () => {
  const active = stripeFake({ active: true });
  await assert.rejects(active.billing.open("workspace", { action: "checkout", requestId: randomUUID() }, "http://127.0.0.1:4184"), /already has a subscription/);
  const pending = stripeFake({ pending: true });
  assert.equal((await pending.billing.open("workspace", { action: "checkout", requestId: randomUUID() }, "http://127.0.0.1:4184")).url, "https://checkout.stripe.com/pending");
  assert.equal(pending.calls.some(call => call.path === "checkout/sessions"), false);
});
test("Stripe errors are sanitized and redirects cannot leave Stripe", async () => {
  await assert.rejects(stripeFake({ badUrl: true }).billing.open("workspace", { action: "portal", requestId: randomUUID() }, "http://127.0.0.1:4184"), /valid portal address/);
  await assert.rejects(stripeFake({ failure: true }).billing.inspect("workspace"), error => error instanceof Error && !error.message.includes("secret") && error.message.includes("unavailable"));
  assert.equal((await createBilling(undefined, undefined).inspect("workspace")).configured, false);
});
test("account HTTP routes protect billing, filter workspaces and refuse cross-workspace opening", async t => {
  const settings = structuredClone(config);
  const { billing, calls } = stripeFake();
  const server = createWorkbenchServer({ accounts: settings, billing, assets: new Map(), context: { store: memoryStore(), audit: memoryAudit(), members: memoryMembers(settings.members) },
    authenticate: async request => {
      const actor = clerkActor(request.headers.authorization?.slice(7) ?? "", settings);
      return actor ? { actor, workspaceId: "workspace" } : undefined;
    },
    workspaces: { has: () => true, mcpWorkspaceId: "workspace", create: () => { throw new Error("Should not create"); }, open: () => { throw new Error("Should not mutate"); },
      list: () => ({ workspaces: [{ id: "workspace", name: "Visible", createdAt: "today" }, { id: "private", name: "Hidden", createdAt: "today" }], lastWorkspaceId: "private", storage: "file", directory: "secret/path" }) },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  settings.clerk.authorizedParties.push(origin);
  const request = (path: string, actor?: string, body?: unknown, overrideOrigin = origin) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: overrideOrigin,
      ...(actor ? { Authorization: `Bearer ${token({ sub: actor })}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await request("/login")).status, 200);
  assert.equal((await request("/api/account")).status, 401);
  assert.equal((await request("/api/account", "user_stranger")).status, 403);
  const listing = await (await request("/api/workspaces", "user_admin")).json();
  assert.deepEqual(listing.workspaces.map((entry: any) => entry.id), ["workspace"]);
  assert.equal(JSON.stringify(listing).includes("secret/path"), false);
  const command = { action: "portal", requestId: randomUUID() };
  assert.equal((await request("/api/account/billing", "user_reader", command)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request("/api/account/billing", "user_admin", command, "https://attacker.example")).status, 403);
  assert.equal((await request("/api/workspaces/open", "user_admin", { workspaceId: "private" })).status, 403);
  assert.equal((await request("/api/workspaces/mcp-access", "user_admin", {})).status, 403);
  assert.equal((await request("/api/workspaces/open", "user_reader", { workspaceId: "workspace" })).status, 200);
  assert.equal((await request("/api/account/billing", "user_admin", command)).status, 200);
});

test("managed local runtime rejects bootstrap and legacy MCP credentials but accepts verified members", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magentic-accounts-"));
  const assets = join(dir, "assets"); mkdirSync(assets);
  const source = fileURLToPath(new URL("../../workbench/", import.meta.url));
  for (const file of ["index.html", "styles.css", "agency.css", "pipeline.css", "chat.css", "theme.css", "mcp.css", "email.css", "manifest.webmanifest", "icon.svg"]) copyFileSync(join(source, file), join(assets, file));
  writeFileSync(join(assets, "app.js"), "/* HTTP fixture */");
  const settings = join(dir, "accounts.json"); writeFileSync(settings, JSON.stringify(config));
  const priorFile = process.env.MAGENTIC_ACCOUNTS_FILE;
  const priorAssets = process.env.MAGENTIC_WORKBENCH_ASSETS;
  process.env.MAGENTIC_ACCOUNTS_FILE = settings;
  process.env.MAGENTIC_WORKBENCH_ASSETS = assets;
  let app: Awaited<ReturnType<typeof startLocalWorkbench>> | undefined;
  try {
    app = await startLocalWorkbench({ dataDir: join(dir, "data") });
    const page = await fetch(app.url, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    const request = (path: string, credential?: string, cookie?: string) => fetch(new URL(path, app!.url), {
      method: path === "/api/pipeline-mcp" ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(path === "/api/pipeline-mcp" ? { body: "{}" } : {}),
    });
    assert.equal((await request("/api/workspace")).status, 401);
    assert.equal((await request("/api/pipeline-mcp", app.session.mcpToken())).status, 401);
    assert.equal((await request("/api/workspace", undefined, `__session=${token({ sub: "user_reader" })}`)).status, 200);
    assert.equal((await request("/api/workspace", undefined, `__session=${token({ sub: "user_stranger" })}`)).status, 403);
    assert.equal((await request("/api/workspace", token({ exp: now - 1 }))).status, 401);
    const other = await fetch(new URL("/api/workspace", app.url), { headers: { Authorization: `Bearer ${token()}`, "X-Magentic-Workspace": "private" } });
    assert.equal(other.status, 401);
  } finally {
    await app?.close();
    if (priorFile === undefined) delete process.env.MAGENTIC_ACCOUNTS_FILE; else process.env.MAGENTIC_ACCOUNTS_FILE = priorFile;
    if (priorAssets === undefined) delete process.env.MAGENTIC_WORKBENCH_ASSETS; else process.env.MAGENTIC_WORKBENCH_ASSETS = priorAssets;
    rmSync(dir, { recursive: true, force: true });
  }
});
