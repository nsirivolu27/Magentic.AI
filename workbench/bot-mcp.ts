import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOT_REPOSITORY_TOOLS, DEFAULT_BOT_POLICY, effectiveToolPolicy, type BotPolicy } from "./bot-schema.js";
import type { BotRuntime } from "./bot-runtime.js";
import type { PipelineEngine } from "./pipeline.js";
import { BOT_PROFILES } from "./bot-profiles.js";

// The HTTP boundary supplies the workspace. Tool arguments cannot redirect a
// valid credential to another workspace's repository or source proposals.
export function registerBotInspection(server: McpServer, engine: PipelineEngine, bots: BotRuntime, workspace: string, approvals: number): void {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const missing = () => ({ ...result({ error: "Run or attempt not found in this workspace." }), isError: true });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("get_pipeline_capabilities", {
    description: "Discover configured phase models, enforced repository tool permissions, limits, and execution boundaries. Describes configuration, not model availability.",
    inputSchema: z.object({}).strict(), annotations,
  }, async () => {
    const snapshot = engine.snapshot(workspace);
    return result({ schemaVersion: 1, workspaceId: workspace, configurationVersion: snapshot.version,
      storage: snapshot.storage, requiredApprovals: approvals, jiraDelivery: snapshot.jiraDelivery,
      repositoryTools: BOT_REPOSITORY_TOOLS,
      execution: { mode: "supervised", botCommands: "local application session", directMcpBotExecution: false,
        directMcpFileWrites: false, independentHumanApproval: true, tokenUsage: "unavailable", cost: "unavailable" },
      phases: snapshot.config.stages.map(stage => {
        const bot: BotPolicy = stage.bot ?? DEFAULT_BOT_POLICY;
        return { id: stage.id, name: stage.name, kind: bot.kind, model: stage.model,
          ...(bot.profile ? { profile: bot.profile, expectedSections: BOT_PROFILES[bot.profile].sections } : {}),
          approvalRequired: stage.approval, maxModelCalls: bot.maxSteps, timeoutSeconds: bot.timeoutSeconds, ...effectiveToolPolicy(bot) };
      }),
    });
  });
  server.registerTool("list_bot_attempts", {
    description: "List compact bot attempt summaries for one workspace run, oldest first. Fetch a specific attempt to read its source proposals and validation evidence.",
    inputSchema: z.object({ runId: z.string().uuid(), offset: z.number().int().min(0).max(100).default(0),
      limit: z.number().int().min(1).max(50).default(20) }).strict(), annotations,
  }, async ({ runId, offset, limit }) => {
    if (!engine.snapshot(workspace).runs.some(run => run.id === runId)) return missing();
    const attempts = bots.snapshot(workspace).attempts.filter(attempt => attempt.runId === runId);
    const page = attempts.slice(offset, offset + limit).map(attempt => ({ id: attempt.id, runId: attempt.runId,
      stageId: attempt.stageId, revision: attempt.revision, kind: attempt.bot.kind, model: attempt.model,
      ...(attempt.bot.profile ? { profile: attempt.bot.profile, blockers: attempt.handoff?.blockers.length ?? 0 } : {}),
      ...(attempt.revisionSource ? { revisionOf: attempt.revisionSource.attemptId } : {}),
      status: attempt.status, calls: attempt.calls, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt ?? null,
      proposedFiles: attempt.changes.length, checksRun: attempt.checks.length, checksPassed: attempt.checks.filter(check => check.passed).length }));
    return result({ runId, total: attempts.length, attempts: page, nextOffset: offset + limit < attempts.length ? offset + limit : null });
  });
  server.registerTool("get_bot_attempt", {
    description: "Read one attempt's immutable phase policy, reviewed proposal hash, source changes, execution log, and actual validation results. Does not apply or approve anything.",
    inputSchema: z.object({ runId: z.string().uuid(), attemptId: z.string().uuid() }).strict(), annotations,
  }, async ({ runId, attemptId }) => {
    if (!engine.snapshot(workspace).runs.some(run => run.id === runId)) return missing();
    const attempt = bots.snapshot(workspace).attempts.find(item => item.runId === runId && item.id === attemptId);
    return attempt ? result({ attempt, toolPolicy: effectiveToolPolicy(attempt.bot) }) : missing();
  });
}
