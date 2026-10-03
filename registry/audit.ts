import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * What happened to a definition, and who did it.
 *
 * Append only, on purpose. The value of this log is that it cannot be tidied
 * up afterwards, so nothing here updates or deletes. A record's current
 * status says what is true now; this says how it got there, which is the
 * question an auditor actually asks.
 *
 * Kept separate from the record because the two have different lifetimes. A
 * record can be removed; what people did to it should outlive it.
 */

export const ACTIONS = ["authored", "edited", "submitted", "approved", "changes-requested", "retired"] as const;
export type Action = typeof ACTIONS[number];

export const auditEventSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(64),
  action: z.enum(ACTIONS),
  actor: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
  /** The definition as it stood when this happened, so a signature is checkable later. */
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().max(2_000).optional(),
}).strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
  /** Events for one workspace, oldest first. */
  list(workspaceId: string, agentName?: string): Promise<AuditEvent[]>;
}

/** Events held in memory. For tests, and for a process that should persist nothing. */
export function memoryAudit(seed: readonly AuditEvent[] = []): AuditSink {
  const events: AuditEvent[] = [...seed];
  return {
    async append(event) {
      events.push(auditEventSchema.parse(event));
    },
    async list(workspaceId, agentName) {
      return events.filter((event) =>
        event.workspaceId === workspaceId && (!agentName || event.agentName === agentName));
    },
  };
}

/**
 * One JSON object per line, one file per workspace.
 *
 * Lines rather than a JSON array because appending to an array means reading
 * and rewriting the whole file, and a log that gets rewritten on every write
 * is a log that can be lost in a crash halfway through.
 */
export function fileAudit(directory: string): AuditSink {
  return {
    async append(event) {
      const parsed = auditEventSchema.parse(event);
      mkdirSync(directory, { recursive: true });
      appendFileSync(pathFor(directory, parsed.workspaceId), `${JSON.stringify(parsed)}\n`, "utf8");
    },

    async list(workspaceId, agentName) {
      let text: string;
      try {
        text = readFileSync(pathFor(directory, workspaceId), "utf8");
      } catch {
        // A workspace nothing has happened in yet has no log, not a broken one.
        return [];
      }
      const events: AuditEvent[] = [];
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        const parsed = auditEventSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          throw new Error(`Audit line ${index + 1} for workspace ${workspaceId} is not a valid event.`);
        }
        if (!agentName || parsed.data.agentName === agentName) events.push(parsed.data);
      }
      return events;
    },
  };
}

function pathFor(directory: string, workspaceId: string): string {
  const segment = workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`"${workspaceId}" is not usable as an audit file name.`);
  }
  return join(directory, `${segment}.jsonl`);
}
