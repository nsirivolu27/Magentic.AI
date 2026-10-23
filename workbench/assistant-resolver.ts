import { PipelineError, type PipelineGuards } from "./pipeline.js";
import { StudioError, type ModelStudio } from "./studio/engine.js";
import { StudioStorageError } from "./studio/store.js";

/**
 * How a workflow stage gets its assistant.
 *
 * A stage names an assistant by id. When the stage runs, the assistant is
 * resolved through the Model Studio, which applies the same rules as chat:
 * the profile must be active, its release approved and still validly
 * signed. Nothing here relaxes those rules; it only translates the answer
 * into what the pipeline and bot runtime need.
 */
export interface AssistantBinding {
  id: string;
  name: string;
  /** The base model the release was trained from. */
  model: string;
  instructions: string;
  /** "v2 · Helpdesk assistant": what a person reads in the timeline. */
  release: string;
}
export type AssistantResolver = (workspace: string, assistantId: string) => AssistantBinding;

/** Resolves through the studio. A refusal becomes a pipeline error with the studio's own words. */
export function studioAssistants(studio: ModelStudio): AssistantResolver {
  return (workspace, assistantId) => {
    try {
      const resolved = studio.resolveProfile(workspace, assistantId);
      return { id: resolved.profile.id, name: resolved.profile.name, model: resolved.config.baseModel,
        instructions: resolved.profile.instructions, release: `v${resolved.release.version} · ${resolved.project.name}` };
    } catch (error) {
      if (error instanceof StudioError || error instanceof StudioStorageError) throw new PipelineError(409, error.message);
      throw error;
    }
  };
}

/** The pipeline guard form of the same check: a reason, or nothing when the assistant can work. */
export function assistantGuards(resolve: AssistantResolver): PipelineGuards {
  return { assistant: (workspace, assistantId) => {
    try { resolve(workspace, assistantId); return undefined; }
    catch (error) { return error instanceof PipelineError ? error.message : "The assistant could not be checked."; }
  } };
}

/** One assistant as a standalone client sees it: usable or not, and why. */
export interface AssistantListing {
  id: string;
  name: string;
  project: string;
  projectId: string;
  release: string;
  usable: boolean;
  /** Why it cannot work right now. Empty when usable. */
  reason: string;
}
export interface AssistantDirectory {
  list(workspace: string): AssistantListing[];
  /** The binding for one usable assistant. Throws a PipelineError when it cannot work. */
  get(workspace: string, assistantId: string): AssistantBinding;
}

/**
 * What the editor extension and other standalone clients may read: which
 * assistants exist and which can work today, plus the binding for one that
 * can. The same resolver decides usability everywhere, so a client can never
 * be handed an assistant that chat would refuse.
 */
export function assistantDirectory(studio: ModelStudio): AssistantDirectory {
  const resolve = studioAssistants(studio);
  return {
    list(workspace) {
      const snapshot = studio.snapshot(workspace);
      return snapshot.profiles.map((profile) => {
        const release = snapshot.releases.find((item) => item.id === profile.releaseId);
        const project = snapshot.projects.find((item) => item.id === release?.projectId);
        const base = { id: profile.id, name: profile.name, project: project?.name ?? "", projectId: project?.id ?? "", release: release ? `v${release.version}` : "missing" };
        try { resolve(workspace, profile.id); return { ...base, usable: true, reason: "" }; }
        catch (error) { return { ...base, usable: false, reason: error instanceof PipelineError ? error.message : "The assistant could not be checked." }; }
      });
    },
    get: resolve,
  };
}
