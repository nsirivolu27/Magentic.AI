import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerOptions } from "../mcp.js";
import { loadCatalog, type Catalog } from "./load.js";
import type { CatalogEntry } from "./schema.js";
import { setting } from "../env.js";

/**
 * Choosing one agent, for the case where there is no server at all.
 *
 * Hosting serves every agent at once and lets the URL pick. Running the
 * adapter as a subprocess of one desktop client has no URL, so the choice
 * has to be made before the process starts. MAGENTIC_AGENT is that choice, and
 * it is what makes an agent usable from a laptop without deploying anything.
 */

/**
 * Where the agent definitions are, when nobody said.
 *
 * Resolved from the running file rather than the working directory, because
 * a desktop MCP client spawns this process with its cwd set to whatever it
 * likes, usually not the repository. A relative default would work when run
 * by hand and fail from the client, which is the worse of the two failures
 * because it looks like the configuration is wrong.
 */
export function defaultAgentsDirectory(moduleUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const declared = setting("MAGENTIC_AGENTS_DIR", env)?.trim();
  if (declared) return isAbsolute(declared) ? declared : resolvePath(process.cwd(), declared);
  // dist/stdio.mjs and dist/http-main.mjs both sit one level under the
  // repository root, next to agents/.
  return resolvePath(dirname(fileURLToPath(moduleUrl)), "..", "agents");
}

export interface SelectedAgent {
  entry: CatalogEntry;
  options: McpServerOptions;
}

/**
 * Apply an agent to the server options, or return undefined when none was
 * asked for. The scope ceiling is re-applied here rather than trusted from
 * the catalog, so the deployment's own setting wins even if the catalog was
 * built with a different one.
 */
export function selectAgent(
  catalog: Catalog,
  name: string,
  base: McpServerOptions,
): SelectedAgent {
  const entry = catalog.byName.get(name);
  if (!entry) {
    const known = catalog.entries.map((item) => item.definition.name).join(", ") || "none";
    throw new Error(`No agent named "${name}". Available: ${known}.`);
  }
  return {
    entry,
    options: {
      ...base,
      allowWrites: (base.allowWrites ?? true) && entry.definition.scopes.includes("write"),
      tools: entry.activeTools,
      instructions: entry.definition.instructions,
    },
  };
}

/** Read the catalog for a process that may not need one. */
export function catalogFor(moduleUrl: string, allowWrites: boolean, env: NodeJS.ProcessEnv = process.env): Catalog | undefined {
  const directory = defaultAgentsDirectory(moduleUrl, env);
  try {
    return loadCatalog({ directory, allowWrites });
  } catch (error) {
    // A directory that was explicitly named, or an agent that was explicitly
    // asked for, makes a load failure fatal. Neither of those means this is
    // a deployment that simply predates agents.
    if (setting("MAGENTIC_AGENTS_DIR", env) || setting("MAGENTIC_AGENT", env)) throw error;
    return undefined;
  }
}
