import { formatBillingAmount, billingStatusLabel } from "./billing-display.js";
import type { BillingStatus } from "./billing.js";
import type { Page } from "./studio-view.js";

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export interface AccountSummary {
  managed: boolean; actor: string; workspaceId: string; canManageBilling: boolean;
  billing?: BillingStatus; billingError?: string;
}
export function accountPage(account?: AccountSummary, error?: string): Page {
  return { title: "Account & billing", context: "Sign-in and plans.", actions: '<button data-account-refresh class="secondary">Refresh</button>', body: !account
    ? `<section class="panel account-panel"><p role="status">${escape(error ?? "Loading account…")}</p></section>`
    : `<div class="account-grid">
      <section class="panel account-panel"><span class="eyebrow">YOUR ACCOUNT</span><h2>${account.managed ? "Workspace member" : "Local workspace"}</h2>
        <p>${account.managed ? "Access follows your workspace roles." : "Local access. Online sign-in needs setup."}</p>
        <dl class="account-facts"><div><dt>Identity</dt><dd>${escape(account.actor)}</dd></div><div><dt>Workspace</dt><dd>${escape(account.workspaceId)}</dd></div><div><dt>Sign-in</dt><dd>${account.managed ? "Clerk" : "This computer"}</dd></div></dl>
        ${account.managed ? '<button class="secondary" data-account-signout>Sign out</button>' : '<a class="secondary" href="/login">View sign-in portal</a>'}
      </section>
      <section class="panel account-panel"><span class="eyebrow">SUBSCRIPTION</span><h2>${account.billing?.tier === "max" ? "Max · " : account.billing?.tier === "pro" ? "Pro · " : ""}${escape(billingStatusLabel(account.billing?.status ?? (account.canManageBilling ? "Not connected" : "Managed by your administrator")))}</h2>
        ${account.billingError ? `<p role="alert">${escape(account.billingError)}</p>` : ""}
        ${account.billing?.price ? `<p class="account-price">${escape(formatBillingAmount(account.billing.price.amount, account.billing.price.currency))}<small> / ${escape(account.billing.price.interval)}</small></p>` : ""}
        <p>${account.billing?.configured ? `Stripe ${account.billing.mode === "test" ? "test mode · no real payments" : "live mode · real payments"}. Payment details stay with Stripe.` : account.canManageBilling ? "Stripe setup required." : "Billing is managed by your administrator."}</p>
        ${account.billing?.detail ? `<p role="status">${escape(account.billing.detail)}</p>` : ""}
        <div class="account-actions">${account.billing?.checkout ? '<button class="primary" data-billing-action="checkout" data-billing-tier="pro">Choose Pro</button>' : ""}${account.billing?.maxCheckout ? `<button class="secondary" data-billing-action="checkout" data-billing-tier="max">Choose Max${account.billing.maxPrice ? " · " + escape(formatBillingAmount(account.billing.maxPrice.amount, account.billing.maxPrice.currency)) + " / " + escape(account.billing.maxPrice.interval) : ""}</button>` : ""}${account.billing?.portal ? '<button class="secondary" data-billing-action="portal">Manage billing</button>' : ""}</div>
        <p class="muted">${account.billing?.checkout ? "Stripe confirms the final total before payment. " : ""}Payment does not grant workspace membership.</p>
      </section>
    </div>
    ${!account.managed ? '<section class="panel account-panel"><h2>Connect your organization</h2><p>Administrator setup required. Keep secrets off this page.</p><details><summary>Administrator setup</summary><p>Set MAGENTIC_ACCOUNTS_FILE to your account configuration and MAGENTIC_STRIPE_SECRET_KEY to a Stripe test key, then restart. See docs/account-portal.md for the configuration format.</p></details></section>' : ""}` };
}
