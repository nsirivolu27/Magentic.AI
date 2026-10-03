import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_PIPELINE, PipelineError } from "./pipeline.js";
import { StorageError, type WorkspaceStore } from "./storage.js";

const entrySchema = z.object({
  id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(), requestId: z.string().uuid().optional(),
}).strict();
const directorySchema = z.object({
  version: z.literal(1), lastWorkspaceId: z.string(), mcpWorkspaceId: z.string(),
  workspaces: z.array(entrySchema).min(1).max(50),
}).strict();
type Directory = z.infer<typeof directorySchema>;
export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(80), requestId: z.string().uuid() }).strict();
export const openWorkspaceSchema = z.object({ workspaceId: z.string().min(1).max(100) }).strict();
export interface WorkspaceListing {
  workspaces: { id: string; name: string; createdAt: string }[];
  lastWorkspaceId: string; storage: "file"; directory: string;
}
export interface WorkspaceDirectory {
  list(): WorkspaceListing;
  has(id: string): boolean;
  create(raw: unknown): { workspaceId: string };
  open(raw: unknown): { workspaceId: string };
  mcpWorkspaceId: string;
}

// The caller holds the store's writer lock for this directory. Keeping the
// last opened workspace here is a startup preference, never a request's scope.
export function workspaceDirectory(directory: string, store: WorkspaceStore, initial: string): WorkspaceDirectory {
  const path = join(directory, "workspaces.json");
  let data: Directory;
  function save(next: Directory): void {
    const temp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(directorySchema.parse(next), null, 2) + "\n");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
    data = next;
  }
  let text: string | undefined;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageError("Workspace directory could not be read.", { cause: error }); }
  if (text !== undefined) {
    try { data = directorySchema.parse(JSON.parse(text)); }
    catch (error) { throw new StorageError("workspaces.json is invalid. The file was left untouched.", { cause: error }); }
    const ids = data.workspaces.map(entry => entry.id);
    const requests = data.workspaces.flatMap(entry => entry.requestId ? [entry.requestId] : []);
    if (new Set(ids).size !== ids.length || new Set(requests).size !== requests.length
      || !ids.includes(data.lastWorkspaceId) || !ids.includes(data.mcpWorkspaceId)) {
      throw new StorageError("workspaces.json contains inconsistent workspace references.");
    }
    for (const id of ids) {
      if (!store.read(id)) throw new StorageError(`Workspace ${id} is missing. Restore its file before opening Magentic.`);
    }
  } else {
    if (!store.read(initial)) store.commit(initial, { config: structuredClone(DEFAULT_PIPELINE), version: 1, runs: [] });
    save({ version: 1, lastWorkspaceId: initial, mcpWorkspaceId: initial,
      workspaces: [{ id: initial, name: initial.slice(0, 80), createdAt: new Date().toISOString() }] });
  }
  const has = (id: string) => data.workspaces.some(entry => entry.id === id);
  return {
    mcpWorkspaceId: data!.mcpWorkspaceId,
    has,
    list() { return { workspaces: data.workspaces.map(({ id, name, createdAt }) => ({ id, name, createdAt })), lastWorkspaceId: data.lastWorkspaceId, storage: "file", directory }; },
    create(raw) {
      const input = createWorkspaceSchema.parse(raw);
      const prior = data.workspaces.find(entry => entry.requestId === input.requestId);
      if (prior) {
        if (prior.name !== input.name) throw new PipelineError(409, "This create request was already used for a different workspace.");
        return { workspaceId: prior.id };
      }
      if (data.workspaces.length >= 50) throw new PipelineError(409, "This installation supports up to 50 workspaces.");
      if (data.workspaces.some(entry => entry.name.toLowerCase() === input.name.toLowerCase())) throw new PipelineError(409, "A workspace already uses that name.");
      const id = randomUUID();
      // Publish the entry only after its document exists. A failed catalog
      // write can leave an unlisted file, but cannot advertise missing data.
      store.commit(id, { config: structuredClone(DEFAULT_PIPELINE), version: 1, runs: [] });
      save({ ...data, lastWorkspaceId: id, workspaces: [...data.workspaces, { id, ...input, createdAt: new Date().toISOString() }] });
      return { workspaceId: id };
    },
    open(raw) {
      const { workspaceId } = openWorkspaceSchema.parse(raw);
      if (!has(workspaceId)) throw new PipelineError(404, "Workspace not found.");
      if (!store.read(workspaceId)) throw new StorageError(`Workspace ${workspaceId} is missing.`);
      if (data.lastWorkspaceId !== workspaceId) save({ ...data, lastWorkspaceId: workspaceId });
      return { workspaceId };
    },
  };
}
