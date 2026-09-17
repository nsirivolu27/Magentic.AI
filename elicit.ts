import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Asking, where the alternative is guessing.
 *
 * create_handoff mints a bearer link. How long it lives, how many times it
 * can be spent and whether names and keys are stripped out of it are the
 * three decisions that matter, and until now all three had defaults, because
 * a tool call has nowhere to ask. Sixty minutes and twenty-five uses were
 * never a judgement about the situation; they were a placeholder standing in
 * for one.
 *
 * Elicitation removes the placeholder. When the caller left a field out and
 * the client can ask, the person answers. When the caller passed a value,
 * nothing is asked, because they already decided. When the client cannot
 * ask, the old defaults apply exactly as before, so no existing setup
 * changes behaviour.
 *
 * Declining is not the same as accepting the defaults. Someone who was shown
 * the question and dismissed it has not agreed to a sixty minute unredacted
 * link, so nothing is minted and the tool says how to pass the values
 * directly instead.
 */

export interface HandoffChoices {
  ttlMinutes: number;
  maxUses: number;
  redact: boolean;
}

export type ElicitOutcome =
  | { asked: false }
  | { asked: true; accepted: true; choices: Partial<HandoffChoices> }
  | { asked: true; accepted: false; reason: "declined" | "cancelled" };

/**
 * The SDK already types what elicitInput accepts and returns precisely, so
 * these are derived from it rather than restated. A restated shape is a
 * shape that drifts.
 */
type ElicitResult = Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;

/** Can the connected client put a question in front of the person? */
export function clientSupportsElicitation(server: McpServer): boolean {
  try {
    return Boolean(server.server.getClientCapabilities()?.elicitation);
  } catch {
    return false;
  }
}

/**
 * Which of the three the caller left for someone else to decide.
 *
 * This reads the parsed options, which only works because the schema makes
 * them optional rather than defaulted. The SDK validates a tool's input
 * before the handler ever runs, so a `.default()` would have filled these in
 * and "omitted" would be indistinguishable from "chose the default" by the
 * time any of this code could look.
 */
export function missingChoices(parsed: unknown): (keyof HandoffChoices)[] {
  const given = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const fields: (keyof HandoffChoices)[] = ["ttlMinutes", "maxUses", "redact"];
  return fields.filter((field) => given[field] === undefined);
}

/**
 * Put the unanswered questions to the person.
 *
 * Only the fields the caller left out are asked, so a model that already
 * decided on a one hour link is not made to re-answer it. Enumerated
 * durations rather than a free number, because the useful answer here is a
 * shape of situation and not an integer.
 */
export async function askHandoffChoices(
  server: McpServer,
  title: string,
  missing: readonly (keyof HandoffChoices)[],
): Promise<ElicitOutcome> {
  if (missing.length === 0 || !clientSupportsElicitation(server)) return { asked: false };

  // Built by spreading rather than by assigning into a typed map, so the
  // literal types survive and the SDK's own schema type checks this.
  const properties = {
    ...(missing.includes("ttlMinutes") ? {
      ttlMinutes: {
        type: "string" as const,
        title: "How long should the link work?",
        enum: ["15", "60", "480", "1440", "10080"],
        enumNames: ["15 minutes", "1 hour", "8 hours", "1 day", "1 week"],
        default: "60",
      },
    } : {}),
    ...(missing.includes("maxUses") ? {
      maxUses: {
        type: "string" as const,
        title: "How many times can it be redeemed?",
        enum: ["1", "3", "25"],
        enumNames: ["Once, for one person", "A few times", "Up to 25"],
        default: "3",
      },
    } : {}),
    ...(missing.includes("redact") ? {
      redact: {
        type: "boolean" as const,
        title: "Strip names, addresses and keys before sending?",
        default: true,
      },
    } : {}),
  };

  let result: ElicitResult;
  try {
    result = await server.server.elicitInput({
      message: `Minting a share link for "${title}". Anyone holding this link can read the conversation until it expires.`,
      requestedSchema: { type: "object", properties, required: missing.map(String) },
    });
  } catch {
    // A client that advertised elicitation and then failed the request is a
    // client we cannot ask. Fall back rather than failing the tool call.
    return { asked: false };
  }

  if (result.action !== "accept") {
    return { asked: true, accepted: false, reason: result.action === "decline" ? "declined" : "cancelled" };
  }
  return { asked: true, accepted: true, choices: readChoices(result.content) };
}

/**
 * Durations and counts come back as strings because they were offered as
 * enums, so anything unparseable is dropped and the schema default applies
 * rather than becoming NaN.
 */
function readChoices(content: ElicitResult["content"]): Partial<HandoffChoices> {
  const chosen: Partial<HandoffChoices> = {};
  const ttl = Number.parseInt(String(content?.["ttlMinutes"] ?? ""), 10);
  if (Number.isFinite(ttl)) chosen.ttlMinutes = ttl;
  const uses = Number.parseInt(String(content?.["maxUses"] ?? ""), 10);
  if (Number.isFinite(uses)) chosen.maxUses = uses;
  const redact = content?.["redact"];
  if (typeof redact === "boolean") chosen.redact = redact;
  return chosen;
}
