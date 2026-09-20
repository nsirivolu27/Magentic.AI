import type { AgentDefinition } from "../catalog/schema.js";
import { hashDefinition, type RegistryRecord, type Status } from "./record.js";
import { TRANSITIONS, type RegistryStore } from "./store.js";
import type { AuditSink } from "./audit.js";
import { requirePermission, type MemberDirectory } from "./roles.js";

/**
 * Moving a definition through draft, review and approved.
 *
 * Every move does the same three things in the same order: check the move is
 * legal, write the record, write the audit event. They are here rather than
 * in a route handler so that an HTTP API, a CLI and a test all get the same
 * rules, and so that adding a second caller later cannot add a second set of
 * rules by accident.
 *
 * Nothing here decides who a person is. The actor arrives already
 * authenticated, because this module enforcing identity as well as process
 * would be two jobs in one file and the wrong one to get wrong.
 */

export interface TransitionContext {
  store: RegistryStore;
  audit: AuditSink;
  /**
   * Whether the author may approve their own definition. Off by default:
   * separation of duties is most of what review means, and a gate that one
   * person can walk through alone is a gate in name only.
   */
  allowSelfApproval?: boolean;
  /**
   * Who holds which role here. Absent means personal mode: no role checks,
   * because one person on a laptop should not have to invent an approver.
   */
  members?: MemberDirectory;
  /** For tests. Defaults to now. */
  now?: () => Date;
}

export class TransitionError extends Error {}

/** Author a new definition, or replace one still in draft. */
export async function authorDraft(
  context: TransitionContext,
  input: { workspaceId: string; definition: AgentDefinition; actor: string },
): Promise<RegistryRecord> {
  const { workspaceId, definition, actor } = input;
  await requirePermission(context.members, workspaceId, actor, "author");
  const at = stamp(context);
  const existing = await context.store.get(workspaceId, definition.name);

  if (existing && existing.status !== "draft") {
    throw new TransitionError(
      `"${definition.name}" is ${existing.status}, so it cannot be edited in place. `
      + "Retire it and author a new version instead.",
    );
  }

  const record: RegistryRecord = {
    workspaceId,
    definition,
    status: "draft",
    author: existing?.author ?? actor,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    // A draft carries no signatures. Editing clears any that somehow survived.
    approvals: [],
  };

  await context.store.put(record);
  await context.audit.append({
    workspaceId,
    agentName: definition.name,
    action: existing ? "edited" : "authored",
    actor,
    at,
    definitionHash: hashDefinition(definition),
  });
  return record;
}

/** Send a draft for review. */
export async function submit(
  context: TransitionContext,
  input: { workspaceId: string; name: string; actor: string; note?: string },
): Promise<RegistryRecord> {
  return move(context, { ...input, to: "review", action: "submitted" });
}

/** Send a record in review back to its author. */
export async function requestChanges(
  context: TransitionContext,
  input: { workspaceId: string; name: string; actor: string; note?: string },
): Promise<RegistryRecord> {
  return move(context, { ...input, to: "draft", action: "changes-requested" });
}

/** Take an approved record out of service. */
export async function retire(
  context: TransitionContext,
  input: { workspaceId: string; name: string; actor: string; note?: string },
): Promise<RegistryRecord> {
  return move(context, { ...input, to: "retired", action: "retired" });
}

/**
 * Sign a record in review.
 *
 * The signature binds to the definition's hash, so it stops counting the
 * moment the definition changes. The record moves to approved on the first
 * signature; whether that is enough to serve it is a separate question the
 * catalog asks, because the number required is a deployment setting rather
 * than a property of the record.
 */
export async function approve(
  context: TransitionContext,
  input: { workspaceId: string; name: string; actor: string; note?: string },
): Promise<RegistryRecord> {
  const { workspaceId, name, actor } = input;
  await requirePermission(context.members, workspaceId, actor, "approve");
  const record = await load(context, workspaceId, name);

  if (record.status !== "review" && record.status !== "approved") {
    throw new TransitionError(`"${name}" is ${record.status}; only a record in review can be approved.`);
  }
  if (!context.allowSelfApproval && actor === record.author) {
    throw new TransitionError(
      `${actor} authored "${name}" and cannot also approve it. Another approver has to sign.`,
    );
  }

  const at = stamp(context);
  const definitionHash = hashDefinition(record.definition);
  if (record.approvals.some((approval) => approval.approver === actor && approval.definitionHash === definitionHash)) {
    throw new TransitionError(`${actor} has already signed this version of "${name}".`);
  }

  const updated: RegistryRecord = {
    ...record,
    status: "approved",
    updatedAt: at,
    approvals: [...record.approvals, { approver: actor, at, definitionHash }],
  };

  await context.store.put(updated);
  await context.audit.append({
    workspaceId,
    agentName: name,
    action: "approved",
    actor,
    at,
    definitionHash,
    ...(input.note ? { note: input.note } : {}),
  });
  return updated;
}

async function move(
  context: TransitionContext,
  input: { workspaceId: string; name: string; actor: string; to: Status; action: "submitted" | "changes-requested" | "retired"; note?: string },
): Promise<RegistryRecord> {
  const { workspaceId, name, actor, to } = input;
  await requirePermission(context.members, workspaceId, actor, input.action === "submitted" ? "submit"
    : input.action === "changes-requested" ? "request-changes" : "retire");
  const record = await load(context, workspaceId, name);

  if (!TRANSITIONS[record.status].includes(to)) {
    const allowed = TRANSITIONS[record.status].join(", ") || "nothing";
    throw new TransitionError(`"${name}" is ${record.status} and can only move to: ${allowed}.`);
  }

  const at = stamp(context);
  const updated: RegistryRecord = {
    ...record,
    status: to,
    updatedAt: at,
    // Going back to draft drops the signatures. They were on a version
    // somebody has now been asked to change.
    approvals: to === "draft" ? [] : record.approvals,
  };

  await context.store.put(updated);
  await context.audit.append({
    workspaceId,
    agentName: name,
    action: input.action,
    actor,
    at,
    definitionHash: hashDefinition(record.definition),
    ...(input.note ? { note: input.note } : {}),
  });
  return updated;
}

async function load(context: TransitionContext, workspaceId: string, name: string): Promise<RegistryRecord> {
  const record = await context.store.get(workspaceId, name);
  if (!record) throw new TransitionError(`Workspace ${workspaceId} has no agent named "${name}".`);
  return record;
}

function stamp(context: TransitionContext): string {
  return (context.now?.() ?? new Date()).toISOString();
}
