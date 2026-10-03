import type { Hyperparameters, RecipeId } from "./schema.js";

/**
 * Use-case recipes.
 *
 * A recipe is the opinionated starting point for one kind of assistant: what
 * its training data should look like, sensible training defaults, which
 * evaluation suite it must pass and how strict that suite is, and the
 * instructions a chatbot profile built from it starts with.
 *
 * Recipes are code, not records, on purpose. They are reviewed like code,
 * they cannot be edited from the browser, and a project that names one keeps
 * naming it even if a later version of this file changes the defaults.
 */

/** How each JSONL line is shaped. */
export type DatasetShape = "messages" | "prompt-completion";

export interface Recipe {
  id: RecipeId;
  title: string;
  purpose: string;
  datasetShape: DatasetShape;
  /** Fewer records than this and coverage scores below 1. */
  minRecords: number;
  baseModel: string;
  hyperparameters: Hyperparameters;
  suiteId: string;
  /** Every metric the suite reports, with the minimum it must reach. */
  thresholds: Record<string, number>;
  /** What an untrained base model scores. A first release must beat this. */
  baselineMetrics: Record<string, number>;
  profileInstructions: string;
}

/**
 * The four readiness metrics every suite reports today.
 *
 * They measure the data and configuration behind a release, because that is
 * what the development evaluator can measure without a model. A provider
 * that returns real model outputs will add quality metrics beside these.
 */
export const READINESS_METRICS = ["recordValidity", "uniqueness", "secretHygiene", "coverage"] as const;

const READINESS_BASELINE = { recordValidity: 0, uniqueness: 0, secretHygiene: 1, coverage: 0 };

export const RECIPES: Readonly<Record<RecipeId, Recipe>> = {
  "coding-assistant": {
    id: "coding-assistant", title: "Coding assistant",
    purpose: "Answer questions about a codebase and propose small, reviewable changes.",
    datasetShape: "messages", minRecords: 50, baseModel: "qwen2.5-coder:7b",
    hyperparameters: { epochs: 3, learningRate: 0.00002, batchSize: 8 },
    suiteId: "coding-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.95, secretHygiene: 1, coverage: 0.8 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You help engineers understand and change this codebase. Read before you propose. Keep changes small and explain them. Never claim a change has been applied or tested unless you have evidence.",
  },
  "it-support": {
    id: "it-support", title: "IT support",
    purpose: "Resolve common workstation, access and account requests, and know when to escalate.",
    datasetShape: "messages", minRecords: 100, baseModel: "llama3.1:8b",
    hyperparameters: { epochs: 3, learningRate: 0.00002, batchSize: 16 },
    suiteId: "it-support-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.9, secretHygiene: 1, coverage: 0.7 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You are the first line of IT support. Ask for the details you need, give one step at a time, and escalate anything involving credentials, security incidents or data loss to a person. Never ask for or repeat passwords.",
  },
  "incident-summarization": {
    id: "incident-summarization", title: "Incident summarization",
    purpose: "Turn an incident timeline into a clear summary with impact, cause and follow-ups.",
    datasetShape: "prompt-completion", minRecords: 40, baseModel: "llama3.1:8b",
    hyperparameters: { epochs: 4, learningRate: 0.00001, batchSize: 8 },
    suiteId: "incident-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.95, secretHygiene: 1, coverage: 0.75 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You summarize incidents from their timelines. State impact, timeline, suspected cause and open follow-ups in that order. Mark anything not supported by the timeline as unknown rather than guessing.",
  },
  "internal-knowledge": {
    id: "internal-knowledge", title: "Internal knowledge",
    purpose: "Answer questions from internal documentation and cite where the answer came from.",
    datasetShape: "messages", minRecords: 100, baseModel: "llama3.1:8b",
    hyperparameters: { epochs: 2, learningRate: 0.00002, batchSize: 16 },
    suiteId: "knowledge-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.9, secretHygiene: 1, coverage: 0.7 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You answer questions from internal documentation. Cite the document each answer came from. If the documentation does not cover the question, say so instead of filling the gap.",
  },
  "jira-issue-assistant": {
    id: "jira-issue-assistant", title: "Jira issue assistant",
    purpose: "Draft well-formed Jira issues and status updates from short descriptions.",
    datasetShape: "prompt-completion", minRecords: 40, baseModel: "qwen2.5-coder:7b",
    hyperparameters: { epochs: 3, learningRate: 0.00002, batchSize: 8 },
    suiteId: "jira-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.95, secretHygiene: 1, coverage: 0.75 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You draft Jira issues and updates. Produce a summary, description, acceptance criteria and a suggested issue type. You prepare drafts only; a person reviews and submits them.",
  },
  "salesforce-delivery": {
    id: "salesforce-delivery", title: "Salesforce delivery",
    purpose: "Answer client and delivery questions from an agency's own implementation notes, in the agency's wording.",
    datasetShape: "messages", minRecords: 60, baseModel: "llama3.1:8b",
    hyperparameters: { epochs: 3, learningRate: 0.00002, batchSize: 16 },
    suiteId: "salesforce-readiness-v1",
    thresholds: { recordValidity: 0.98, uniqueness: 0.9, secretHygiene: 1, coverage: 0.75 },
    baselineMetrics: READINESS_BASELINE,
    profileInstructions: "You are a Salesforce consulting agency's delivery assistant. Answer from the agency's implementation notes: name the client, say what was done and what comes next. Never invent org configuration; ask for the org, the object and the requirement first. Never ask for or repeat credentials, security tokens or client data.",
  },
};

export function recipeFor(id: RecipeId): Recipe {
  return RECIPES[id];
}

export function listRecipes(): Recipe[] {
  return Object.values(RECIPES);
}
