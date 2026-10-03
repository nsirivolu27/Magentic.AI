import { z } from "zod";
import { BOT_PROFILES } from "./bot-profiles.js";

export const editorAgentSchema = z.enum(["understand", "plan", "build", "review", "test"]);
export type EditorAgentId = z.infer<typeof editorAgentSchema>;
interface EditorAgent {
  label: string; name: string; purpose: string; mode: "ask" | "edit";
  kind: "planner" | "coder" | "reviewer" | "validator";
  instructions: string; starter: string; action: string; next: EditorAgentId;
}

// These are editor roles, not completed pipeline stages. Switching roles never approves work.
export const EDITOR_AGENTS: Record<EditorAgentId, EditorAgent> = {
  understand: {
    label: "Understand", name: "Code guide", mode: "ask", kind: "planner", next: "plan",
    purpose: "Explore the code, its dependencies, and where a change belongs.", action: "Ask code guide",
    instructions: "Answer the developer's question using repository evidence. Map relevant files and data flow. Explain unfamiliar terms and identify missing context. No edits.",
    starter: "Read the active file and relevant project files. Explain what they do, their dependencies, and where I would make a change.",
  },
  plan: {
    label: "Plan", name: "Planning agent", mode: "ask", kind: "planner", next: "build",
    purpose: "Turn your goal into small steps, affected files, and checks.", action: "Create a plan",
    instructions: BOT_PROFILES.planning.instructions + " Treat earlier conversation as unverified context. Name affected files and acceptance checks. Do not treat a prior report as approval.",
    starter: "Use our discussion and inspect the project to propose a small implementation plan with affected files, risks, and acceptance checks. Ask about missing requirements.",
  },
  build: {
    label: "Build", name: "Build agent", mode: "edit", kind: "coder", next: "review",
    purpose: "Implement a focused change as file edits you review first.", action: "Propose code changes",
    instructions: BOT_PROFILES.implementation.instructions + " Implement only the developer's requested change as small file proposals. Preserve every unrelated character, including labels, comments, whitespace and trailing newlines. Do not reword surrounding text. Earlier plans are context, not authorization for extra scope. Never claim changes have been applied.",
    starter: "Use the previous findings as context and re-read the relevant saved files. Propose the smallest change for the goal we discussed, including useful tests. Explain anything that remains unverified.",
  },
  review: {
    label: "Review", name: "Review agent", mode: "ask", kind: "reviewer", next: "test",
    purpose: "Inspect the saved diff for bugs, regressions, and missing coverage.", action: "Review saved changes",
    instructions: BOT_PROFILES.review.instructions + " Review the current saved working-tree diff, not an unapplied proposal. Earlier conversation is context only. No edits.",
    starter: "Inspect the current saved Git diff and relevant files. Report actionable bugs, regressions, and missing test coverage with file locations. If there is no diff, say so. Do not approve the work.",
  },
  test: {
    label: "Test", name: "Test agent", mode: "ask", kind: "validator", next: "build",
    purpose: "Find coverage gaps and explain which checks to run next.", action: "Assess test coverage",
    instructions: BOT_PROFILES.validation.instructions + " This editor request has no verified command results for current file contents. Host-recorded task outcomes describe past process exits only; use them to recommend investigation, not certify current code. Inspect existing tests and task configuration. Identify what is not run and suggest commands or workspace tasks. Never say checks passed based on conversation. No edits or command execution.",
    starter: "Inspect saved changes, existing tests, and workspace tasks. Identify coverage gaps and recommend checks. Mark checks as not run unless verified evidence is provided. Do not run commands.",
  },
};
