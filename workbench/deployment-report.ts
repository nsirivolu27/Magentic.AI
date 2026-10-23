import type { PipelineSnapshot } from "./pipeline.js";
import type { ModelStudio } from "./studio/engine.js";
import { canonical, sha256 } from "./studio/schema.js";

export interface DeploymentStage {
  id: string; name: string; execution: "manual" | "assistant" | "repository";
  model: string; approval: boolean; assistantId?: string;
  release?: { id: string; version: number; hash: string; artifact: "development" | "trained" };
  blockers: string[];
}
export interface DeploymentReport {
  schemaVersion: 1; workspaceId: string; checkedAt: string;
  mode: "company" | "local" | "demo";
  status: "blocked" | "needs-validation";
  workflow?: { name: string; version: number; hash: string; storage: "memory" | "file" };
  requiredApprovals: number; stages: DeploymentStage[]; blockers: string[]; remainingChecks: string[];
}
export interface DeploymentInputs {
  workspaceId: string; mode: DeploymentReport["mode"]; requiredApprovals: number;
  pipeline?: PipelineSnapshot; studio?: Pick<ModelStudio, "resolveProfile">;
  scheduler: boolean; modelConfigured: boolean; repositoryWorker: boolean; repositoryAttached: boolean;
}

/** This describes the current workflow, not frozen runs or an authorization to execute it. */
export function deploymentReport(input: DeploymentInputs, checkedAt = new Date().toISOString()): DeploymentReport {
  const { pipeline } = input;
  const blockers: string[] = pipeline ? [] : ["Workflow storage is unavailable."];
  const stages: DeploymentStage[] = (pipeline?.config.stages ?? []).map(stage => {
    const execution = stage.assistantId ? "assistant" : stage.bot && stage.bot.kind !== "manual" ? "repository" : "manual";
    const result: DeploymentStage = { id: stage.id, name: stage.name, execution, model: stage.model,
      approval: stage.approval, blockers: [], ...(stage.assistantId ? { assistantId: stage.assistantId } : {}) };
    if (execution === "assistant") {
      if (!input.scheduler) result.blockers.push("The assistant scheduler is unavailable.");
      try {
        if (!input.studio) throw new Error("Studio unavailable");
        const resolved = input.studio.resolveProfile(input.workspaceId, stage.assistantId!);
        // Resolve at inspection time so retirement and lost signatures cannot remain green in an export.
        result.model = resolved.config.baseModel;
        result.release = { id: resolved.release.id, version: resolved.release.version,
          hash: resolved.release.contentHash, artifact: resolved.job.artifact!.label };
      } catch {
        result.blockers.push("The assistant release could not be verified. Check its approvals and active status.");
      }
    }
    if (execution === "repository") {
      if (input.mode === "company" || !input.repositoryWorker) result.blockers.push("Repository execution needs an isolated worker; this workspace cannot run it.");
      else if (!input.repositoryAttached) result.blockers.push("Attach a repository before running this stage.");
    }
    if (execution !== "manual" && !input.modelConfigured) result.blockers.push("The workflow model connection is not configured.");
    return result;
  });
  const remainingChecks = [
    "Run a supervised smoke test with the actual model, references and tools. No provider was contacted by this check.",
    "Confirm independent reviewers and test the handoff gate. Team coverage has not been verified.",
    "Review data access and retention before using company material.",
  ];
  if (pipeline?.storage === "memory") remainingChecks.push("This workflow is in memory. Set up persistent storage before relying on it after a restart.");
  if (stages.some(stage => stage.release?.artifact === "development")) remainingChecks.push("Development artifacts have no trained weights; their release approval is not evidence of fine-tuned model quality.");
  return { schemaVersion: 1, workspaceId: input.workspaceId, checkedAt, mode: input.mode,
    status: blockers.length || stages.some(stage => stage.blockers.length) ? "blocked" : "needs-validation",
    ...(pipeline ? { workflow: { name: pipeline.config.name, version: pipeline.version,
      hash: sha256(canonical(pipeline.config)), storage: pipeline.storage } } : {}),
    requiredApprovals: input.requiredApprovals, stages, blockers, remainingChecks };
}
