import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { setting } from "../env.js";
import { membershipSchema, ROLES } from "../registry/roles.js";

const origin = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch { return false; }
}, "Use an HTTPS origin, or HTTP on localhost.");
export const accountsSchema = z.object({
  clerk: z.object({
    publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9+/=]+$/),
    issuer: origin.refine(value => value.startsWith("https:")),
    publicKey: z.string().min(100),
    authorizedParties: z.array(origin).min(1).max(10),
  }).strict(),
  members: z.array(membershipSchema.extend({ actor: z.string().regex(/^user_[A-Za-z0-9]+$/) })).max(1000),
  companies: z.object({
    roles: z.record(z.string().regex(/^org:[a-z][a-z0-9_]*$/), z.array(z.enum(ROLES)).min(1)).default({
      "org:admin": ["admin", "author", "approver"], "org:member": ["author"], "org:reviewer": ["approver"],
    }),
  }).strict().optional(),
  billing: z.object({
    priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    maxPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/).optional(),
    customers: z.array(z.object({ workspaceId: z.string().min(1), customerId: z.string().regex(/^cus_[A-Za-z0-9]+$/) }).strict()).max(1000),
  }).strict().optional(),
}).strict().superRefine((config, context) => {
  if (!config.companies && !config.members.length) context.addIssue({ code: "custom", path: ["members"], message: "Configure members or company access." });
  if (config.companies && config.members.length) context.addIssue({ code: "custom", path: ["members"], message: "Company mode uses Clerk membership; leave static members empty." });
  const keys = config.members.map(member => `${member.workspaceId}:${member.actor}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["members"], message: "Duplicate workspace membership." });
  const customers = config.billing?.customers ?? [];
  if (config.billing?.maxPriceId && config.billing.maxPriceId === config.billing.priceId) context.addIssue({ code: "custom", path: ["billing", "maxPriceId"], message: "Pro and Max must use different prices." });
  for (const field of ["workspaceId", "customerId"] as const) {
    if (new Set(customers.map(item => item[field])).size !== customers.length) context.addIssue({ code: "custom", path: ["billing", "customers"], message: `Duplicate ${field}.` });
  }
});
export type AccountsConfig = z.infer<typeof accountsSchema>;

export function loadAccounts(): AccountsConfig | undefined {
  const path = setting("MAGENTIC_ACCOUNTS_FILE")?.trim();
  if (!path) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("MAGENTIC_ACCOUNTS_FILE must name a readable JSON file."); }
  const parsed = accountsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`MAGENTIC_ACCOUNTS_FILE: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  validateClerkKey(parsed.data);
  return parsed.data;
}

export function validateClerkKey(config: AccountsConfig): void {
  try {
    const domain = Buffer.from(config.clerk.publishableKey.split("_")[2]!, "base64").toString("utf8");
    if (domain !== `${new URL(config.clerk.issuer).host}$` || createPublicKey(config.clerk.publicKey).asymmetricKeyType !== "rsa") throw new Error();
  } catch { throw new Error("clerk.publicKey must be an RSA public key; clerk.issuer must match clerk.publishableKey."); }
}

export function clerkActor(token: string, config: AccountsConfig, now = Date.now()): string | undefined {
  try {
    if (token.length > 16_384) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (header.alg !== "RS256" || header.crit !== undefined) return undefined;
    if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), config.clerk.publicKey, Buffer.from(parts[2]!, "base64url"))) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const seconds = now / 1000;
    // Fresh Clerk tokens can be issued just ahead of this server clock. Expiry stays strict.
    const latestIssuedAt = seconds + 5;
    if (claims.iss !== config.clerk.issuer || !config.clerk.authorizedParties.includes(claims.azp)
      || !Number.isFinite(claims.exp) || claims.exp <= seconds || claims.exp <= claims.iat || claims.nbf >= claims.exp || !Number.isFinite(claims.nbf) || claims.nbf > seconds
      || !Number.isFinite(claims.iat) || claims.iat > latestIssuedAt || claims.sts === "pending"
      || typeof claims.sid !== "string" || !claims.sid.startsWith("sess_")
      || typeof claims.sub !== "string" || !/^user_[A-Za-z0-9]+$/.test(claims.sub)) return undefined;
    return claims.sub;
  } catch { return undefined; }
}

export function accountActor(request: IncomingMessage, config: AccountsConfig): string | undefined {
  const bearer = request.headers.authorization;
  const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("__session="))?.slice(10);
  return clerkActor(bearer?.startsWith("Bearer ") ? bearer.slice(7) : cookie ?? "", config);
}
