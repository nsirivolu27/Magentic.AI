import type { Role } from "../registry/roles.js";
import type { PipelineEngine } from "./pipeline.js";
import { zenfluenceCommandSchema, zenfluenceMaterial, ZenfluenceError, type ZenfluenceDirectory } from "./zenfluence.js";

export async function zenfluenceCommand(directory: ZenfluenceDirectory, pipelines: PipelineEngine | undefined,
  identity: { workspaceId: string; actor: string; roles: readonly Role[] }, raw: unknown) {
  const input = zenfluenceCommandSchema.parse(raw);
  const connection = directory(identity.workspaceId);
  if (!connection) throw new ZenfluenceError(404, "Zenfluence is not configured for this company.");
  if (input.action === "read") return connection.read(input.source);
  if (!pipelines) throw new ZenfluenceError(404, "Workflows are unavailable.");
  const run = pipelines.snapshot(identity.workspaceId).runs.find(item => item.id === input.runId);
  if (!run) throw new ZenfluenceError(404, "Run not found in this workspace.");
  if (!identity.roles.includes("admin") && !(identity.roles.includes("author") && run.owner === identity.actor)) throw new ZenfluenceError(403, "The workflow owner or an admin must attach references.");
  if (run.revision !== input.expectedRevision) throw new ZenfluenceError(409, "The workflow changed. Refresh before attaching.");
  if (run.status === "complete" || run.status === "cancelled") throw new ZenfluenceError(409, "This workflow is closed.");
  const source = await connection.read(input.source);
  if (source.contentHash !== input.expectedSourceHash) throw new ZenfluenceError(409, "The source changed. Read and review it again.");
  if (run.materials?.some(item => item.url === source.url)) throw new ZenfluenceError(409, "This source is already attached. Manage references in the workflow.");
  // The pipeline checks the revision again after the remote read, before committing.
  pipelines.execute(identity.workspaceId, identity.actor, identity.roles, { action: "materials", runId: run.id,
    expectedRevision: input.expectedRevision!, materials: [...run.materials ?? [], zenfluenceMaterial(source)] }, run.requiredApprovals);
  return { attached: true, runId: run.id, contentHash: source.contentHash };
}
