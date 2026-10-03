import { BOT_PROFILE_KINDS, DEFAULT_BOT_POLICY, type BotHandoff, type BotProfile } from "./bot-schema.js";
import type { PipelineConfig } from "./pipeline.js";

export interface AgentProfile {
  name: string;
  purpose: string;
  instructions: string;
  sections: readonly string[];
}

export const BOT_PROFILES: Record<BotProfile, AgentProfile> = {
  requirements: {
    name: "Requirements agent",
    purpose: "Turn the brief into a testable scope.",
    instructions: "Identify the user, problem and constraints. Separate confirmed requirements from assumptions. Write observable acceptance criteria and exclusions. Put questions that prevent safe implementation in blockers; do not invent their answers.",
    sections: ["Problem and users", "Scope and exclusions", "Acceptance criteria", "Assumptions and questions"],
  },
  planning: {
    name: "Planning agent",
    purpose: "Break the approved scope into ordered work.",
    instructions: "Use the requirements handoff and inspect relevant repository structure. Order concrete tasks, name dependencies and map tasks to acceptance criteria. Identify risks and a practical validation sequence. Avoid introducing a new stack without a stated need.",
    sections: ["Implementation steps", "Dependencies", "Risks", "Validation plan"],
  },
  architecture: {
    name: "Architecture agent",
    purpose: "Define interfaces and decisions before implementation.",
    instructions: "Inspect existing boundaries and conventions. Describe components, data flow, interface contracts, failure handling and tradeoffs. Include trust boundaries and compatibility. Recommend the smallest design that meets the accepted scope.",
    sections: ["Components and data flow", "Interface contracts", "Decisions and tradeoffs", "Failure and security cases"],
  },
  implementation: {
    name: "Implementation agent",
    purpose: "Propose a small, reviewable implementation.",
    instructions: "Follow the approved plan and design. Read every file before proposing replacement content. Include meaningful tests where needed. Preserve existing conventions and unrelated work. Explain the proposed change and unverified behavior; do not claim a proposal has already been applied.",
    sections: ["Change summary", "Acceptance coverage", "Tests and evidence", "Remaining work"],
  },
  validation: {
    name: "Validation agent",
    purpose: "Compare acceptance criteria with recorded evidence.",
    instructions: "Map each acceptance criterion to evidence. Distinguish passed, failed and not run. Only CURRENT CHECK EVIDENCE is verified command output for the current checkout; previous prose is a claim. Propose missing checks, never execute commands. Missing checks can be run by the operator after this report. Report known failures as blockers.",
    sections: ["Acceptance coverage", "Recorded check results", "Missing checks", "Residual risks"],
  },
  review: {
    name: "Review agent",
    purpose: "Inspect the change for defects and unsupported claims.",
    instructions: "Inspect the diff and relevant files. Report actionable findings with file locations, impact and supporting observations, ordered by severity. Check compatibility and acceptance coverage. Separate uncertain concerns from confirmed defects. Blocking findings belong in blockers. This review is advisory, never independent human approval.",
    sections: ["Findings", "Acceptance coverage", "Evidence and limitations", "Recommendation"],
  },
  delivery: {
    name: "Delivery agent",
    purpose: "Prepare a release handoff and Jira-ready summary.",
    instructions: "Summarize accepted work, checks and unresolved risks. Prepare release notes, rollout and rollback steps, and a Jira update draft linked to the work item. Distinguish readiness from confirmed delivery. Do not claim a deployment, publication or Jira update occurred; these require their own authorized connector and evidence.",
    sections: ["Release summary", "Validation and open risks", "Rollout and rollback", "Jira update draft"],
  },
};

const PHASE_PROFILES: Record<string, BotProfile> = {
  intake: "requirements", planning: "planning", design: "architecture", build: "implementation",
  validation: "validation", review: "review", delivery: "delivery",
};

export function developmentAgentConfig(config: PipelineConfig): PipelineConfig {
  const next = structuredClone(config);
  for (const stage of next.stages) {
    const profile = PHASE_PROFILES[stage.id];
    // Custom phases retain their policy. Applying the starter must not guess
    // which capabilities an unrelated phase should receive.
    if (!profile) continue;
    stage.bot = { ...DEFAULT_BOT_POLICY, ...stage.bot, kind: BOT_PROFILE_KINDS[profile], profile };
  }
  return next;
}

export function handoffText(handoff: BotHandoff): string {
  return handoff.sections.map(section => `${section.title}\n${section.body}`).join("\n\n")
    + (handoff.blockers.length ? "\n\nBlockers\n" + handoff.blockers.join("\n") : "");
}
