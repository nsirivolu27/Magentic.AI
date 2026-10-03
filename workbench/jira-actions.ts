import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "./storage.js";
import type { Role } from "../registry/roles.js";
import type { PipelineEngine, PipelineRun } from "./pipeline.js";
import {
  authorize, dedupeKeyFor, hashIntent, intentFromPreview, JiraError, reconcile,
  type JiraDelivery, type JiraIntent, type JiraSite, type Operation, type PendingJiraAction,
} from "./jira.js";

/**
 * The durable half of a Jira action.
 *
 * Everything a caller sends is a reference, never a payload. A request names
 * a run, an event and an operation; this module reads the stored workflow
 * event, builds the intent from what is on disk, and authorizes it with the
 * identity the server already established. A client that posts an object
 * containing authorizedBy and intentHash is proposing, not proving, and that
 * object is ignored.
 *
 * Order of operations for a send, and the reason for it:
 *
 *   1. resolve the stored event      a caller cannot invent the content
 *   2. dedupe on event and operation one action per thing that happened
 *   3. authorize                     an admin, bound to payload and site
 *   4. commit pending                durable before anything leaves
 *   5. claim                         committed, so a crash is visible
 *   6. dispatch                      the only step that touches the network
 *   7. commit the outcome            evidence, or the reason there is none
 *
 * Steps 4 and 5 are separate commits on purpose. A process that dies between
 * them leaves a pending action that never went anywhere, which is safe. A
 * process that dies after 5 leaves a claim, which on reload is known to be
 * an interrupted attempt of unknown outcome, and is reconciled rather than
 * retried.
 */

/** Where actions live. Implemented over the workspace store. */
export interface JiraActionStore {
  list(workspaceId: string): PendingJiraAction[];
  /** Replace the whole set for a workspace, durably. Throws if it cannot. */
  commit(workspaceId: string, actions: PendingJiraAction[]): void;
}

export interface JiraActionContext {
  pipelines: PipelineEngine;
  actions: JiraActionStore;
  delivery: JiraDelivery;
  /** Only needed to reconcile an uncertain attempt. */
  site?: JiraSite;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Identity the server established. Never taken from the request body. */
export interface CallerIdentity {
  workspaceId: string;
  actor: string;
  roles: readonly Role[];
}

/** What a caller may ask for: references and an operation, nothing else. */
export interface DeliveryRequest {
  runId: string;
  eventId: string;
  operation?: Operation;
  fields?: JiraIntent["fields"];
}

function findRun(pipelines: PipelineEngine, workspaceId: string, runId: string): PipelineRun {
  const run = pipelines.snapshot(workspaceId).runs.find((item) => item.id === runId);
  if (!run) throw new JiraError("That run is not in this workspace.");
  return run;
}

/**
 * Build the intent from stored state.
 *
 * The preview has to belong to the run, the run to the workspace, and the
 * workspace to the caller. Checking the chain here is what stops a request
 * naming somebody else's event and borrowing this caller's authority.
 */
export function intentForRequest(
  pipelines: PipelineEngine,
  identity: CallerIdentity,
  request: DeliveryRequest,
  siteOrigin: string,
): JiraIntent {
  const run = findRun(pipelines, identity.workspaceId, request.runId);
  if (run.workspaceId !== identity.workspaceId) {
    throw new JiraError("That run belongs to another workspace.");
  }
  const preview = run.jira.find((item) => item.eventId === request.eventId);
  if (!preview) throw new JiraError("That run has no Jira preview for that event.");
  if (!run.events.some((event) => event.id === request.eventId)) {
    throw new JiraError("That event is not part of this run.");
  }
  return intentFromPreview(preview, identity.workspaceId, run.id, {
    siteOrigin,
    ...(request.operation ? { operation: request.operation } : {}),
    ...(request.fields ? { fields: request.fields } : {}),
  });
}

export interface DeliveryOutcome {
  action: PendingJiraAction;
  /** True when this call dispatched. False when an existing action was returned. */
  dispatched: boolean;
}

/**
 * Authorize and deliver one action.
 *
 * Returns the stored action either way. Two callers racing on the same event
 * produce one dispatch: the second finds the first's claim and returns it
 * rather than sending again.
 */
export async function deliver(
  context: JiraActionContext,
  identity: CallerIdentity,
  request: DeliveryRequest,
): Promise<DeliveryOutcome> {
  if (!identity.roles.includes("admin")) {
    throw new JiraError(`${identity.actor} cannot authorize a Jira action. An admin must.`);
  }
  const now = context.now ?? (() => new Date());
  const siteOrigin = context.delivery.siteOrigin;
  const intent = intentForRequest(context.pipelines, identity, request, siteOrigin);
  const dedupeKey = dedupeKeyFor(intent);

  const existing = context.actions.list(identity.workspaceId);
  const already = existing.find((item) => item.dedupeKey === dedupeKey);

  if (already) {
    if (already.intentHash !== hashIntent(intent)) {
      throw new JiraError("This event already has a different authorized intent. It cannot reuse completed steps or evidence.");
    }
    // Anything not open is the answer. A claimed action is somebody else's
    // attempt in flight, and a second dispatch is exactly the duplicate this
    // whole module exists to prevent.
    if (already.status === "sent" || already.status === "claimed" || already.status === "uncertain") {
      return { action: already, dispatched: false };
    }
  }

  if (already?.retryNotBefore && now().getTime() < Date.parse(already.retryNotBefore)) {
    throw new JiraError(`Jira asked us to wait until ${already.retryNotBefore} before retrying.`);
  }

  const pending: PendingJiraAction = already
    // Keep the same action and marker across retries. Its payload was checked
    // above, so completed steps still describe the work being authorized.
    ? withoutError({ ...already, authorizedBy: identity.actor, authorizedAt: now().toISOString(), status: "pending" })
    : authorize(intent, identity.actor, identity.roles, now);

  // Committed before the claim, so the record of what was authorized exists
  // even if this process dies in the next millisecond.
  const withPending = replace(existing, pending);
  context.actions.commit(identity.workspaceId, withPending);

  const claimed: PendingJiraAction = {
    ...pending,
    status: "claimed",
    claim: { attemptId: randomUUID(), at: now().toISOString() },
  };
  context.actions.commit(identity.workspaceId, replace(withPending, claimed));

  let result: PendingJiraAction;
  try {
    result = await context.delivery.send(claimed);
  } catch {
    // The transport threw rather than answering. The request may have been
    // sent, so this is uncertain.
    result = {
      ...claimed, status: "uncertain", attempts: claimed.attempts + 1,
      lastError: "The delivery transport stopped without a confirmed outcome. The write may have landed.",
    };
  }

  const settled = withoutClaim(result);
  if (settled.status === "failed" && settled.retryAfterMs !== undefined) {
    settled.retryNotBefore = new Date(now().getTime() + settled.retryAfterMs).toISOString();
  }
  // Other actions may have finished during the network wait. Replacing a
  // pre-dispatch snapshot here would erase their claims or evidence.
  context.actions.commit(identity.workspaceId, replace(context.actions.list(identity.workspaceId), settled));
  return { action: settled, dispatched: context.delivery.mode === "live" };
}

/**
 * Resolve an interrupted or uncertain attempt.
 *
 * A claim still present on reload means a process died mid attempt. Its
 * outcome is unknown for the same reason a timeout is, so it is marked
 * uncertain and reconciled rather than retried.
 */
export async function recoverInterrupted(
  context: JiraActionContext,
  workspaceId: string,
): Promise<PendingJiraAction[]> {
  const actions = context.actions.list(workspaceId);
  const interrupted = actions.filter((item) => item.status === "claimed");
  if (!interrupted.length) return actions;

  const now = context.now ?? (() => new Date());
  const marked: PendingJiraAction[] = actions.map((item) => item.status === "claimed"
    ? withoutClaim({ ...item, status: "uncertain",
        lastError: `An attempt was interrupted at ${item.claim?.at ?? now().toISOString()}; the outcome is unknown.` })
    : item);
  context.actions.commit(workspaceId, marked);
  return marked;
}

/** Reconcile one uncertain action against Jira. Read only. */
export async function resolveUncertain(
  context: JiraActionContext,
  workspaceId: string,
  actionId: string,
): Promise<PendingJiraAction> {
  const actions = context.actions.list(workspaceId);
  const action = actions.find((item) => item.id === actionId);
  if (!action) throw new JiraError("No such Jira action in this workspace.");
  if (action.status !== "uncertain") return action;
  if (!context.site) {
    throw new JiraError("Reconciliation needs a configured Jira site. In preview mode there is nothing to reconcile against.");
  }
  const resolved = await reconcile(context.site, action, context.fetchImpl ?? fetch);
  context.actions.commit(workspaceId, replace(context.actions.list(workspaceId), resolved));
  return resolved;
}

/**
 * Omit rather than assign undefined.
 *
 * exactOptionalPropertyTypes treats `claim: undefined` as a different thing
 * from an absent claim, and the absent one is what "no attempt in flight"
 * means. These two keep that distinction honest.
 */
function withoutClaim(action: PendingJiraAction): PendingJiraAction {
  const { claim: _claim, ...rest } = action;
  return rest;
}

function withoutError(action: PendingJiraAction): PendingJiraAction {
  const { lastError: _lastError, retryAfterMs: _retryAfterMs, retryNotBefore: _retryNotBefore, ...rest } = action;
  return rest;
}

function replace(actions: readonly PendingJiraAction[], action: PendingJiraAction): PendingJiraAction[] {
  const index = actions.findIndex((item) => item.id === action.id || item.dedupeKey === action.dedupeKey);
  if (index === -1) return [...actions, action];
  const copy = [...actions];
  copy[index] = action;
  return copy;
}

/**
 * The action store, backed by the workspace document.
 *
 * Reads and writes the whole set, because the workspace store commits whole
 * documents and a partial write is the thing it exists to prevent. The list
 * is bounded by the schema, so whole is cheap.
 */
export function workspaceActionStore(store: Pick<WorkspaceStore, "read" | "commit">): JiraActionStore {
  return {
    list(workspaceId) {
      return store.read(workspaceId)?.jiraActions ?? [];
    },
    commit(workspaceId, actions) {
      const current = store.read(workspaceId);
      if (!current) throw new JiraError(`Workspace ${workspaceId} has nothing stored yet.`);
      store.commit(workspaceId, { ...current, jiraActions: actions });
    },
  };
}
