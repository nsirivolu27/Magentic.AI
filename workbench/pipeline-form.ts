import type { PipelineConfig } from "./pipeline.js";
import { BOT_REPOSITORY_TOOLS, type BotPolicy } from "./bot-schema.js";

// A form owns its visible fields, not the saved agent library or stage bindings.
export function readPipelineForm(previous: PipelineConfig, data: FormData, hasBots: boolean): PipelineConfig {
  const field = (name: string) => String(data.get(name) ?? "").trim();
  return { ...structuredClone(previous), name: field("pipelineName"), description: field("description"),
    jira: { enabled: data.has("jiraEnabled"), project: field("project"), issueType: field("issueType") },
    stages: previous.stages.map((stage, index) => ({ ...structuredClone(stage), ...(hasBots ? { bot: {
      ...(stage.bot?.requireSourceRead !== undefined ? { requireSourceRead: stage.bot.requireSourceRead } : {}),
      allowedTools: BOT_REPOSITORY_TOOLS.filter(tool => data.has(`tool-${index}-${tool}`)), maxToolCalls: Number(field(`toolcalls-${index}`)),
      ...(field(`profile-${index}`) ? { profile: field(`profile-${index}`) as NonNullable<BotPolicy["profile"]> } : {}),
      kind: field(`bot-${index}`) as BotPolicy["kind"], maxSteps: Number(field(`steps-${index}`)), timeoutSeconds: Number(field(`timeout-${index}`)),
    } } : stage.bot ? { bot: stage.bot } : {}), ...(stage.assistantId ? { assistantId: stage.assistantId } : {}), id: stage.id, name: field(`name-${index}`), agent: field(`agent-${index}`),
      model: field(`model-${index}`), jiraStatus: field(`status-${index}`), instructions: field(`instructions-${index}`),
      context: field(`context-${index}`), approval: data.has(`approval-${index}`) })) };
}
