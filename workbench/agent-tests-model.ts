import { z } from "zod";
import { agentConfigurableSchema, type AgentConfigurable } from "./agent-configurables.js";
import { tokenUsageSchema } from "./model-usage.js";

/**
 * The shapes Agent Studio tests share between the server and the browser:
 * a saved case, a run, the commands, and the version fingerprint. No Node
 * imports, so the browser bundle can compute the same version the server does.
 */

/** FNV-1a over UTF-16 code units, 64 bit, as twelve hex characters. A fingerprint for change detection, not a security hash. */
function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 12);
}

/** The saved version of an agent: a fingerprint of everything that changes its behaviour. */
export function agentHash(agent: AgentConfigurable): string {
  const parsed = agentConfigurableSchema.parse(agent);
  return fingerprint(JSON.stringify({ name: parsed.name, purpose: parsed.purpose, model: parsed.model, instructions: parsed.instructions, bot: parsed.bot }));
}

const text = (max: number) => z.string().trim().min(1).max(max);
export const testCaseSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), agentId: z.string().uuid(),
  title: text(120), prompt: text(4000),
  /** What a good answer looks like, in the author's words. Shown beside the result; never checked automatically. */
  expected: z.string().trim().max(2000),
  /** A file in the attached repository the agent is expected to read. Empty when the test needs no source. */
  source: z.string().trim().max(250),
  createdBy: z.string().min(1), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type AgentTestCase = z.infer<typeof testCaseSchema>;

export const TEST_RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export const testRunSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), caseId: z.string().uuid(), agentId: z.string().uuid(),
  /** The agent version this run exercised. A later edit makes the run out of date without erasing it. */
  agentHash: z.string().length(12), agentName: z.string(), model: z.string(),
  prompt: text(4000), expected: z.string().max(2000), source: z.string().max(250),
  startedBy: z.string().min(1), startedAt: z.string(), finishedAt: z.string().optional(),
  status: z.enum(TEST_RUN_STATUSES),
  /** The agent's answer when the execution finished. Empty otherwise. */
  summary: z.string().max(40_000),
  /** Why the execution did not finish, in words a person can act on. Empty when it did. */
  error: z.string().max(2000),
  /** Every MCP call the worker made, in order, with the file it read when it read one. */
  toolCalls: z.array(z.object({ name: z.string(), path: z.string().optional(), outcome: z.enum(["read", "empty", "missing", "called"]) }).strict()).max(50),
  /** True only when a read returned non-empty content. A claim in the answer never sets this. */
  sourceRead: z.boolean(),
  calls: z.number().int().min(0),
  tokenUsage: tokenUsageSchema.nullable(),
  events: z.array(z.string().max(500)).max(60),
  /** A person's judgement of the answer. Independent of status: a finished execution can still fail review. */
  review: z.object({ verdict: z.enum(["pass", "fail", "unsure"]), note: z.string().max(2000), by: z.string().min(1), at: z.string() }).strict().optional(),
}).strict();
export type AgentTestRun = z.infer<typeof testRunSchema>;



export interface AgentTestsSnapshot { cases: AgentTestCase[]; runs: AgentTestRun[]; busy: boolean }

export const agentTestCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_case"), id: z.string().uuid().optional(), agentId: z.string().uuid(), title: text(120), prompt: text(4000), expected: z.string().trim().max(2000).default(""), source: z.string().trim().max(250).default("") }).strict(),
  z.object({ action: z.literal("delete_case"), caseId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("cancel"), runId: z.string().uuid() }).strict(),
  /** expectedVersion is the workspace configuration version the person saw; a changed agent must be re-read before it is tested. */
  z.object({ action: z.literal("run"), caseId: z.string().uuid(), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("review"), runId: z.string().uuid(), verdict: z.enum(["pass", "fail", "unsure"]), note: z.string().trim().max(2000).default("") }).strict(),
]);


/** Structured tool calls, rebuilt from the worker's event log so the worker itself stays unchanged in shape. */
export function toolCallsFrom(events: readonly string[]): AgentTestRun["toolCalls"] {
  const calls: AgentTestRun["toolCalls"] = [];
  for (const event of events) {
    const call = /^MCP tool: (\S+)$/.exec(event);
    if (call) { calls.push({ name: call[1]!, outcome: "called" }); continue; }
    const read = /^Source (read|empty|missing): (.+?)(?: \(\d+ characters\))?$/.exec(event);
    if (read && calls.length && calls[calls.length - 1]!.name === "read_project_file") {
      const last = calls[calls.length - 1]!;
      last.path = read[2]!; last.outcome = read[1] as "read" | "empty" | "missing";
    }
  }
  return calls.slice(0, 50);
}

export function blockingTestReviews(agent: AgentConfigurable, tests: Pick<AgentTestsSnapshot, "runs"> | undefined): AgentTestRun[] {
  const current = agentHash(agent);
  const reviewedCases = new Set<string>();
  const blocked: AgentTestRun[] = [];
  // A different prompt must not erase a rejection. Runs retain the case they
  // exercised even when an author edits or deletes the saved test case.
  for (const run of [...(tests?.runs ?? [])].reverse()) {
    if (run.agentId !== agent.id || run.agentHash !== current || !run.review) continue;
    const key = JSON.stringify([run.caseId, run.prompt, run.expected, run.source]);
    if (reviewedCases.has(key)) continue;
    reviewedCases.add(key);
    if (run.review.verdict !== "pass" || run.status !== "succeeded") blocked.push(run);
  }
  return blocked;
}

// Execution alone remains sufficient for an unreviewed test, but it must
// never override a recorded quality rejection of the same agent version.
export function passedCurrentTest(agent: AgentConfigurable, tests: Pick<AgentTestsSnapshot, "runs"> | undefined): boolean {
  const current = agentHash(agent);
  return (tests?.runs ?? []).some(run => run.agentId === agent.id && run.agentHash === current && run.status === "succeeded")
    && blockingTestReviews(agent, tests).length === 0;
}
