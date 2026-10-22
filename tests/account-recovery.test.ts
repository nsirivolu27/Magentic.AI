import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createBilling } from "../workbench/billing.js";
import { formatBillingAmount, billingStatusLabel } from "../workbench/billing-display.js";
import { accountPage } from "../workbench/account-view.js";
import { accountClientScript } from "../workbench/account-portal.js";
import { accountsSchema } from "../workbench/accounts.js";

const config = { priceId: "price_standard", customers: [{ workspaceId: "workspace", customerId: "cus_workspace" }] };
const origin = "http://127.0.0.1:4182";
const price = { id: config.priceId, unit_amount: 2900, currency: "usd", active: true, livemode: false,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, billing_scheme: "per_unit", type: "recurring", transform_quantity: null, custom_unit_amount: null };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; headers: Record<string, string>; body: string }[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.stripe.com/v1/", "");
    calls.push({ path, headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") });
    const route = path.split("?")[0]! + (init?.method === "POST" ? ":POST" : "");
    const defaults: Record<string, unknown> = {
      subscriptions: { data: [], has_more: false }, ["prices/" + config.priceId]: price,
      "checkout/sessions": { data: [], has_more: false },
      "checkout/sessions:POST": { url: "https://checkout.stripe.com/session", customer: "cus_workspace", livemode: false },
      "billing_portal/sessions:POST": { url: "https://billing.stripe.com/session", customer: "cus_workspace", livemode: false },
    };
    const body = Object.hasOwn(overrides, route) ? overrides[route] : defaults[route];
    if (body instanceof Error) throw body;
    return Response.json(body);
  }) as typeof fetch;
  return { calls, billing: createBilling(config, "sk_test_fixture", transport) };
}
const checkout = () => ({ action: "checkout", requestId: randomUUID() });

test("billing management remains available when the purchase price is broken", async () => {
  const { billing, calls } = fixture({ ["prices/" + config.priceId]: new Error("provider credential must stay private") });
  const status = await billing.inspect("workspace");
  assert.equal(status.checkout, false);
  assert.equal(status.portal, true);
  assert.match(status.detail!, /Stripe is unavailable/);
  assert.doesNotMatch(status.detail!, /credential/);
  const count = calls.length;
  assert.equal((await billing.open("workspace", { action: "portal", requestId: randomUUID() }, origin)).url, "https://billing.stripe.com/session");
  assert.deepEqual(calls.slice(count).map(call => call.path), ["billing_portal/sessions"]);
  await assert.rejects(billing.open("workspace", checkout(), origin), /price is unavailable/);
});

test("an existing subscriber is not shown a different price for new purchases", async () => {
  const { billing, calls } = fixture({ subscriptions: { data: [{ status: "past_due", customer: "cus_workspace", livemode: false }], has_more: false } });
  const status = await billing.inspect("workspace");
  assert.equal(status.price, undefined);
  assert.equal(status.portal, true);
  assert.equal(status.checkout, false);
  assert.equal(calls.some(call => call.path.startsWith("prices/")), false);
  assert.equal(billingStatusLabel(status.status), "Payment overdue");
  const html = accountPage({ managed: true, actor: "user_fixture", workspaceId: "workspace", canManageBilling: true, billing: status }).body;
  assert.match(html, /Payment overdue/);
  assert.match(html, /Manage billing/);
  assert.doesNotMatch(html, /Continue to checkout/);
});

test("metered, tiered, archived and malformed prices cannot start checkout", async () => {
  for (const bad of [null, { ...price, unit_amount: -1 }, { ...price, currency: "not currency" }, { ...price, active: false },
    { ...price, billing_scheme: "tiered" }, { ...price, recurring: { ...price.recurring, usage_type: "metered" } },
    { ...price, transform_quantity: { divide_by: 10 } }, { ...price, custom_unit_amount: { minimum: 10 } }, { ...price, livemode: true }, { ...price, id: "price_other" }]) {
    const { billing, calls } = fixture({ ["prices/" + config.priceId]: bad });
    const state = await billing.inspect("workspace");
    assert.equal(state.checkout, false);
    assert.equal(state.portal, true);
    await assert.rejects(billing.open("workspace", checkout(), origin));
    assert.equal(calls.some(call => call.path === "checkout/sessions"), false);
  }
});

test("malformed, incomplete and foreign subscription lists fail closed", async () => {
  for (const data of [null, { data: [null], has_more: false }, { data: [{ status: "new_status" }], has_more: false },
    { data: [], has_more: true }, { data: [{ status: "active", customer: "cus_other" }], has_more: false },
    { data: [{ status: "active", livemode: true }], has_more: false }]) {
    const { billing, calls } = fixture({ subscriptions: data });
    await assert.rejects(billing.open("workspace", checkout(), origin));
    assert.equal(calls.some(call => call.path === "checkout/sessions"), false);
  }
});

test("pending sessions and redirect responses must belong to the configured customer and mode", async () => {
  const session = { mode: "subscription", status: "open", customer: "cus_workspace", livemode: false,
    metadata: { magentic_workspace: "workspace", magentic_price: config.priceId }, url: "https://checkout.stripe.com/pending" };
  for (const bad of [{ ...session, customer: "cus_foreign" }, { ...session, livemode: true }, { ...session, status: "complete" }, null]) {
    const { billing, calls } = fixture({ "checkout/sessions": { data: [bad], has_more: false } });
    await assert.rejects(billing.open("workspace", checkout(), origin));
    assert.equal(calls.some(call => call.path === "checkout/sessions"), false);
  }
  for (const bad of [{ url: "https://billing.stripe.com/session", customer: "cus_foreign" }, { url: "https://billing.stripe.com/session", livemode: true }, null]) {
    await assert.rejects(fixture({ "billing_portal/sessions:POST": bad }).billing.open("workspace", { action: "portal", requestId: randomUUID() }, origin));
  }
});

test("checkout retries keep the same idempotency key and parallel requests cannot create a second checkout", async () => {
  const { billing, calls } = fixture();
  const command = checkout();
  await billing.open("workspace", command, origin);
  await billing.open("workspace", command, origin);
  const creates = calls.filter(call => call.path === "checkout/sessions");
  assert.equal(creates.length, 2);
  assert.equal(creates[0]!.headers["Idempotency-Key"], creates[1]!.headers["Idempotency-Key"]);
  const first = billing.open("workspace", checkout(), origin);
  await assert.rejects(billing.open("workspace", checkout(), origin), /already running/);
  await first;
  assert.ok(await billing.open("workspace", { action: "portal", requestId: randomUUID() }, origin));
});

test("currency display respects Stripe's ISK and UGX minor units", () => {
  assert.equal(formatBillingAmount(2900, "usd"), "$29.00");
  assert.match(formatBillingAmount(500, "jpy"), /500$/);
  assert.match(formatBillingAmount(500, "isk"), /\b5$/);
  assert.match(formatBillingAmount(500, "ugx"), /\b5$/);
  assert.equal(formatBillingAmount(0, "usd"), "$0.00");
});

test("malformed account origins produce field-level validation instead of an uncaught URL error", () => {
  const result = accountsSchema.safeParse({ clerk: { issuer: "invalid", publishableKey: "pk_test_Zm9v", publicKey: "x".repeat(100), authorizedParties: ["bad origin"] },
    members: [{ workspaceId: "workspace", actor: "user_fixture", roles: ["admin"] }] });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some(issue => issue.path.join(".") === "clerk.authorizedParties.0"));
});

// The SDK is deliberately fake: these cases exercise the browser's recovery path without an account or network.
function signInFixture(scriptState: "error" | "pending" | "loaded", load: () => Promise<void> = async () => {}) {
  type Element = { textContent: string; children: Element[]; disabled: boolean; onload?: () => void; onerror?: () => void; onclick?: () => Promise<void>;
    appendChild(child: Element): void; replaceChildren(): void; setAttribute(): void; remove(): void };
  const element = (): Element => ({ textContent: "", children: [], disabled: false, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, remove() {} });
  const content = element(), notice = element();
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  let click: ((event: unknown) => void) | undefined;
  const clerk = { isSignedIn: true, load, async signOut() { throw new Error("provider details"); } };
  const context = { window: { Clerk: clerk }, location: { origin, reload() {}, replace() {} }, AbortSignal,
    setTimeout(fn: () => void) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
    fetch: async () => Response.json({ enabled: true, issuer: "https://example.clerk.accounts.dev", publishableKey: "pk_test_fixture" }),
    document: { createElement: element, getElementById(id: string) { return id === "account-sign-in" ? content : notice; },
      head: { appendChild(script: Element) { if (scriptState !== "pending") queueMicrotask(() => scriptState === "error" ? script.onerror?.() : script.onload?.()); } },
      addEventListener(_type: string, handler: (event: unknown) => void) { click = handler; } },
  };
  const ready = runInNewContext(accountClientScript + ";window.magenticAccountReady", context) as Promise<unknown>;
  return { ready, content, notice, timers, click: (event: unknown) => click?.(event) };
}

test("a failed Clerk script shows a retry action instead of leaving a loading indicator", async () => {
  const page = signInFixture("error");
  await assert.rejects(page.ready, /Could not reach Clerk/);
  assert.equal(page.content.children[0]?.textContent, "Retry sign-in");
  assert.match(page.notice.textContent, /Could not reach Clerk/);
});

test("stalled Clerk scripts and SDK initialization time out with a retry action", async () => {
  for (const page of [signInFixture("pending"), signInFixture("loaded", () => new Promise(() => {}))]) {
    await new Promise(setImmediate);
    assert.equal(page.timers.size, 1);
    for (const callback of [...page.timers.values()]) callback();
    await assert.rejects(page.ready);
    assert.equal(page.content.children[0]?.textContent, "Retry sign-in");
    assert.equal(page.timers.size, 0);
  }
});

test("a failed sign-out reports failure without claiming the session has ended", async () => {
  const page = signInFixture("loaded");
  await page.ready;
  const button = page.content.children[1]!;
  assert.equal(button.textContent, "Use another account");
  await button.onclick?.();
  assert.match(page.notice.textContent, /Could not sign out/);
  assert.doesNotMatch(page.notice.textContent, /provider details/);
  assert.equal(button.disabled, false);
});
