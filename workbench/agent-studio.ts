import { agentConfigurableSchema, configurableStages, type AgentConfigurable } from "./agent-configurables.js";

import type { WorkbenchSnapshot } from "./snapshot.js";
import type { ChatModelOption } from "./chat.js";

export function agentReadiness(snapshot: WorkbenchSnapshot, agent: AgentConfigurable, models: ChatModelOption[]) {
  const stages = snapshot.pipelines ? configurableStages(snapshot.pipelines.config, agent) : [];
  const checks = [
    { label: "Model connected", ready: models.some(model => model.id === agent.model && model.available), href: "#/chat" },
    { label: "Repository attached", ready: Boolean(snapshot.bots?.project), href: "#/desk/new" },
    { label: "Saved agent assigned", ready: stages.length > 0, href: "#agent-studio-assign" },
    { label: "Execution available", ready: Boolean(snapshot.bots) && !snapshot.bots?.busy, href: "#/desk" },
  ];
  if (agent.bot.kind === "validator") checks.push({ label: "Validation command configured", ready: Boolean(snapshot.bots?.project?.checks.length), href: "#/desk/new" });
  return { stages, checks, ready: checks.every(check => check.ready) };
}

/** Imports are templates, never authority to replace an existing workspace agent. */
export function importAgentDefinition(text: string, newId: string): AgentConfigurable {
  if (text.length > 20_000) throw new Error("Agent definition must be under 20,000 characters.");
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error("Paste a valid agent JSON definition."); }
  const parsed = agentConfigurableSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join(".") || "definition");
    throw new Error(`Check agent fields: ${[...new Set(fields)].join(", ")}.`);
  }
  return agentConfigurableSchema.parse({ ...parsed.data, id: newId });
}

export function exportAgentDefinition(agent: AgentConfigurable): string {
  return JSON.stringify(agentConfigurableSchema.parse(agent), null, 2);
}
