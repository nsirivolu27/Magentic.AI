import { createHash } from "node:crypto";
import { z } from "zod";
import { agentSchema, type AgentDefinition } from "../catalog/schema.js";
import { DEFAULT_WORKFLOW, WORKFLOW_STATES, type Workflow } from "./workflow.js";

/**
 * A definition as the registry holds it, rather than as a file holds it.
 *
 * The file catalog answers "what does this deployment serve". The registry
 * answers "what did someone propose, who signed it, and is it allowed to be
 * served yet". Those are different questions, so they are different records,
 * and the definition inside is the same object in both.
 *
 * Status is the whole point. A workspace can author at runtime because
 * authoring produces a draft, and a draft reaches no MCP client. Only an
 * approved record is ever served, which is what lets a runtime registry and
 * an immutable served catalog be true at the same time.
 */

export const STATUSES = WORKFLOW_STATES;
export type Status = typeof STATUSES[number];

/**
 * One signature on one exact definition.
 *
 * The hash is here rather than only on the record because approval has to
 * bind to content. Approving a definition and then editing it is the first
 * hole anyone looks for, and storing what was signed is what closes it.
 */
export const approvalSchema = z.object({
  approver: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type Approval = z.infer<typeof approvalSchema>;

export const recordSchema = z.object({
  /** The workspace this definition belongs to. Records never cross one. */
  workspaceId: z.string().trim().min(1).max(200),
  definition: agentSchema,
  status: z.enum(STATUSES),
  author: z.string().trim().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Every signature collected so far, oldest first. */
  approvals: z.array(approvalSchema).max(10).default([]),
}).strict();

export type RegistryRecord = z.infer<typeof recordSchema>;

/**
 * A stable fingerprint of a definition.
 *
 * Keys are sorted at every level before hashing, because two objects that
 * differ only in key order are the same definition and must not produce two
 * different hashes. JSON.stringify alone does not promise that.
 */
export function hashDefinition(definition: AgentDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/**
 * Whether a record may be served.
 *
 * Approved is not enough on its own: the signatures must be on the
 * definition as it stands now. An edit after approval changes the hash, the
 * signatures no longer match, and the record stops being servable without
 * anyone having to remember to reset its status.
 */
export function isServable(record: RegistryRecord, workflow: Workflow | number = DEFAULT_WORKFLOW): boolean {
  // Numeric callers predate workflows. Keep their threshold, but never let
  // an invalid count turn an unsigned record into a served definition.
  const requiredApprovals = typeof workflow === "number" ? workflow : workflow.requiredApprovals;
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) return false;
  if (record.status !== "approved") return false;
  // Distinct approvers, not signature count. Counting rows would let one
  // person sign twice and satisfy a two-person review, and a record written
  // straight to the store never passed through the checks in transition.ts.
  return validApprovers(record).length >= requiredApprovals;
}

/** Distinct approvers on the definition as it stands. One person signing twice is one signature. */
export function validApprovers(record: RegistryRecord): string[] {
  const current = hashDefinition(record.definition);
  const names = record.approvals
    .filter((approval) => approval.definitionHash === current)
    .map((approval) => approval.approver);
  return [...new Set(names)].sort();
}
