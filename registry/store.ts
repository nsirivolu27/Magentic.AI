import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordSchema, type RegistryRecord, type Status } from "./record.js";

/**
 * Where registry records live.
 *
 * One interface, two implementations on purpose. A file store needs no
 * infrastructure, which keeps a self-hosted instance and a laptop working
 * exactly as they do today. A DynamoDB store is the same four methods when
 * this deploys. Nothing above this file knows which one it has, so the
 * choice stays a deployment decision rather than an architectural one.
 *
 * The interface is deliberately small. It reads and writes whole records and
 * does not query, because the only question the serving path asks is "every
 * approved record in this workspace" and a catalog is small enough to filter
 * in memory. A richer query surface can come when something needs it.
 */
export interface RegistryStore {
  /** Every record in one workspace, any status. */
  list(workspaceId: string): Promise<RegistryRecord[]>;
  /** One record, or undefined when the workspace has no agent by that name. */
  get(workspaceId: string, name: string): Promise<RegistryRecord | undefined>;
  /** Create or replace. The caller owns status transitions; the store just persists. */
  put(record: RegistryRecord): Promise<void>;
  /** Remove a record entirely. Retiring is a status, not a delete; this is for cleanup. */
  remove(workspaceId: string, name: string): Promise<void>;
}

/** Records held in memory. For tests and for a process that should persist nothing. */
export function memoryStore(seed: readonly RegistryRecord[] = []): RegistryStore {
  const records = new Map<string, RegistryRecord>();
  for (const record of seed) records.set(key(record.workspaceId, record.definition.name), record);

  return {
    async list(workspaceId) {
      return [...records.values()]
        .filter((record) => record.workspaceId === workspaceId)
        .sort(byName);
    },
    async get(workspaceId, name) {
      return records.get(key(workspaceId, name));
    },
    async put(record) {
      records.set(key(record.workspaceId, record.definition.name), record);
    },
    async remove(workspaceId, name) {
      records.delete(key(workspaceId, name));
    },
  };
}

/**
 * Records as JSON files under <directory>/<workspaceId>/<name>.json.
 *
 * A workspace is a directory so that listing one never reads another's
 * files. That is not security, since anything that can read one path can
 * read the sibling, but it does mean a bug in a filter cannot leak across
 * workspaces the way a single flat file would allow.
 */
export function fileStore(directory: string): RegistryStore {
  return {
    async list(workspaceId) {
      const folder = join(directory, safeSegment(workspaceId));
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        // A workspace with no records yet is empty, not broken.
        return [];
      }
      const records: RegistryRecord[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        records.push(readRecord(join(folder, name)));
      }
      return records.sort(byName);
    },

    async get(workspaceId, name) {
      const path = join(directory, safeSegment(workspaceId), `${safeSegment(name)}.json`);
      try {
        return readRecord(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    async put(record) {
      const folder = join(directory, safeSegment(record.workspaceId));
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `${safeSegment(record.definition.name)}.json`);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },

    async remove(workspaceId, name) {
      const path = join(directory, safeSegment(workspaceId), `${safeSegment(name)}.json`);
      try {
        unlinkSync(path);
      } catch (error) {
        // Removing what is not there is the state the caller wanted.
        if (!isMissing(error)) throw error;
      }
    },
  };
}

function readRecord(path: string): RegistryRecord {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Registry record ${path} is invalid. ${detail}`);
  }
  return parsed.data;
}

/**
 * A workspace id or agent name becomes one path segment, so a crafted value
 * cannot climb out of the directory. Both are already constrained upstream;
 * this is the second check that means a change upstream cannot turn into a
 * path traversal down here.
 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`"${value}" is not usable as a registry path segment.`);
  }
  return cleaned;
}

function key(workspaceId: string, name: string): string {
  return `${workspaceId}\u0000${name}`;
}

function byName(left: RegistryRecord, right: RegistryRecord): number {
  return left.definition.name.localeCompare(right.definition.name);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/** Status values a record may move to from where it is now. */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  draft: ["review"],
  review: ["draft", "approved"],
  approved: ["retired"],
  retired: [],
};
