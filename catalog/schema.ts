import { z } from "zod";

/**
 * An agent, as this server understands one.
 *
 * It is configuration and nothing else: which tools are active, what the
 * thing is for, what a model should be told about it, and which scopes it
 * needs. No code, no model, no credential. That is the same definition
 * MARKETPLACE.md gives a package, on purpose, so the catalog a hosted server
 * serves and the packages a marketplace would distribute are one object
 * rather than two that drift.
 *
 * What an agent cannot do is as much of the design as what it can. It cannot
 * name a relay, so it cannot point a caller at someone else's data. It
 * cannot carry a key, so installing one grants nothing. It cannot widen the
 * deployment's scopes, so a read-only host stays read-only whatever arrives
 * in an agent file.
 */

const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOOL = /^[a-z][a-z0-9_]{1,63}$/;

export const agentSchema = z.object({
  /** Stable, unique, and the last path segment of this agent's MCP endpoint. */
  name: z.string().regex(NAME, "Agent names are lowercase letters, digits and hyphens."),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  category: z.string().trim().min(1).max(60).default("general"),
  /** Immutable per release, so an installation record means something later. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Versions are semantic: major.minor.patch."),

  /**
   * Tools this agent requires. A name here that the server does not register
   * fails at boot rather than producing an agent that is quietly missing
   * half of what it promised.
   */
  tools: z.array(z.string().regex(TOOL)).min(1).max(100),

  /**
   * Tools this agent uses when the deployment has them. The language model
   * tools are the reason this exists: they are present only when an operator
   * configured a provider, and an agent should not refuse to load on a
   * server that did not.
   */
  optionalTools: z.array(z.string().regex(TOOL)).max(100).default([]),

  /**
   * What this agent needs to be able to do. "read" is implied and cannot be
   * dropped; "write" is the one that matters, and it is a request rather
   * than a grant. A deployment running with MAGENTIC_SCOPES=read hides the
   * write tools from an agent that asks for them.
   */
  scopes: z.array(z.enum(["read", "write"])).min(1).default(["read"]),

  /** What a connecting model is told this endpoint is for. */
  instructions: z.string().trim().min(1).max(4_000),

  /** Where the definition came from, for a person deciding whether to trust it. */
  publisher: z.string().trim().min(1).max(120).default("local"),
  homepage: z.string().url().optional(),
}).strict();

export type AgentDefinition = z.infer<typeof agentSchema>;

/** One agent as the catalog serves it: the definition plus what this server resolved. */
export interface CatalogEntry {
  definition: AgentDefinition;
  /** Required plus the optional tools this build actually has. */
  activeTools: ReadonlySet<string>;
  /** Optional tools this build does not have, so the gap is visible rather than silent. */
  unavailableTools: readonly string[];
  /** True when the agent asked for write and the deployment allows it. */
  writesAllowed: boolean;
  /** Where a client points an MCP connection. */
  endpoint: string;
}

/**
 * The public shape of a listing, mirroring the model-listing convention
 * every OpenAI-compatible host already uses, so a client that can read one
 * can read this. Nothing here is a secret: no relay URL, no key, no operator
 * detail, only what someone needs to decide whether to connect.
 */
export function toPublicAgent(entry: CatalogEntry) {
  const { definition } = entry;
  return {
    id: definition.name,
    object: "agent" as const,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    version: definition.version,
    publisher: definition.publisher,
    ...(definition.homepage ? { homepage: definition.homepage } : {}),
    endpoint: entry.endpoint,
    scopes: entry.writesAllowed ? definition.scopes : definition.scopes.filter((scope) => scope !== "write"),
    tools: [...entry.activeTools].sort(),
    ...(entry.unavailableTools.length ? { unavailableTools: [...entry.unavailableTools] } : {}),
    instructions: definition.instructions,
  };
}
