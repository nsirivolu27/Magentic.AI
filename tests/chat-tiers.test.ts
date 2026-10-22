import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createBilling } from "../workbench/billing.js";
import { accountsSchema } from "../workbench/accounts.js";
import { createChatAccess } from "../workbench/chat-access.js";
import { memoryChatVault } from "../workbench/chat-vault.js";
import { chatPlanSchema } from "../workbench/chat-routing.js";
import { accountPage } from "../workbench/account-view.js";
import type { ChatConfiguration } from "../workbench/chat.js";

const billingConfig = { priceId: "price_pro", maxPriceId: "price_max", customers: [{ workspaceId: "w", customerId: "cus_w" }] };
function stripe(price?: string, status = "active") {
  const posts: URLSearchParams[] = [];
  const request = (async (url, options) => {
    const path = String(url).split("/v1/")[1]!;
    if (path.startsWith("subscriptions?")) return Response.json({ has_more: false, data: price ? [{ customer: "cus_w", livemode: false, status, items: { has_more: false, data: [{ price: { id: price } }] } }] : [] });
    if (path.startsWith("prices/")) return Response.json({ id: path.slice(7), unit_amount: 100, currency: "usd", recurring: { interval: "month", interval_count: 1 }, active: true, livemode: false });
    if (path.startsWith("checkout/sessions?")) return Response.json({ has_more: false, data: [] });
    posts.push(new URLSearchParams(String(options?.body)));
    return Response.json({ url: "https://checkout.stripe.com/test", customer: "cus_w", livemode: false });
  }) as typeof fetch;
  return { billing: createBilling(billingConfig, "sk_test_fixture", request), posts };
}

test("Stripe grants the exact active plan, not an unrelated price or overdue subscription", async () => {
  for (const [price, status, expected] of [["price_pro", "active", "pro"], ["price_max", "trialing", "max"], ["price_other", "active", "free"], ["price_max", "past_due", "free"]]) {
    const f = stripe(price, status);
    assert.equal(await f.billing.tier("w"), expected);
    assert.equal(await f.billing.entitled("w"), expected !== "free");
    assert.equal(await f.billing.tier("other"), "free");
  }
});

test("checkout chooses the server's Max price and defaults old requests to Pro", async () => {
  for (const level of [undefined, "max"] as const) {
    const f = stripe();
    await f.billing.open("w", { action: "checkout", requestId: randomUUID(), ...(level ? { tier: level } : {}) }, "http://127.0.0.1:4182");
    assert.equal(f.posts[0]!.get("line_items[0][price]"), level ? "price_max" : "price_pro");
    assert.equal(f.posts[0]!.get("metadata[magentic_price]"), level ? "price_max" : "price_pro");
  }
  await assert.rejects(stripe().billing.open("w", { action: "checkout", tier: "max", priceId: "price_other", requestId: randomUUID() }, "http://127.0.0.1:4182"));
  await assert.rejects(stripe("price_pro").billing.open("w", { action: "checkout", tier: "max", requestId: randomUUID() }, "http://127.0.0.1:4182"), /already has a subscription/);
});

test("billing shows independently verified Pro and Max prices", async () => {
  const status = await stripe().billing.inspect("w");
  assert.equal(status.checkout, true);
  assert.equal(status.maxCheckout, true);
  const html = accountPage({ managed: true, actor: "member", workspaceId: "w", canManageBilling: true, billing: status }).body;
  assert.match(html, /data-billing-tier="pro"/);
  assert.match(html, /data-billing-tier="max"/);
});

const rule = (id: string, cap: number) => ({ id, tasks: ["general", "code"] as const, strength: "capable" as const, priority: 0, maxOutputTokens: cap });
const plan = chatPlanSchema.parse({ dailyTokens: 4000, models: [rule("gateway/shared", 512)], max: { dailyTokens: 12000, models: [rule("gateway/shared", 2048), rule("gateway/max", 4096)] } });
function models() {
  let tier: "free" | "pro" | "max" = "max";
  let invocations = 0;
  const base: ChatConfiguration = { provider: "gateway", model: "gateway/shared", outputLimit: true,
    modelOptions: async () => ["gateway/shared", "gateway/max"].map(id => ({ id, label: id, provider: "Gateway", local: false, available: true, outputLimit: true, detail: "" })),
    loadModel: async () => ({ invoke: async () => { invocations++; return { content: '{"type":"answer","content":"ok"}', usage: { promptTokens: 10, completionTokens: 5 } }; } }),
  };
  const access = createChatAccess({ base, vault: memoryChatVault(), managedLogin: true, plan, entitled: async () => tier });
  return { access, setTier(value: typeof tier) { tier = value; }, calls: () => invocations };
}

test("Pro cannot load Max-only models and Max receives its own allowance", async () => {
  const f = models();
  assert.equal((await f.access.summary("w", "a")).plan, "max");
  assert.equal((await f.access.summary("w", "a")).dailyTokens, 12000);
  f.setTier("pro");
  const config = await f.access.configuration("w", "a");
  await assert.rejects(config.loadModel("gateway/max"), /not available/);
  assert.equal((await f.access.summary("w", "a")).dailyTokens, 4000);
  const prepared = await f.access.prepare("w", "a", { messages: [{ role: "user", content: "Debug this function" }], routing: "auto", preference: "quality" });
  assert.equal(prepared.model, "gateway/shared");
  assert.equal(prepared.maxOutputTokens, 512);
});

test("a downgrade invalidates a prepared Max model and an oversized shared-model request", async () => {
  for (const id of ["gateway/max", "gateway/shared"]) {
    const f = models();
    const config = await f.access.configuration("w", "a");
    const model = await config.loadModel(id, { maxOutputTokens: 2048 });
    f.setTier("pro");
    await assert.rejects(model.invoke("hello"), /Refresh after a plan change/);
    assert.equal(f.calls(), 0);
  }
});

test("changing tiers does not reset usage and cancellation fails closed", async () => {
  const f = models();
  const config = await f.access.configuration("w", "a");
  const model = await config.loadModel("gateway/shared", { maxOutputTokens: 256 });
  await model.invoke("hello");
  f.setTier("pro");
  assert.equal((await f.access.summary("w", "a")).accountedTokens, 15);
  f.setTier("free");
  await assert.rejects(model.invoke("hello"), /could not be verified/);
  assert.equal((await f.access.summary("w", "a")).auto, false);
});

test("plan configuration rejects ambiguous prices and malformed Max allowances", () => {
  const config = { clerk: { publishableKey: "pk_test_example", issuer: "https://example.test", publicKey: "x".repeat(100), authorizedParties: ["https://example.test"] }, members: [{ actor: "user_one", workspaceId: "w", roles: ["admin"] }], billing: { ...billingConfig, maxPriceId: "price_pro" } };
  const parsed = accountsSchema.safeParse(config);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.join(".") === "billing.maxPriceId"));
  for (const max of [{ ...plan.max, unknown: true }, { ...plan.max, dailyTokens: 1 }, { ...plan.max, models: [rule("same", 512), rule("same", 512)] }]) assert.equal(chatPlanSchema.safeParse({ ...plan, max }).success, false);
});
