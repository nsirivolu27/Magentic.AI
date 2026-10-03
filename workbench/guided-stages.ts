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

export function studioGuide(projectId: string, phase: Phase, report: PhaseReport): string {
  const labels = { complete: "Complete", current: "Next step", blocked: "Needs attention", failed: "Needs changes", "not-started": "Not started" };
  return `<nav class="stage-guide" aria-label="Project stages"><ol>${STUDIO_STAGES.map((stage, index) =>
    `<li><a href="#/studio/${escape(projectId)}/${stage.id}" ${phase === stage.id ? 'aria-current="step"' : ""}><span class="stage-number" aria-hidden="true">${index + 1}</span><span><strong>${stage.title}</strong><small>${labels[report.states[stage.id]]}</small></span></a></li>`
  ).join("")}</ol></nav>`;
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
