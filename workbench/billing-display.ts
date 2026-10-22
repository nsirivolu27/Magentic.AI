/** Stripe retains two-decimal API amounts for ISK and UGX despite their ISO display rules. */
export function formatBillingAmount(amount: number, currency: string, locale = "en"): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const decimals = ["isk", "ugx"].includes(currency.toLowerCase()) ? 2 : format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amount / 10 ** decimals);
}

export function billingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "Active", trialing: "Trial", past_due: "Payment overdue", unpaid: "Payment needed",
    incomplete: "Payment pending", incomplete_expired: "Checkout expired", canceled: "Canceled", paused: "Paused",
  };
  return labels[status] ?? status;
}
