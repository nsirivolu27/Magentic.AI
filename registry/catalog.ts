import { resolve as resolveEntry } from "../catalog/load.js";
import type { Catalog } from "../catalog/load.js";
import { magenticToolNames } from "../mcp.js";
import type { CatalogEntry } from "../catalog/schema.js";
import { isServable, type RegistryRecord } from "./record.js";
import type { RegistryStore } from "./store.js";

/**
 * Building a served catalog out of the registry.
 *
 * This is the gate. Everything a workspace has authored lives in the store;
 * only what survives isServable reaches a Catalog, and a Catalog is the only
 * thing the serving path knows how to read. A draft is therefore not hidden
 * by a filter in a route handler somewhere, it simply never becomes an entry
 * anyone could serve.
 *
 * The entries themselves come from the same resolve() the file catalog uses,
 * so an agent behaves identically whichever loader produced it. That was the
 * reason resolve() was exported without a registry to use it yet.
 */

export interface RegistryCatalogOptions {
  /** Whether this deployment exposes write tools at all. The ceiling over every agent. */
  allowWrites: boolean;
  /** Signatures needed before a record is served. Two is the realistic federal default. */
  requiredApprovals?: number;
  /** Tool names this build registers. Defaults to reading them from the build. */
  known?: readonly string[];
}

/** Why a record the workspace holds is not being served. Empty when everything is live. */
export interface Withheld {
  name: string;
  reason: "not-approved" | "approvals-stale" | "missing-tools";
  detail: string;
}

export interface RegistryCatalog extends Catalog {
  withheld: readonly Withheld[];
}

export async function loadRegistryCatalog(
  store: RegistryStore,
  workspaceId: string,
  options: RegistryCatalogOptions,
): Promise<RegistryCatalog> {
  const required = options.requiredApprovals ?? 1;
  const known = new Set(options.known ?? magenticToolNames());
  const records = await store.list(workspaceId);

  const entries: CatalogEntry[] = [];
  const byName = new Map<string, CatalogEntry>();
  const withheld: Withheld[] = [];

  for (const record of records) {
    const verdict = withholdReason(record, known, required);
    if (verdict) {
      withheld.push(verdict);
      continue;
    }
    const entry = resolveEntry(record.definition, known, options.allowWrites);
    entries.push(entry);
    byName.set(record.definition.name, entry);
  }

  entries.sort((left, right) => left.definition.name.localeCompare(right.definition.name));
  return { entries, byName, withheld };
}

/**
 * A missing required tool withholds rather than throws, which is the one
 * place the registry deliberately differs from the file catalog.
 *
 * A bad file is a deployment someone is about to make and should fail at
 * boot. A bad record is one row among many that a person authored while the
 * server was already up, and stopping the server because of it would let one
 * workspace's mistake take down every other workspace.
 */
function withholdReason(
  record: RegistryRecord,
  known: ReadonlySet<string>,
  required: number,
): Withheld | undefined {
  const name = record.definition.name;

  const missing = record.definition.tools.filter((tool) => !known.has(tool));
  if (missing.length) {
    return {
      name,
      reason: "missing-tools",
      detail: `This server does not register: ${missing.join(", ")}.`,
    };
  }

  if (record.status !== "approved") {
    return { name, reason: "not-approved", detail: `Status is ${record.status}.` };
  }

  if (!isServable(record, required)) {
    return {
      name,
      reason: "approvals-stale",
      detail: `Approved, but the definition changed after signing, or fewer than ${required} signature(s) match it.`,
    };
  }

  return undefined;
}
