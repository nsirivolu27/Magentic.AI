import { BOT_PROFILES } from "./bot-profiles.js";
import type { BotPolicy } from "./bot-schema.js";

// Constrained decoding helps small local models choose a legal next step.
// The worker still validates every response; a schema is not authorization.
export function botResponseFormat(bot: BotPolicy, tools: readonly string[], sourceRead: boolean): Record<string, unknown> {
  const choices: Record<string, unknown>[] = tools.map(name => ({
    type: "object", additionalProperties: false,
    properties: {
      type: { const: "tool" }, name: { const: name },
      arguments: name === "read_project_file"
        ? { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 250 } }, required: ["path"], additionalProperties: false }
        : { type: "object", properties: {}, additionalProperties: false },
    },
    required: ["type", "name", "arguments"],
  }));
  if (!bot.requireSourceRead || sourceRead) {
    const properties: Record<string, unknown> = {
      type: { const: "result" },
      summary: { type: "string", minLength: 1, maxLength: bot.profile ? 600 : 3000 },
      changes: { type: "array", maxItems: bot.kind === "coder" ? 5 : 0, items: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 250 }, content: { type: "string", maxLength: 30000 } },
        required: ["path", "content"],
      } },
    };
    const required = ["type", "summary", "changes"];
    if (bot.profile) {
      properties.handoff = {
        type: "object", additionalProperties: false,
        properties: {
          sections: { type: "array", minItems: 4, maxItems: 4, items: {
            type: "object", additionalProperties: false,
            properties: { title: { type: "string", enum: BOT_PROFILES[bot.profile].sections }, body: { type: "string", minLength: 1, maxLength: 400 } },
            required: ["title", "body"],
          } },
          blockers: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } },
        },
        required: ["sections", "blockers"],
      };
      required.push("handoff");
    }
    choices.push({ type: "object", additionalProperties: false, properties, required });
  }
  return choices.length === 1 ? choices[0]! : { anyOf: choices };
}
