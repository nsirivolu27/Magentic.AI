import type { StudioSnapshot } from "./studio/engine.js";
import type { ChatbotProfile, ModelProject, ModelRelease } from "./studio/schema.js";
import { candidateOf, datasetsOf, evaluationsOf, jobsOf, latestApprovedRelease, phaseReport, plural, releasesOf, type Phase, type PhaseReport } from "./studio-model.js";

/**
 * A project as a chain of connected things.
 *
 * Recipe → Dataset → Candidate → Evaluation → Release → Assistant → Tools.
 * Each node is the object that exists at that point (a dataset, a candidate
 * model, a signed release), not the job that produced it. Its state says
 * whether the link to the next node holds. The pages draw this chain and
 * open a node's panel when it is clicked, so the graph is the navigation.
 * Browser code: no Node imports.
 */

export type NodeState = "linked" | "active" | "pending" | "blocked" | "broken";
export const NODE_STATE_LABEL: Record<NodeState, string> = { linked: "Connected", active: "In progress", pending: "Not yet", blocked: "Blocked", broken: "Broken" };

export type FlowNodeId = "recipe" | "dataset" | "candidate" | "evaluation" | "release" | "assistant" | "tools";
export interface FlowNode {
  id: FlowNodeId;
  label: string;
  /** The one thing worth reading: a name, a version, a hash, a score. */
  value: string;
  /** A second line, short. */
  note: string;
  state: NodeState;
  href: string;
  /** The project phase this node's panel lives on. Tools have none. */
  phase?: Phase;
}
export interface ProjectFlow { nodes: FlowNode[]; report: PhaseReport }

/** The read only tools every assistant gets. Instructions cannot add to this list. */
export const TOOL_NAMES = ["list_approved_agents", "get_approved_agent", "get_workspace_policy"];

export const NODE_OF_PHASE: Record<Phase, FlowNodeId> = { define: "recipe", data: "dataset", train: "candidate", evaluate: "evaluation", approve: "release", use: "assistant" };

const shortHash = (hash: string) => hash.slice(0, 10);

export function projectFlow(studio: StudioSnapshot, project: ModelProject): ProjectFlow {
  const report = phaseReport(studio, project);
  const at = (phase: Phase) => `#/studio/${project.id}/${phase}`;
  const recipe = studio.recipes.find((item) => item.id === project.recipeId);

  const datasets = datasetsOf(studio, project);
  const dataset = [...datasets].reverse().find((item) => item.status === "valid") ?? datasets.at(-1);
  const datasetNode: FlowNode = { id: "dataset", label: "Dataset", phase: "data", href: at("data"),
    ...(!dataset ? { value: "No dataset", note: "Add examples", state: "pending" as const }
      : dataset.status === "valid" ? { value: dataset.name, note: plural(dataset.validation?.records ?? 0, "record"), state: "linked" as const }
      : dataset.status === "rejected" ? { value: dataset.name, note: `${dataset.validation?.rejected ?? 0} rejected`, state: "broken" as const }
      : { value: dataset.name, note: "Not validated", state: "pending" as const }) };

  const jobs = jobsOf(studio, project);
  const candidate = candidateOf(studio, project);
  const running = [...jobs].reverse().find((job) => job.status === "running");
  const lastJob = jobs.at(-1);
  const candidateNode: FlowNode = { id: "candidate", label: "Candidate", phase: "train", href: at("train"),
    ...(running ? { value: "Training", note: `${studio.providers.find((item) => item.id === running.provider)?.label ?? running.provider}`, state: "active" as const }
      : candidate?.artifact ? { value: shortHash(candidate.artifact.hash), note: `${candidate.artifact.label} artifact`, state: "linked" as const }
      : lastJob ? { value: "No candidate", note: `Last run ${lastJob.status}`, state: "broken" as const }
      : datasetNode.state === "linked" ? { value: "No candidate", note: "Ready to train", state: "pending" as const }
      : { value: "No candidate", note: "Needs dataset", state: "blocked" as const }) };

  const evaluations = evaluationsOf(studio, project);
  const evaluation = evaluations.at(-1);
  const evaluated = candidate ? evaluations.some((item) => item.jobId === candidate.id) : false;
  const evaluationNode: FlowNode = { id: "evaluation", label: "Evaluation", phase: "evaluate", href: at("evaluate"),
    ...(candidate && evaluated && evaluation ? (evaluation.passed
        ? { value: "Passed", note: `${evaluation.comparison.filter((row) => row.passed).length} of ${evaluation.comparison.length} metrics`, state: "linked" as const }
        : { value: "Failed", note: `${evaluation.comparison.filter((row) => !row.passed).length} of ${evaluation.comparison.length} metrics`, state: "broken" as const })
      : candidate ? { value: "Not run", note: "Ready to evaluate", state: "pending" as const }
      : { value: "Not run", note: "Needs candidate", state: "blocked" as const }) };

  const releases = releasesOf(studio, project);
  const approved = latestApprovedRelease(studio, project);
  const pending = [...releases].reverse().find((item) => item.status === "pending_approval");
  const lastRelease = releases.at(-1);
  const release = pending ?? approved ?? lastRelease;
  const releaseNode: FlowNode = { id: "release", label: "Release", phase: "approve", href: release ? `#/approvals/${release.id}` : at("approve"),
    ...(approved ? { value: `v${approved.version}`, note: `${approved.approvals.length} of ${approved.requiredApprovals} signed`, state: "linked" as const }
      : pending ? { value: `v${pending.version}`, note: `${pending.approvals.length} of ${pending.requiredApprovals} signed`, state: "active" as const }
      : lastRelease?.status === "rejected" ? { value: `v${lastRelease.version}`, note: "Rejected", state: "broken" as const }
      : lastRelease?.status === "retired" ? { value: `v${lastRelease.version}`, note: "Retired", state: "blocked" as const }
      : evaluationNode.state === "linked" ? { value: "No release", note: "Ready to request", state: "pending" as const }
      : { value: "No release", note: "Needs evaluation", state: "blocked" as const }) };

  const profiles = studio.profiles.filter((profile) => releases.some((item) => item.id === profile.releaseId));
  const live = profiles.find((profile) => profile.status === "active" && approved && profile.releaseId === approved.id)
    ?? profiles.find((profile) => profile.status === "active" && releases.some((item) => item.id === profile.releaseId && item.status === "approved"));
  const assistantNode: FlowNode = { id: "assistant", label: "Assistant", phase: "use", href: live ? `#/assistants/${live.id}` : at("use"),
    ...(live ? { value: live.name, note: profiles.length > 1 ? plural(profiles.filter((profile) => profile.status === "active").length, "active assistant") : "Active", state: "linked" as const }
      : approved ? { value: "Not assigned", note: "Ready to assign", state: "pending" as const }
      : profiles.length ? { value: profiles[profiles.length - 1]!.name, note: "Disabled", state: "blocked" as const }
      : { value: "Not assigned", note: "Needs release", state: "blocked" as const }) };

  const toolsNode: FlowNode = { id: "tools", label: "Tools", href: live ? `#/assistants/${live.id}` : at("use"),
    value: `${TOOL_NAMES.length} read only`, note: "Workspace MCP", state: live ? "linked" : "pending" };

  const recipeNode: FlowNode = { id: "recipe", label: "Recipe", phase: "define", href: at("define"), value: recipe?.title ?? project.recipeId, note: recipe?.baseModel ?? "", state: "linked" };

  return { report, nodes: [recipeNode, datasetNode, candidateNode, evaluationNode, releaseNode, assistantNode, toolsNode] };
}

/** The short chain behind one assistant: the release it answers with, itself, and its tools. */
export function assistantFlow(studio: StudioSnapshot, profile: ChatbotProfile, release: ModelRelease | undefined): FlowNode[] {
  const project = studio.projects.find((item) => item.id === release?.projectId);
  const usable = profile.status === "active" && release?.status === "approved";
  const releaseNode: FlowNode = { id: "release", label: "Release", href: release ? `#/approvals/${release.id}` : "#/approvals",
    ...(!release ? { value: "Missing", note: "No release", state: "broken" as const }
      : release.status === "approved" ? { value: `v${release.version}`, note: project?.name ?? "", state: "linked" as const }
      : { value: `v${release.version}`, note: release.status === "retired" ? "Retired" : release.status === "rejected" ? "Rejected" : "Pending approval", state: "broken" as const }) };
  const assistantNode: FlowNode = { id: "assistant", label: "Assistant", href: `#/assistants/${profile.id}`, value: profile.name,
    note: usable ? "Answers with the release" : profile.status === "disabled" ? "Disabled" : "Not usable", state: usable ? "linked" : "blocked" };
  const toolsNode: FlowNode = { id: "tools", label: "Tools", href: `#/assistants/${profile.id}`, value: `${TOOL_NAMES.length} read only`, note: "Workspace MCP", state: usable ? "linked" : "pending" };
  return [releaseNode, assistantNode, toolsNode];
}

/** One sentence for a project row: where the chain currently stops. */
export function flowSummary(flow: ProjectFlow): { tone: "ok" | "warn" | "bad" | "accent" | "neutral"; text: string } {
  const broken = flow.nodes.find((node) => node.state === "broken");
  if (broken) return { tone: "bad", text: `${broken.label} ${broken.note.toLowerCase()}` };
  const active = flow.nodes.find((node) => node.state === "active");
  if (active) return { tone: "accent", text: active.id === "candidate" ? "Training" : `Release ${active.note}` };
  if (flow.nodes.every((node) => node.state === "linked")) return { tone: "ok", text: "Connected end to end" };
  const next = flow.nodes.find((node) => node.state === "pending" || node.state === "blocked");
  return next ? { tone: next.state === "blocked" ? "warn" : "neutral", text: `Next: ${next.label.toLowerCase()}` } : { tone: "neutral", text: "" };
}
