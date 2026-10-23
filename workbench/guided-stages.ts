import type { PipelineConfig } from "./pipeline.js";
import type { Phase, PhaseReport } from "./studio-model.js";
import { escape } from "./ui.js";

export const STUDIO_STAGES: { id: Phase; title: string; task: string; result: string }[] = [
  { id: "define", title: "Choose a purpose", task: "Pick a template for your task.", result: "A purpose and recommended settings." },
  { id: "data", title: "Add examples", task: "Add questions and ideal answers.", result: "A set of examples checked for format and credentials." },
  { id: "train", title: "Build a candidate", task: "Choose examples. Use the template defaults.", result: "A candidate to test before anyone uses it." },
  { id: "evaluate", title: "Check results", task: "Check results. Fix what needs work.", result: "A comparison with the template targets and previous release." },
  { id: "approve", title: "Get approval", task: "Send this version for review.", result: "A release signed by the required reviewers." },
  { id: "use", title: "Use the assistant", task: "Name, test and assign your assistant.", result: "An assistant using an approved release." },
];

/**
 * The six stages fall into three groups a reviewer reads differently: things
 * the author can still change, results measured against the template, and
 * the signed release plus its assignment. The rail shows the groups so the
 * approval gate is visible as a gate, not as step five of six.
 */
export const STAGE_GROUPS: { title: string; hint: string; stages: Phase[] }[] = [
  { title: "Development", hint: "Artifacts the author can change", stages: ["define", "data", "train"] },
  { title: "Live tests", hint: "Results against the template targets", stages: ["evaluate"] },
  { title: "Release", hint: "Signed approval, then assignment", stages: ["approve", "use"] },
];

export const STAGE_LABELS = { complete: "Complete", current: "Next step", blocked: "Needs attention", failed: "Needs changes", "not-started": "Not started" } as const;
const STAGE_MARKS = { complete: "✓", current: "●", blocked: "!", failed: "✗", "not-started": "○" } as const;

export function studioGuide(projectId: string, phase: Phase, report: PhaseReport): string {
  const card = (stage: typeof STUDIO_STAGES[number]) => {
    const state = report.states[stage.id];
    const index = STUDIO_STAGES.indexOf(stage);
    return `<li class="stage-card ${state}${phase === stage.id ? " selected" : ""}"><a href="#/studio/${escape(projectId)}/${stage.id}" ${phase === stage.id ? 'aria-current="step"' : ""}><span class="stage-number" aria-hidden="true">${index + 1}</span><span class="stage-text"><strong>${stage.title}</strong><small>${STAGE_LABELS[state]}<span class="stage-mark" aria-hidden="true">${STAGE_MARKS[state]}</span></small></span></a></li>`;
  };
  const groups = STAGE_GROUPS.map(group => `<section class="stage-group" aria-label="${escape(group.title)}"><h3>${escape(group.title)}<small>${escape(group.hint)}</small></h3><ol>${group.stages.map(id => card(STUDIO_STAGES.find(stage => stage.id === id)!)).join("")}</ol></section>`);
  return `<nav class="stage-guide" aria-label="Project stages">${groups.join("")}</nav>`;
}

/** One sentence that says why the stage being viewed is in the state it is in. */
export function stageStateSentence(phase: Phase, report: PhaseReport, pending?: { approvals: number; required: number }): string {
  const state = report.states[phase];
  const reason = phase === report.current ? report.blocking : report.reasons[phase];
  const stage = STUDIO_STAGES.find(item => item.id === phase)!;
  if (state === "failed") return `Needs changes: ${reason ?? "the last attempt did not pass."}`;
  if (state === "blocked") return `Blocked: ${reason ?? "something earlier must be fixed first."}`;
  if (phase === "approve" && pending) return `Awaiting approval: ${pending.approvals} of ${pending.required} reviewer signatures. Approval is a signed action by an eligible reviewer; the author cannot sign their own release.`;
  if (state === "complete") return `Complete. ${stage.result}`;
  if (state === "current") return "Next step. Nothing earlier is blocking it.";
  const index = STUDIO_STAGES.indexOf(stage);
  const previous = STUDIO_STAGES[index - 1];
  return previous ? `Not started: finish ${previous.title.toLowerCase()} first.` : "Not started.";
}

export interface GuidedExample { question: string; answer: string }

// Both entry methods use the same dataset validator, so the simple form cannot
// skip credential checks or make a small sample count as adequate coverage.
export function exampleRecords(examples: GuidedExample[], shape: "messages" | "prompt-completion"): string {
  if (!examples.length) throw new Error("Add at least one example first.");
  return examples.map((example) => {
    const question = example.question.trim(), answer = example.answer.trim();
    if (!question || !answer) throw new Error("Each example needs a question and an ideal answer.");
    return JSON.stringify(shape === "messages" ? { messages: [{ role: "user", content: question }, { role: "assistant", content: answer }] } : { prompt: question, completion: answer });
  }).join("\n");
}

export interface StageSettings { assistantId: string; instructions: string; context: string; approval: boolean }

export function configureStage(config: PipelineConfig, stageId: string, settings: StageSettings): PipelineConfig {
  const result = structuredClone(config);
  const stage = result.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error("This stage no longer exists. Refresh the workflow.");
  stage.instructions = settings.instructions.trim();
  stage.context = settings.context.trim();
  stage.approval = settings.approval;
  if (settings.assistantId) stage.assistantId = settings.assistantId;
  else delete stage.assistantId;
  return result;
}
