import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { setting } from "../env.js";
import { catalogFor } from "../catalog/select.js";
import type { Catalog } from "../catalog/load.js";
import { loadRegistryCatalog, type Withheld } from "./catalog.js";
import { fileStore } from "./store.js";
import { DEFAULT_WORKFLOW, loadWorkflow, type Workflow } from "./workflow.js";

/**
 * Which catalog this process serves, and where it came from.
 *
 * Personal mode reads agent definitions from files, which is every
 * deployment that exists today and stays the default. Workspace mode reads
 * them from the registry, where only an approved record becomes servable.
 *
 * One setting decides, and nothing else in the serving path changes: both
 * roads produce a Catalog, and http.ts has always taken a Catalog. That is
 * why this is a loader swap rather than a second serving path, and why
 * personal mode cannot be broken by workspace work.
 */

export type CatalogMode = "files" | "workspace";

export interface ResolvedCatalog {
  mode: CatalogMode;
  catalog: Catalog | undefined;
  /** Where the definitions came from, for the startup line. */
  origin: string;
  /** Records the registry holds but will not serve. Always empty in files mode. */
  withheld: readonly Withheld[];
  /** The workspace being served, in workspace mode. */
  workspaceId?: string;
  workflow?: Workflow;
}

/** Workspace mode is on when a registry directory is named. */
export function registryDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const declared = setting("MAGENTIC_REGISTRY_DIR", env)?.trim();
  if (!declared) return undefined;
  return isAbsolute(declared) ? declared : resolvePath(process.cwd(), declared);
}

/**
 * Signatures a record needs before it is served.
 *
 * Two is the realistic federal default because one person approving their
 * own work is not review. One is the default here only because turning a
 * deployment on should not require explaining a second approver first.
 */
export function requiredApprovals(env: NodeJS.ProcessEnv = process.env): number {
  const declared = Number(setting("MAGENTIC_REQUIRED_APPROVALS", env) ?? "1");
  if (!Number.isInteger(declared) || declared < 1 || declared > 10) {
    throw new Error("MAGENTIC_REQUIRED_APPROVALS must be a whole number from 1 to 10.");
  }
  return declared;
}

export function resolveWorkflow(env: NodeJS.ProcessEnv = process.env): Workflow {
  const declared = setting("MAGENTIC_WORKFLOW_FILE", env)?.trim();
  if (!declared) {
    const count = requiredApprovals(env);
    return count === DEFAULT_WORKFLOW.requiredApprovals
      ? DEFAULT_WORKFLOW
      : loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: count });
  }

  const path = resolvePath(process.cwd(), declared);
  try {
    return loadWorkflow(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`MAGENTIC_WORKFLOW_FILE ${path}: ${detail}`, { cause: error });
  }
}

export async function resolveCatalog(
  moduleUrl: string,
  allowWrites: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCatalog> {
  const directory = registryDirectory(env);
  if (!directory) {
    // An explicitly configured policy must fail at startup even in file
    // mode. Legacy registry settings stay unused in this mode as before.
    if (setting("MAGENTIC_WORKFLOW_FILE", env)?.trim()) resolveWorkflow(env);
    const catalog = catalogFor(moduleUrl, allowWrites, env);
    return { mode: "files", catalog, origin: "agent definition files", withheld: [] };
  }

  const workspaceId = setting("MAGENTIC_WORKSPACE", env)?.trim();
  if (!workspaceId) {
    // Refused rather than defaulted. A registry with no workspace named has
    // no safe guess: serving every workspace's agents at one endpoint is the
    // one outcome the boundary exists to prevent.
    throw new Error("MAGENTIC_REGISTRY_DIR is set, so MAGENTIC_WORKSPACE must name the workspace this server hosts.");
  }

  const workflow = resolveWorkflow(env);
  const catalog = await loadRegistryCatalog(fileStore(directory), workspaceId, {
    allowWrites,
    workflow,
  });

  return {
    mode: "workspace",
    catalog,
    origin: `registry ${directory}`,
    withheld: catalog.withheld,
    workspaceId,
    workflow,
  };
}
