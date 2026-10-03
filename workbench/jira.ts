import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { setting } from "../env.js";
import type { JiraPreview } from "./pipeline.js";

/**
 * Jira actions: what may be sent, and what actually happened.
 *
 * The lifecycle lives in jira-actions.ts, which owns durability and the
 * server-side checks. This file owns two narrower things: the shape of an
 * authorized payload, and the HTTP conversation with Jira.
 *
 *   workflow event -> intent -> authorization -> pending -> attempt -> outcome
 *
 * Three ideas do the work here.
 *
 * An intent names an operation and a destination together, and the
 * authorization hash covers both. Moving the same words to another site or
 * another issue is a different action and is not authorized by the old
 * signature.
 *
 * An attempt has three outcomes, not two. Jira may have accepted a write and
 * we may still have lost the confirmation, and calling that a failure would
 * invite a retry that creates a second issue. That case is "uncertain" and is
 * reconciled before anything is retried.
 *
 * Issue creation and comments carry a correlation marker. Field updates and
 * transitions need operation-specific confirmation before recovery can safely
 * decide to retry. The local API does not expose the legacy marker search.
 */

/** What an action does. The destination fields required depend on this. */
export const OPERATIONS = ["create_issue", "update_fields", "add_comment", "transition_issue"] as const;
export type Operation = typeof OPERATIONS[number];

const issueKey = z.string().regex(/^[A-Z][A-Z0-9]{1,19}-[1-9][0-9]*$/);
const projectKey = z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/);

/**
 * Fields an update may set.
 *
 * A closed list rather than an open object. An arbitrary field map would let
 * whatever composes an intent write to anything the credential can reach,
 * including security level and assignee, which is not what a workflow handoff
 * should be able to do.
 */
export const updatableFieldsSchema = z.object({
  summary: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(4000).optional(),
  labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  duedate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "An update must set at least one field.");

export const jiraIntentSchema = z.object({
  /** Where this came from, so evidence traces back to a stage event. */
  previewId: z.string().uuid(),
  eventId: z.string().uuid(),
  runId: z.string().uuid(),
  workspaceId: z.string().min(1).max(200),

  /**
   * The destination, part of what is authorized. A signature covering the
   * words but not the site would let an authorized comment be replayed at
   * another company's Jira.
   */
  siteOrigin: z.string().url(),

  /**
   * Retained for the shape the pipeline already produces. create_issue and
   * update_issue are the two previews the engine generates; update_issue
   * means "say something on the issue", which is add_comment.
   */
  action: z.enum(["create_issue", "update_issue"]),
  operation: z.enum(OPERATIONS),

  project: projectKey,
  issueType: z.string().trim().min(1).max(80),
  issueKey: issueKey.nullable(),
  summary: z.string().trim().min(1).max(255),
  status: z.string().trim().min(1).max(80),
  comment: z.string().trim().max(4000),
  /** Only for update_fields. */
  fields: updatableFieldsSchema.optional(),
}).strict().superRefine((value, context) => {
  const needsKey = value.operation !== "create_issue";
  if (needsKey && !value.issueKey) {
    context.addIssue({ code: "custom", path: ["issueKey"], message: `${value.operation} needs the issue it acts on.` });
  }
  if (!needsKey && value.issueKey) {
    context.addIssue({ code: "custom", path: ["issueKey"], message: "A create must not name an existing issue." });
  }
  if (value.issueKey && !value.issueKey.startsWith(`${value.project}-`)) {
    context.addIssue({ code: "custom", path: ["issueKey"], message: "The issue key must belong to the named project." });
  }
  if (value.operation === "update_fields" && !value.fields) {
    context.addIssue({ code: "custom", path: ["fields"], message: "update_fields must say which fields to set." });
  }
  if (value.operation !== "update_fields" && value.fields) {
    context.addIssue({ code: "custom", path: ["fields"], message: "Only update_fields carries fields." });
  }
});

export type JiraIntent = z.infer<typeof jiraIntentSchema>;

/**
 * Outcomes.
 *
 * "uncertain" is the one that matters. It means a request left this machine
 * and no usable answer came back, so the write may or may not exist. It is
 * not failed, and it must never be retried without reconciling first.
 */
export type PendingStatus = "pending" | "claimed" | "sent" | "failed" | "uncertain";

export interface DeliveryStep {
  name: string;
  at: string;
  detail: string;
}

export interface PendingJiraAction {
  id: string;
  /** One action per workflow event and operation. Set by jira-actions.ts. */
  dedupeKey: string;
  intent: JiraIntent;
  authorizedBy: string;
  authorizedAt: string;
  /** Covers the payload and the destination together. */
  intentHash: string;
  status: PendingStatus;
  attempts: number;
  /** Set while an attempt is in flight, so a crash is recognisable on reload. */
  claim?: { attemptId: string; at: string };
  /** Steps already completed, so recovery does not repeat them. */
  steps: DeliveryStep[];
  evidence?: { issueKey: string; url: string; at: string };
  lastError?: string;
  /** Honoured by the caller; this module does not sleep. */
  retryAfterMs?: number;
  /** Persisted so restarting cannot skip the server's wait period. */
  retryNotBefore?: string;
}

export class JiraError extends Error {}

/** A stable fingerprint of everything that was authorized. */
export function hashIntent(intent: JiraIntent): string {
  const ordered = Object.keys(intent).sort()
    .map((key) => [key, (intent as Record<string, unknown>)[key]]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** The marker written into Jira so a lost confirmation can be resolved. */
export function correlationMarker(actionId: string): string {
  return `[magentic:${actionId}]`;
}

/** Map the engine's preview vocabulary onto an explicit operation. */
export function operationForPreview(preview: JiraPreview): Operation {
  return preview.action === "create_issue" ? "create_issue" : "add_comment";
}

export interface IntentSource {
  preview: JiraPreview;
  workspaceId: string;
  runId: string;
  siteOrigin: string;
  operation?: Operation;
  fields?: z.infer<typeof updatableFieldsSchema>;
}

/** Build an intent from a preview the pipeline already stored. */
export function intentFromPreview(
  preview: JiraPreview,
  workspaceId: string,
  runId: string,
  options: { siteOrigin?: string; operation?: Operation; fields?: z.infer<typeof updatableFieldsSchema> } = {},
): JiraIntent {
  const operation = options.operation ?? operationForPreview(preview);
  return jiraIntentSchema.parse({
    previewId: preview.id, eventId: preview.eventId, runId, workspaceId,
    siteOrigin: options.siteOrigin ?? "https://example.invalid",
    action: preview.action, operation,
    project: preview.project, issueType: preview.issueType,
    issueKey: operation === "create_issue" ? null : preview.issueKey,
    summary: preview.summary, status: preview.status, comment: preview.comment,
    ...(options.fields ? { fields: options.fields } : {}),
  });
}

/**
 * Record that a named person approved exactly this payload and destination.
 * Authorizing is not sending.
 */
export function authorize(
  intent: JiraIntent,
  actor: string,
  roles: readonly string[],
  now = () => new Date(),
): PendingJiraAction {
  if (!roles.includes("admin")) {
    throw new JiraError(`${actor} cannot authorize a Jira action. An admin must.`);
  }
  return {
    id: randomUUID(),
    dedupeKey: dedupeKeyFor(intent),
    intent,
    authorizedBy: actor,
    authorizedAt: now().toISOString(),
    intentHash: hashIntent(intent),
    status: "pending",
    attempts: 0,
    steps: [],
  };
}

/** One action per workflow event and operation, whatever composes it. */
export function dedupeKeyFor(intent: JiraIntent): string {
  return createHash("sha256")
    .update([intent.workspaceId, intent.runId, intent.eventId, intent.operation].join("\u0000"))
    .digest("hex");
}

// ---------------------------------------------------------------- the site

export interface JiraSite {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraDelivery {
  readonly mode: "preview" | "live";
  readonly siteOrigin: string;
  send(action: PendingJiraAction): Promise<PendingJiraAction>;
}

/**
 * The default, and what a deployment with no configured site gets. Records
 * that nothing was attempted, so missing credentials can never read as sent.
 */
export function previewDelivery(): JiraDelivery {
  return {
    mode: "preview",
    // A real URL shape that resolves to nothing. It has to parse, because an
    // intent records its destination; and because it can never equal a
    // configured site, an action authorized in preview mode is refused by
    // live delivery until somebody authorizes it again against the real site.
    siteOrigin: "https://preview.invalid",
    async send(action) {
      return { ...action, status: "pending", lastError: "Preview mode: nothing was sent to Jira." };
    },
  };
}

/**
 * Read the Jira site from settings.
 *
 * Every value goes through setting(), including the token: one place decides
 * what a setting is, and a token read a different way is a token nobody
 * remembers to redact.
 */
export function jiraSiteFromEnv(env: NodeJS.ProcessEnv = process.env): JiraSite | undefined {
  const baseUrl = setting("MAGENTIC_JIRA_URL", env)?.trim();
  const email = setting("MAGENTIC_JIRA_EMAIL", env)?.trim();
  const apiToken = setting("MAGENTIC_JIRA_API_TOKEN", env)?.trim();

  const present = [baseUrl, email, apiToken].filter(Boolean).length;
  if (present === 0) return undefined;
  if (present < 3) {
    // Partial configuration is a mistake worth naming, not a quiet fallback
    // to preview: somebody meant to turn this on.
    const missing = [
      baseUrl ? undefined : "MAGENTIC_JIRA_URL",
      email ? undefined : "MAGENTIC_JIRA_EMAIL",
      apiToken ? undefined : "MAGENTIC_JIRA_API_TOKEN",
    ].filter(Boolean);
    throw new JiraError(`Jira is partly configured. Missing: ${missing.join(", ")}.`);
  }

  let url: URL;
  try {
    url = new URL(baseUrl!);
  } catch {
    throw new JiraError("MAGENTIC_JIRA_URL must be a valid URL.");
  }
  if (url.protocol !== "https:") throw new JiraError("MAGENTIC_JIRA_URL must use https.");
  if (!email!.includes("@")) throw new JiraError("MAGENTIC_JIRA_EMAIL must be an email address.");
  return { baseUrl: url.origin, email: email!, apiToken: apiToken! };
}

// --------------------------------------------------------------- delivery

const TIMEOUT_MS = 15_000;

function doc(text: string) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** A response we could not understand is not a success. */
class Unconfirmed extends Error {}

export function restDelivery(
  site: JiraSite,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): JiraDelivery {
  const auth = `Basic ${Buffer.from(`${site.email}:${site.apiToken}`).toString("base64")}`;

  async function call(path: string, method: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown>; retryAfterMs?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${site.baseUrl}${path}`, {
        method,
        // redirect: "error" so a 3xx cannot carry this Authorization header
        // to a host nobody authorized.
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = header ? Number(header) : Number.NaN;
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 60_000;
      const error = new JiraError(`Jira rate limited ${method} ${path}.`);
      (error as JiraError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      throw error;
    }
    if (!response.ok) {
      // The status and the path. Never the credential, never the header.
      throw new JiraError(`Jira refused ${method} ${path} with ${response.status}.`);
    }
    const text = await response.text();
    if (!text) return { status: response.status, data: {} };
    try {
      return { status: response.status, data: JSON.parse(text) as Record<string, unknown> };
    } catch {
      throw new Unconfirmed(`Jira answered ${method} ${path} with ${response.status} and a body this build could not parse.`);
    }
  }

  function step(action: PendingJiraAction, name: string, detail: string): DeliveryStep[] {
    return [...action.steps, { name, at: new Date().toISOString(), detail }];
  }

  return {
    mode: "live",
    siteOrigin: site.baseUrl,

    async send(action) {
      // The signature covers the destination too, so a site swap after
      // authorization is caught here rather than at the network.
      if (hashIntent(action.intent) !== action.intentHash) {
        return { ...action, status: "failed", lastError: "The action changed after it was authorized. Authorize it again." };
      }
      if (action.intent.siteOrigin !== site.baseUrl) {
        return { ...action, status: "failed",
          lastError: `This action was authorized for ${action.intent.siteOrigin}, not ${site.baseUrl}.` };
      }
      if (action.status === "sent") return action;
      if (action.status === "uncertain") {
        return { ...action, lastError: "This attempt is unresolved. Reconcile it before retrying." };
      }

      const attempts = action.attempts + 1;
      const marker = correlationMarker(action.id);
      const { intent } = action;
      let steps = action.steps;

      try {
        if (intent.operation === "create_issue") {
          const created = await call("/rest/api/3/issue", "POST", {
            fields: {
              project: { key: intent.project },
              issuetype: { name: intent.issueType },
              summary: intent.summary,
              description: doc(`${intent.comment || intent.summary}\n\n${marker}`),
            },
          });
          const key = typeof created.data.key === "string" ? created.data.key : undefined;
          if (!key) throw new Unconfirmed("Jira accepted the issue but returned no key.");
          return { ...action, status: "sent", attempts, steps: step(action, "create_issue", key),
            evidence: { issueKey: key, url: `${site.baseUrl}/browse/${key}`, at: new Date().toISOString() } };
        }

        const key = intent.issueKey!;

        if (intent.operation === "add_comment") {
          await call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, "POST",
            { body: doc(`${intent.comment || intent.status}\n\n${marker}`) });
          return { ...action, status: "sent", attempts, steps: step(action, "add_comment", key),
            evidence: { issueKey: key, url: `${site.baseUrl}/browse/${key}`, at: new Date().toISOString() } };
        }

        if (intent.operation === "update_fields") {
          const fields = intent.fields!;
          await call(`/rest/api/3/issue/${encodeURIComponent(key)}`, "PUT", {
            fields: {
              ...(fields.summary ? { summary: fields.summary } : {}),
              ...(fields.description ? { description: doc(fields.description) } : {}),
              ...(fields.labels ? { labels: fields.labels } : {}),
              ...(fields.duedate ? { duedate: fields.duedate } : {}),
            },
          });
          return { ...action, status: "sent", attempts, steps: step(action, "update_fields", Object.keys(fields).join(",")),
            evidence: { issueKey: key, url: `${site.baseUrl}/browse/${key}`, at: new Date().toISOString() } };
        }

        // transition_issue is two requests. The discovery result is recorded
        // as its own step so a failure in the second does not repeat the
        // first, and so the chosen transition is auditable.
        const already = action.steps.find((item) => item.name === "discover_transition");
        let transitionId = already?.detail;
        if (!transitionId) {
          const found = await call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, "GET");
          const list = Array.isArray(found.data.transitions) ? found.data.transitions as Record<string, unknown>[] : [];
          const match = list.find((item) => {
            const to = item.to as { name?: unknown } | undefined;
            const target = typeof to?.name === "string" ? to.name : typeof item.name === "string" ? item.name : "";
            return target.toLowerCase() === intent.status.toLowerCase();
          });
          const id = match && typeof match.id === "string" ? match.id : undefined;
          if (!id) {
            const names = list.map((item) => (item.to as { name?: string } | undefined)?.name ?? item.name).join(", ") || "none";
            throw new JiraError(`Jira has no transition to "${intent.status}" for ${key}. Available: ${names}.`);
          }
          transitionId = id;
          steps = [...steps, { name: "discover_transition", at: new Date().toISOString(), detail: id }];
        }

        await call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, "POST", { transition: { id: transitionId } });
        return { ...action, status: "sent", attempts,
          steps: [...steps, { name: "transition_issue", at: new Date().toISOString(), detail: intent.status }],
          evidence: { issueKey: key, url: `${site.baseUrl}/browse/${key}`, at: new Date().toISOString() } };
      } catch (error) {
        // A timeout or an unparseable answer means the write may exist. That
        // is uncertain, not failed, and reconciliation decides.
        const aborted = error instanceof Error && error.name === "AbortError";
        if (aborted || error instanceof Unconfirmed) {
          return { ...action, status: "uncertain", attempts, steps,
            lastError: aborted ? `Jira did not answer within ${timeoutMs}ms; the write may have landed.` : (error as Error).message };
        }
        if (!(error instanceof JiraError)) {
          // A transport failure can happen after Jira accepted the write, and
          // its message may contain credentials supplied by the adapter.
          return { ...action, status: "uncertain", attempts, steps,
            lastError: "Jira delivery stopped without confirmation. The write may have landed." };
        }
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        return {
          ...action, status: "failed", attempts, steps,
          lastError: error instanceof Error ? error.message : "Jira delivery failed.",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
    },
  };
}

/**
 * Resolve an uncertain attempt by looking for its marker.
 *
 * Jira honours no idempotency header, so this is the only honest way to find
 * out whether a lost confirmation hid a write that landed. Read only: it
 * searches and reports, and never creates anything.
 */
export async function reconcile(
  site: JiraSite,
  action: PendingJiraAction,
  fetchImpl: typeof fetch = fetch,
): Promise<PendingJiraAction> {
  if (action.status !== "uncertain") return action;
  const auth = `Basic ${Buffer.from(`${site.email}:${site.apiToken}`).toString("base64")}`;
  const marker = correlationMarker(action.id);
  const jql = `project = "${action.intent.project}" AND text ~ "${marker}"`;

  const response = await fetchImpl(`${site.baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=2`, {
    method: "GET", redirect: "error",
    headers: { authorization: auth, accept: "application/json" },
  });
  if (!response.ok) {
    return { ...action, lastError: `Reconciliation could not reach Jira (${response.status}). Still unresolved.` };
  }
  const data = await response.json() as { issues?: { key?: unknown }[] };
  const hit = data.issues?.find((issue) => typeof issue.key === "string");
  if (!hit) {
    // Nothing carries the marker, so nothing landed. Safe to retry.
    return { ...action, status: "pending", lastError: "Reconciled: the write did not land. Safe to retry." };
  }
  const key = hit.key as string;
  return {
    ...action, status: "sent",
    steps: [...action.steps, { name: "reconciled", at: new Date().toISOString(), detail: key }],
    evidence: { issueKey: key, url: `${site.baseUrl}/browse/${key}`, at: new Date().toISOString() },
    lastError: "Reconciled: the write had landed after all.",
  };
}
