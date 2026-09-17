import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lnkzToolNames, WRITE_TOOLS } from "../mcp.js";
import { agentSchema, type AgentDefinition, type CatalogEntry } from "./schema.js";

/**
 * Loading the agents a server hosts.
 *
 * Definitions are files, read once at boot and held in memory. Files because
 * a definition is configuration that should be reviewable in a pull request
 * before it is served to anyone, and because a self-hosted instance should
 * not need a database to publish a catalog. When a registry exists it
 * becomes a second loader producing the same records, which is why nothing
 * below assumes a filesystem past this function.
 *
 * Everything that can be wrong is wrong at boot. A definition that names a
 * tool this build does not register, two definitions claiming one name, a
 * file that is not valid JSON: each of those stops the server with the file
 * named. A catalog that half loaded is worse than one that did not, because
 * the failure surfaces later as an agent missing the tool it was chosen for.
 */

export interface Catalog {
  entries: readonly CatalogEntry[];
  byName: ReadonlyMap<string, CatalogEntry>;
}

export interface LoadOptions {
  /** Directory of *.json definitions. */
  directory: string;
  /** Whether this deployment exposes write tools at all. The ceiling over every agent. */
  allowWrites: boolean;
  /** Tool names this build registers. Defaults to reading them from the build. */
  known?: readonly string[];
}

export function loadCatalog(options: LoadOptions): Catalog {
  const files = listDefinitionFiles(options.directory);
  const known = new Set(options.known ?? lnkzToolNames());
  const entries: CatalogEntry[] = [];
  const byName = new Map<string, CatalogEntry>();

  for (const file of files) {
    const definition = parseDefinition(file);
    if (byName.has(definition.name)) {
      throw new Error(`Two agent definitions claim the name "${definition.name}"; the second is ${file}.`);
    }

    const missing = definition.tools.filter((tool) => !known.has(tool));
    if (missing.length) {
      throw new Error(
        `Agent "${definition.name}" in ${file} requires tools this server does not register: ${missing.join(", ")}. `
        + "Move them to optionalTools if the agent should still load without them.",
      );
    }

    const entry = resolve(definition, known, options.allowWrites);
    entries.push(entry);
    byName.set(definition.name, entry);
  }

  entries.sort((left, right) => left.definition.name.localeCompare(right.definition.name));
  return { entries, byName };
}

/** Build one entry without touching a disk. The registry loader will use this too. */
export function resolve(
  definition: AgentDefinition,
  known: ReadonlySet<string>,
  allowWrites: boolean,
): CatalogEntry {
  const optionalPresent = definition.optionalTools.filter((tool) => known.has(tool));
  const unavailableTools = definition.optionalTools.filter((tool) => !known.has(tool));
  const writesAllowed = allowWrites && definition.scopes.includes("write");
  // The ceiling is applied to the resolved tool list, not only to the scope
  // label, so the catalog promises what the endpoint will actually register.
  // A listing that says sixteen tools where eleven appear is a listing
  // someone plans around and then debugs.
  const declared = [...definition.tools, ...optionalPresent];
  const activeTools = new Set(writesAllowed ? declared : declared.filter((tool) => !WRITE_TOOLS.has(tool)));
  return {
    definition,
    activeTools,
    unavailableTools,
    writesAllowed,
    endpoint: `/mcp/${definition.name}`,
  };
}

function listDefinitionFiles(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (cause) {
    throw new Error(`Agent directory ${directory} could not be read.`, { cause });
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function parseDefinition(file: string): AgentDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`Agent definition ${file} is not valid JSON.`, { cause });
  }
  const parsed = agentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Agent definition ${file} is invalid. ${detail}`);
  }
  return parsed.data;
}
