import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountsConfig } from "./accounts.js";

export class BillingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type PaidTier = "pro" | "max";
export const billingCommand = z.object({ action: z.enum(["checkout", "portal"]), requestId: z.string().uuid(), tier: z.enum(["pro", "max"]).optional() }).strict();
export interface BillingStatus {
  configured: boolean; mode: "test" | "live" | "unconfigured"; status: string;
  checkout: boolean; portal: boolean; detail?: string;
  tier?: "free" | PaidTier;
  maxCheckout?: boolean; maxPrice?: { amount: number; currency: string; interval: string };
  price?: { amount: number; currency: string; interval: string };
}

const customerReference = z.union([z.string(), z.object({ id: z.string() })]).optional();
const subscriptionSchema = z.object({
  status: z.enum(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]),
  customer: customerReference, livemode: z.boolean().optional(),
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })), has_more: z.boolean().optional() }).optional(),
});
const priceSchema = z.object({
  id: z.string().optional(), active: z.boolean(), livemode: z.boolean(),
  unit_amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[a-z]{3}$/),
  recurring: z.object({ interval: z.enum(["day", "week", "month", "year"]), interval_count: z.literal(1), usage_type: z.literal("licensed").optional() }),
  billing_scheme: z.literal("per_unit").optional(), type: z.literal("recurring").optional(),
  transform_quantity: z.null().optional(), custom_unit_amount: z.null().optional(),
});
const sessionSchema = z.object({
  mode: z.enum(["subscription", "payment", "setup"]), status: z.literal("open").optional(),
  customer: customerReference, livemode: z.boolean().optional(),
  metadata: z.record(z.string()).nullish(), url: z.string().nullable(),
});
const redirectSchema = z.object({ url: z.string(), customer: customerReference, livemode: z.boolean().optional() });

function readResponse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BillingError(502, message);
  return parsed.data;
}

export function createBilling(config: AccountsConfig["billing"], key: string | undefined, transport: typeof fetch = fetch) {
  const mode = key?.startsWith("sk_test_") ? "test" : key?.startsWith("sk_live_") ? "live" : "unconfigured";
  const busy = new Set<string>();
  async function call(path: string, fields?: URLSearchParams, idempotency?: string): Promise<unknown> {
    try {
      const response = await transport(`https://api.stripe.com/v1/${path}`, {
        method: fields ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${key}`, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idempotency ? { "Idempotency-Key": idempotency } : {}) },
        ...(fields ? { body: fields.toString() } : {}),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new BillingError(502, "Stripe is unavailable. Check the server configuration and retry."); }
  }
  function customer(workspaceId: string): string | undefined { return config?.customers.find(item => item.workspaceId === workspaceId)?.customerId; }
  function checkScope(value: { customer?: string | { id: string } | undefined; livemode?: boolean | undefined }, id: string): void {
    const returnedCustomer = typeof value.customer === "string" ? value.customer : value.customer?.id;
    if ((returnedCustomer !== undefined && returnedCustomer !== id) || (value.livemode !== undefined && value.livemode !== (mode === "live"))) {
      throw new BillingError(502, "Stripe returned billing data for a different customer or mode.");
    }
  }
  async function subscriptions(id: string) {
    const result = readResponse(z.object({ data: z.array(subscriptionSchema), has_more: z.literal(false) }),
      await call(`subscriptions?customer=${encodeURIComponent(id)}&status=all&limit=100`), "Could not verify current subscriptions.");
    for (const item of result.data) checkScope(item, id);
    return result.data;
  }
  function subscriptionTier(items: z.infer<typeof subscriptionSchema>[], id: string): "free" | PaidTier {
    const prices = items.filter(item => {
      const owner = typeof item.customer === "string" ? item.customer : item.customer?.id;
      return owner === id && item.livemode === (mode === "live")
        && ["active", "trialing"].includes(item.status) && item.items?.has_more !== true;
    }).flatMap(item => item.items?.data.map(line => line.price.id) ?? []);
    if (config?.maxPriceId && prices.includes(config.maxPriceId)) return "max";
    return config && prices.includes(config.priceId) ? "pro" : "free";
  }
  async function inspect(workspaceId: string, tier: PaidTier = "pro"): Promise<BillingStatus> {
    const id = customer(workspaceId);
    const priceId = tier === "max" ? config?.maxPriceId : config?.priceId;
    if (!config || !priceId || !id || mode === "unconfigured") return { configured: false, mode, status: "Setup needed", checkout: false, portal: false };
    const items = await subscriptions(id);
    const existing = items.find(item => !["canceled", "incomplete_expired"].includes(item.status));
    const status: BillingStatus = { configured: true, mode, status: existing?.status ?? "No subscription", checkout: false, portal: true, tier: subscriptionTier(items, id) };
    // A purchase price is not the price on an existing subscription. Stripe's portal shows that invoice.
    if (existing) return status;
    try {
      const price = readResponse(priceSchema, await call(`prices/${priceId}`), "Configure a fixed recurring Stripe price.");
      if (price.livemode !== (mode === "live") || (price.id !== undefined && price.id !== priceId)) throw new BillingError(502, "The configured Stripe price does not match this billing mode.");
      if (!price.active) return { ...status, detail: "The purchase price is archived. Ask your administrator to select an active price." };
      return { ...status, checkout: true, price: { amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval } };
    } catch (error) {
      // A broken sales configuration must not strand someone who needs to update a card or cancel.
      return { ...status, detail: error instanceof BillingError ? error.message : "Could not verify the purchase price." };
    }
  }
  async function tier(workspaceId: string): Promise<"free" | PaidTier> {
    const id = customer(workspaceId);
    if (!config || !id || mode === "unconfigured") return "free";
    return subscriptionTier(await subscriptions(id), id);
  }
  async function entitled(workspaceId: string): Promise<boolean> { return (await tier(workspaceId)) !== "free"; }
  return { tier, entitled, async inspect(workspaceId: string): Promise<BillingStatus> {
    const status = await inspect(workspaceId);
    if (!status.checkout || !config?.maxPriceId) return status;
    const max = await inspect(workspaceId, "max");
    return { ...status, maxCheckout: max.checkout, ...(max.price ? { maxPrice: max.price } : {}) };
  }, async open(workspaceId: string, raw: unknown, returnOrigin: string): Promise<{ url: string }> {
    const input = billingCommand.parse(raw);
    const id = customer(workspaceId);
    const priceId = input.tier === "max" ? config?.maxPriceId : config?.priceId;
    if (input.action === "checkout" && !priceId) throw new BillingError(503, "This plan is not configured.");
    if (!config || !id || mode === "unconfigured") throw new BillingError(503, "Ask your administrator to configure Stripe for this workspace.");
    if (busy.has(workspaceId)) throw new BillingError(409, "A billing request is already running. Try again shortly.");
    busy.add(workspaceId);
    try {
      const returnUrl = `${returnOrigin}/#/account`;
      let result: unknown;
      if (input.action === "portal") {
        result = await call("billing_portal/sessions", new URLSearchParams({ customer: id, return_url: returnUrl }));
      } else {
        const state = await inspect(workspaceId, input.tier);
        if (!state.checkout) throw new BillingError(409, "This workspace already has a subscription or its price is unavailable. Open billing instead.");
        // Reuse an unfinished checkout instead of creating duplicate subscriptions on repeated clicks.
        const sessions = readResponse(z.object({ data: z.array(sessionSchema), has_more: z.literal(false) }),
          await call(`checkout/sessions?customer=${encodeURIComponent(id)}&status=open&limit=100`), "Could not verify pending checkouts.");
        for (const session of sessions.data) checkScope(session, id);
        result = sessions.data.find(session => session.mode === "subscription" && session.metadata?.magentic_workspace === workspaceId && session.metadata?.magentic_price === priceId);
        if (!result && sessions.data.some(session => session.mode === "subscription")) throw new BillingError(409, "A checkout is already pending for this customer. Finish or expire it in Stripe first.");
        if (!result) result = await call("checkout/sessions", new URLSearchParams({ mode: "subscription", customer: id,
          "line_items[0][price]": priceId!, "line_items[0][quantity]": "1", success_url: returnUrl, cancel_url: returnUrl,
          "metadata[magentic_workspace]": workspaceId, "metadata[magentic_price]": priceId!,
        }), createHash("sha256").update(`${workspaceId}:${id}:${priceId}:${input.requestId}`).digest("hex"));
      }
      const redirect = readResponse(redirectSchema, result, "Stripe did not return a valid portal address.");
      checkScope(redirect, id);
      let url: URL;
      try { url = new URL(redirect.url); } catch { throw new BillingError(502, "Stripe did not return a valid portal address."); }
      const host = input.action === "portal" ? "billing.stripe.com" : "checkout.stripe.com";
      if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) throw new BillingError(502, "Stripe did not return a valid portal address.");
      return { url: url.href };
    } finally { busy.delete(workspaceId); }
  } };
}
export type Billing = ReturnType<typeof createBilling>;
