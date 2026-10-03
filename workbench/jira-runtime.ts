import { z } from "zod";
import {
  deliver, intentForRequest, recoverInterrupted, workspaceActionStore,
  type CallerIdentity, type DeliveryOutcome,
} from "./jira-actions.js";
import { hashIntent, OPERATIONS, previewDelivery, updatableFieldsSchema, type JiraDelivery } from "./jira.js";
import type { PipelineEngine } from "./pipeline.js";
import type { WorkspaceStore } from "./storage.js";

const references = {
  runId: z.string().uuid(), eventId: z.string().uuid(),
  operation: z.enum(OPERATIONS).optional(), fields: updatableFieldsSchema.optional(),
};
export const jiraCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), ...references }).strict(),
  z.object({ action: z.literal("deliver"), ...references,
    expectedIntentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
export const jiraInspectionSchema = z.object({
  runId: z.string().uuid(), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export class JiraApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type JiraRuntime = ReturnType<typeof createJiraRuntime>;

// The caller must deliberately inject a delivery adapter. Merely finding
// credentials on the machine must not turn a local preview into a Jira write.
export function createJiraRuntime(
  pipelines: PipelineEngine, store: WorkspaceStore, delivery: JiraDelivery = previewDelivery(),
) {
  const actions = workspaceActionStore(store);
  const context = { pipelines, actions, delivery };
  const active = new Set<Promise<DeliveryOutcome>>();
  let closed = false;

  return {
    inspect(workspaceId: string, raw: unknown) {
      const { runId, offset, limit } = jiraInspectionSchema.parse(raw);
      const run = pipelines.snapshot(workspaceId).runs.find(item => item.id === runId);
      if (!run || run.workspaceId !== workspaceId) throw new JiraApiError(404, "Run not found in this workspace.");
      const found = actions.list(workspaceId).filter(item => item.intent.runId === runId);
      return {
        mode: delivery.mode, siteOrigin: delivery.siteOrigin, runId,
        total: found.length, offset,
        nextOffset: offset + limit < found.length ? offset + limit : null,
        actions: found.slice(offset, offset + limit),
      };
    },

    async execute(identity: CallerIdentity, raw: unknown) {
      if (closed) throw new JiraApiError(503, "Jira actions are shutting down.");
      if (!identity.roles.includes("admin")) throw new JiraApiError(403, "A workspace admin must review Jira actions.");
      const input = jiraCommandSchema.parse(raw);
      const request = { runId: input.runId, eventId: input.eventId,
        ...(input.operation ? { operation: input.operation } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      };
      const intent = intentForRequest(pipelines, identity, request, delivery.siteOrigin);
      const expectedIntentHash = hashIntent(intent);
      if (input.action === "preview") return { mode: delivery.mode, intent, expectedIntentHash };
      if (input.expectedIntentHash !== expectedIntentHash) {
        throw new JiraApiError(409, "The Jira intent or destination changed. Preview and review it again.");
      }
      const pending = deliver(context, identity, request);
      active.add(pending);
      try { return { mode: delivery.mode, ...await pending }; }
      finally { active.delete(pending); }
    },

    // Call only during startup, before requests can arrive. An active claim
    // in a running process must not be mistaken for an interrupted attempt.
    async recover(workspaceId: string) { await recoverInterrupted(context, workspaceId); },

    async close() {
      closed = true;
      // Keep storage open until already-authorized attempts record an outcome.
      await Promise.allSettled([...active]);
    },
  };
}
