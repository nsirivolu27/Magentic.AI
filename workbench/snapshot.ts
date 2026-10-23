import type { OntologyCatalog } from "./ontology.js";
import type { RegistryRecord } from "../registry/record.js";
import type { AuditEvent } from "../registry/audit.js";
import type { Workflow } from "../registry/workflow.js";
import type { Role } from "../registry/roles.js";
import type { Mailbox } from "./email.js";
import type { McpOverview } from "./mcp-portal.js";
import type { ChatAvailability } from "./chat.js";
import type { BotSnapshot } from "./bot-schema.js";
import type { PipelineSnapshot } from "./pipeline.js";
import type { StudioSnapshot } from "./studio/engine.js";
import type { SchedulerSnapshot } from "./scheduler.js";
import type { LearningState } from "./learning-schedule.js";
import type { DocumentState } from "./documents.js";

/** One approved-agent record as GET /api/workspace serves it. */
export type RecordView = RegistryRecord & { hash: string; eligible: boolean; validApprovers: string[] };

/** Everything GET /api/workspace returns. The pages render from this and nothing else. */
export interface WorkbenchSnapshot {
  ontology?: OntologyCatalog;
  pipelines?: PipelineSnapshot;
  jira?: { canReview: boolean };
  bots?: BotSnapshot;
  studio?: StudioSnapshot;
  studioError?: string;
  schedule?: SchedulerSnapshot;
  learning?: LearningState;
  documents?: DocumentState;
  workspaceId: string; actor: string; roles: Role[]; workflow: Workflow;
  canAuthor: boolean; records: RecordView[]; audit: AuditEvent[]; demo: boolean; mail?: Mailbox; mcp: McpOverview; chat: ChatAvailability;
}
