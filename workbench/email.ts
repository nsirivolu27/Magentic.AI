import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEvent } from "../registry/audit.js";
import { hashDefinition, isServable, validApprovers, type RegistryRecord } from "../registry/record.js";
import type { MemberDirectory } from "../registry/roles.js";
import type { Workflow } from "../registry/workflow.js";

export const invitationSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  role: z.enum(["author", "approver"]),
  note: z.string().trim().max(1_000).default(""),
}).strict();

export const emailPreferencesSchema = z.object({ reviews: z.boolean(), updates: z.boolean() }).strict();
export type EmailPreferences = z.infer<typeof emailPreferencesSchema>;
export interface EmailContact { workspaceId: string; actor: string; email: string }
export interface EmailMessage {
  id: string;
  workspaceId: string;
  sender: string;
  recipient: string;
  recipientActor?: string;
  kind: "review" | "approval" | "changes" | "retired" | "invitation";
  subject: string;
  text: string;
  createdAt: string;
  status: "preview" | "cancelled";
  viewed: boolean;
  agentName?: string;
  definitionHash?: string;
  invitedRole?: "author" | "approver";
}
export interface Mailbox {
  messages: EmailMessage[];
  preferences: EmailPreferences;
  canInvite: boolean;
  delivery: "preview";
}

/**
 * Preview mail stays separate from membership and approval. A message can
 * ask someone to act, but cannot grant access or sign on their behalf.
 */
export function memoryEmail(contacts: readonly EmailContact[] = []) {
  const messages: EmailMessage[] = [];
  const seen = new Set<string>();
  const preferences = new Map<string, EmailPreferences>();
  const key = (workspaceId: string, actor: string) => JSON.stringify([workspaceId, actor]);
  const preferencesFor = (workspaceId: string, actor: string): EmailPreferences =>
    preferences.get(key(workspaceId, actor)) ?? { reviews: true, updates: true };

  return {
    mailbox(workspaceId: string, actor: string, admin: boolean): Mailbox {
      return {
        messages: messages.filter((message) => message.workspaceId === workspaceId
          && (admin || message.sender === actor || message.recipientActor === actor)).map((message) => ({ ...message })).reverse(),
        preferences: { ...preferencesFor(workspaceId, actor) },
        canInvite: admin, delivery: "preview",
      };
    },

    setPreferences(workspaceId: string, actor: string, raw: unknown): void {
      preferences.set(key(workspaceId, actor), emailPreferencesSchema.parse(raw));
    },

    invite(workspaceId: string, actor: string, raw: unknown): EmailMessage {
      const input = invitationSchema.parse(raw);
      if (messages.some((message) => message.workspaceId === workspaceId && message.kind === "invitation"
        && message.recipient === input.email && message.status === "preview")) {
        throw new Error("An invitation draft already exists for this address. Cancel it before creating a replacement.");
      }
      const message: EmailMessage = {
        id: randomUUID(), workspaceId, sender: actor, recipient: input.email,
        kind: "invitation", invitedRole: input.role,
        subject: `Invitation to ${workspaceId}`,
        text: `${actor} would like you to join ${workspaceId} as an ${input.role}.\n\n${input.note ? input.note + "\n\n" : ""}This is an invitation draft. It has not been sent and does not grant workspace access.`,
        createdAt: new Date().toISOString(), status: "preview", viewed: false,
      };
      messages.push(message);
      return { ...message };
    },

    cancelInvitation(workspaceId: string, id: string): boolean {
      const message = messages.find((item) => item.workspaceId === workspaceId && item.id === id && item.kind === "invitation");
      if (!message) return false;
      message.status = "cancelled";
      return true;
    },

    markViewed(workspaceId: string, actor: string, id: string): boolean {
      const message = messages.find((item) => item.workspaceId === workspaceId && item.id === id && item.recipientActor === actor);
      if (!message) return false;
      message.viewed = true;
      return true;
    },

    async capture(event: AuditEvent, record: RegistryRecord, members: MemberDirectory, workflow: Workflow): Promise<void> {
      if (event.workspaceId !== record.workspaceId || event.agentName !== record.definition.name
        || event.definitionHash !== hashDefinition(record.definition)) return;
      if (!["submitted", "approved", "changes-requested", "retired"].includes(event.action)) return;
      const eventKey = JSON.stringify([event.workspaceId, event.agentName, event.action, event.actor, event.at, event.definitionHash]);
      if (seen.has(eventKey)) return;
      const pending: EmailMessage[] = [];
      for (const contact of contacts.filter((item) => item.workspaceId === event.workspaceId)) {
        const roles = await members.rolesFor(event.workspaceId, contact.actor);
        if (!roles.length) continue;
        const prefs = preferencesFor(event.workspaceId, contact.actor);
        const review = event.action === "submitted";
        if (review) {
          if (!prefs.reviews || contact.actor === record.author
            || (!roles.includes(workflow.roles.approve) && !roles.includes("admin"))) continue;
        } else if (!prefs.updates || contact.actor !== record.author) continue;

        const kind: EmailMessage["kind"] = review ? "review" : event.action === "approved" ? "approval"
          : event.action === "changes-requested" ? "changes" : "retired";
        const count = validApprovers(record).length;
        const subject = kind === "review" ? `Review requested: ${record.definition.title}`
          : kind === "approval" ? `${isServable(record, workflow) ? "Approval complete" : "Approval recorded"}: ${record.definition.title}`
          : kind === "changes" ? `Changes requested: ${record.definition.title}` : `Agent retired: ${record.definition.title}`;
        const text = `${event.actor} ${event.action} ${record.definition.title} in ${event.workspaceId}.\n\n`
          + (kind === "approval" ? `${count} of ${workflow.requiredApprovals} distinct approvals match this content. ${isServable(record, workflow) ? "It is eligible for the next MCP catalog load." : "It is not yet eligible to be served."}\n\n` : "")
          + (event.note ? `Review note: ${event.note}\n\n` : "")
          + "Open the agent in Magentic to review the current definition. This message does not approve or publish an agent.\n\n"
          + `Content fingerprint: ${event.definitionHash}`;
        pending.push({
          id: randomUUID(), workspaceId: event.workspaceId, sender: event.actor, recipient: contact.email,
          recipientActor: contact.actor, kind, subject, text, createdAt: event.at, status: "preview", viewed: false,
          agentName: event.agentName, definitionHash: event.definitionHash,
        });
      }
      // Resolve every recipient before adding anything, so a directory error
      // can be retried without creating a partial batch of duplicate mail.
      messages.push(...pending);
      seen.add(eventKey);
    },
  };
}

export type EmailPortal = ReturnType<typeof memoryEmail>;
