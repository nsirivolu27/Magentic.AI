import type { PipelineConfig, PipelineSnapshot } from "./pipeline.js";
import { installWorkforceAgents, workforceTemplates } from "./workforce-marketplace.js";

export interface CanvasDraft {
  workspace: string;
  actor: string;
  version: number;
  config: PipelineConfig;
  selected: string;
  dirty: boolean;
}

export function createCanvasDraft(workspace: string, actor: string, pipeline: PipelineSnapshot): CanvasDraft {
  return { workspace, actor, version: pipeline.version, config: structuredClone(pipeline.config),
    selected: pipeline.config.stages[0]!.id, dirty: false };
}

export function canvasAgents(config: PipelineConfig) {
  const saved = config.configurables ?? [];
  return [
    ...saved.map(agent => ({ agent, source: "Workspace" })),
    ...workforceTemplates.filter(item => !saved.some(agent => agent.id === item.definition.id))
      .map(item => ({ agent: item.definition, source: "Marketplace" })),
  ];
}

export function addCanvasAgent(config: PipelineConfig, agentId: string, stageId: string, position: number): PipelineConfig {
  if (!Number.isInteger(position) || position < 0 || position > config.stages.length) throw new Error("Choose a connection in this workflow.");
  if (config.stages.length >= 12) throw new Error("A workflow can have up to 12 stages.");
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(stageId) || config.stages.some(stage => stage.id === stageId)) throw new Error("Choose a unique stage ID.");
  let next = structuredClone(config);
  if (!next.configurables?.some(agent => agent.id === agentId)) {
    const template = workforceTemplates.find(item => item.definition.id === agentId);
    if (!template) throw new Error("Choose an agent from this workspace or the marketplace.");
    next = installWorkforceAgents(next, [template.slug]);
  }
  const agent = next.configurables!.find(item => item.id === agentId)!;
  // New work starts with a review gate; arranging nodes cannot grant approval.
  next.stages.splice(position, 0, { id: stageId, name: agent.name, agent: agent.name, instructions: agent.instructions,
    model: agent.model, bot: structuredClone(agent.bot), context: "Work item, attached references and completed stage outputs",
    approval: true, jiraStatus: "In Review" });
  return next;
}

export function moveCanvasStage(config: PipelineConfig, id: string, position: number): PipelineConfig {
  const index = config.stages.findIndex(stage => stage.id === id);
  if (index < 0 || !Number.isInteger(position) || position < 0 || position > config.stages.length) throw new Error("Choose a stage and connection in this workflow.");
  const next = structuredClone(config);
  const [stage] = next.stages.splice(index, 1);
  next.stages.splice(position > index ? position - 1 : position, 0, stage!);
  return next;
}

export function removeCanvasStage(config: PipelineConfig, id: string, savedConfig: PipelineConfig = config): PipelineConfig {
  const stage = config.stages.find(item => item.id === id);
  if (!stage) throw new Error("Choose an existing stage.");
  if (config.stages.length === 1) throw new Error("Keep at least one stage.");
  const saved = savedConfig.stages.find(item => item.id === id);
  if (saved?.approval || saved?.assistantId) throw new Error("Review gates and approved assistant stages stay in the workflow. Use workflow settings for policy changes.");
  const next = structuredClone(config);
  next.stages = next.stages.filter(item => item.id !== id);
  return next;
}

export function editCanvasStage(config: PipelineConfig, id: string, fields: { name: string; instructions: string; context: string; model: string }): PipelineConfig {
  const next = structuredClone(config);
  const stage = next.stages.find(item => item.id === id);
  if (!stage) throw new Error("Choose an existing stage.");
  if (stage.assistantId) throw new Error("This stage uses an approved assistant. Edit its binding in workflow settings.");
  const values = { name: fields.name.trim(), instructions: fields.instructions.trim(), context: fields.context.trim(), model: fields.model.trim() };
  if (!values.name || values.name.length > 80 || !values.instructions || values.instructions.length > 4000
    || values.context.length > 2000 || !values.model || values.model.length > 200) throw new Error("Check the stage name, instructions, context and model.");
  Object.assign(stage, values);
  return next;
}

export function canvasSaveCommand(draft: CanvasDraft, workspace: string, actor: string, pipeline: PipelineSnapshot) {
  if (draft.workspace !== workspace || draft.actor !== actor) throw new Error("This draft belongs to another workspace session.");
  if (draft.version !== pipeline.version) throw new Error("Workflow changed elsewhere. Reload the saved workflow before editing again.");
  return { action: "configure" as const, expectedVersion: draft.version, config: structuredClone(draft.config) };
}
