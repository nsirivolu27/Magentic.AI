import catalogue from "../examples/workforce/accenture/catalogue.json" with { type: "json" };
import { agentConfigurableSchema, saveConfigurable } from "./agent-configurables.js";
import type { PipelineConfig } from "./pipeline.js";

export const workforceCatalogue = catalogue;
export const workforceTemplates = catalogue.agents.map(item => ({
  ...item, definition: agentConfigurableSchema.parse(item.definition),
}));

export function installWorkforceAgents(config: PipelineConfig, slugs: string[]): PipelineConfig {
  if (!slugs.length || new Set(slugs).size !== slugs.length) throw new Error("Choose distinct agent templates.");
  const templates = slugs.map(slug => {
    const template = workforceTemplates.find(item => item.slug === slug);
    if (!template) throw new Error("Choose an existing agent template.");
    return template;
  });
  const saved = new Set(config.configurables?.map(agent => agent.id));
  const additions = templates.filter(item => !saved.has(item.definition.id));
  if ((config.configurables?.length ?? 0) + additions.length > 30) {
    throw new Error("This workspace can hold 30 agents. Add fewer templates.");
  }
  // Stable template IDs make retries safe. A company's edited copy always wins.
  let next = structuredClone(config);
  for (const template of additions) next = saveConfigurable(next, template.definition);
  return next;
}
