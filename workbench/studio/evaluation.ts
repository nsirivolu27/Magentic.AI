import type { Recipe } from "./recipes.js";
import type { Artifact, ComparisonRow, DatasetValidation, TrainingConfig } from "./schema.js";

/**
 * Evaluation: the gate between a finished job and a release request.
 *
 * An evaluator turns a job's inputs and output into metrics. The comparison
 * below is the same for every evaluator: each metric must reach the recipe's
 * threshold and must not fall meaningfully below the baseline. The baseline
 * is the last approved release of the same project when there is one, and
 * the recipe's untrained baseline otherwise, so a second release has to be
 * at least as good as the one it replaces.
 */

export interface EvaluationInput {
  recipe: Recipe;
  config: TrainingConfig;
  validation: DatasetValidation;
  artifact: Artifact;
}

export interface Evaluator {
  id: string;
  /** Every metric named in the recipe's thresholds, each between 0 and 1. */
  evaluate(input: EvaluationInput): Record<string, number>;
  /** Shown beside the results so nobody mistakes what was measured. */
  note: string;
}

/** A metric may sit this far below the baseline and still pass. */
export const REGRESSION_TOLERANCE = 0.02;

export const DEVELOPMENT_EVALUATOR = "development";

/**
 * Scores what can be scored without a model: the readiness of the data
 * and configuration behind the artifact. This is not a measure of model
 * quality and the note says so. It is deterministic, which is what lets
 * the release gate and its tests be exact.
 */
export function developmentEvaluator(): Evaluator {
  return {
    id: DEVELOPMENT_EVALUATOR,
    note: "Development evaluator: scores dataset and configuration readiness. It does not measure model quality, because the development provider trains no model.",
    evaluate({ recipe, validation }) {
      const records = Math.max(validation.records, 1);
      return {
        recordValidity: round((validation.records - validation.rejected) / records),
        uniqueness: round((validation.records - validation.duplicates) / records),
        secretHygiene: validation.secretFindings === 0 ? 1 : 0,
        coverage: round(Math.min(1, validation.records / recipe.minRecords)),
      };
    },
  };
}

export function compareMetrics(
  metrics: Record<string, number>,
  thresholds: Record<string, number>,
  baseline: Record<string, number>,
): { comparison: ComparisonRow[]; passed: boolean } {
  const comparison: ComparisonRow[] = Object.keys(thresholds).sort().map((metric) => {
    const value = metrics[metric] ?? 0;
    const threshold = thresholds[metric] ?? 0;
    const base = baseline[metric] ?? 0;
    return { metric, value, threshold, baseline: base, passed: value >= threshold && value >= base - REGRESSION_TOLERANCE };
  });
  return { comparison, passed: comparison.length > 0 && comparison.every((row) => row.passed) };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
