import type { StudioSnapshot } from "./studio/engine.js";
import type { EvaluationRun } from "./studio/schema.js";
import { REGRESSION_TOLERANCE } from "./studio/evaluation.js";
import { escape, percent, status } from "./ui.js";

const CHECKS: Record<string, { label: string; fix: string }> = {
  recordValidity: { label: "Example format", fix: "Fix flagged examples." },
  uniqueness: { label: "Distinct examples", fix: "Replace repeated examples." },
  secretHygiene: { label: "Credential scan", fix: "Remove flagged credentials, then revalidate." },
  coverage: { label: "Enough examples", fix: "Add varied examples." },
};

export function evaluationIssue(evaluation: EvaluationRun): string {
  const failed = evaluation.comparison.filter((row) => !row.passed);
  return failed.length ? failed.map((row) => CHECKS[row.metric]?.label ?? row.metric).join(", ") : "None";
}

export function evaluationAnalysis(studio: StudioSnapshot, evaluation: EvaluationRun): string {
  const development = evaluation.evaluator === "development";
  const failed = evaluation.comparison.filter((row) => !row.passed);
  const job = studio.jobs.find((item) => item.id === evaluation.jobId);
  const config = studio.configs.find((item) => item.id === job?.configId);
  const dataset = studio.datasets.find((item) => item.id === config?.datasetId);
  const project = studio.projects.find((item) => item.id === evaluation.projectId);
  const recipe = studio.recipes.find((item) => item.id === project?.recipeId);
  const rows = [...evaluation.comparison].sort((a, b) => Number(a.passed) - Number(b.passed));
  const checklist = rows.map((row) => {
    const check = CHECKS[row.metric];
    const regressed = row.value < row.baseline - REGRESSION_TOLERANCE;
    let explanation = `${percent(row.value)} · target ${percent(row.threshold)}`;
    if (development && row.metric === "coverage" && recipe && dataset?.validation) {
      // A previous release can raise the effective target. Showing only the
      // recipe minimum would give someone an incomplete repair instruction.
      const needed = Math.ceil(recipe.minRecords * Math.max(row.threshold, row.baseline - REGRESSION_TOLERANCE));
      explanation = `${dataset.validation.records} examples · minimum ${needed}`;
    } else if (development && row.metric === "secretHygiene" && row.value === 1) {
      explanation = "None detected";
    }
    if (regressed) explanation += ` Previously ${percent(row.baseline)}.`;
    return `<li class="analysis-check"><div><strong>${escape(check?.label ?? row.metric)}</strong><p>${escape(explanation)}</p>${!row.passed ? `<p class="analysis-fix">${escape(regressed ? "Restore the previous result, then rerun." : check?.fix ?? "Review requirements, then rerun.")}</p>` : ""}</div>${status(row.passed ? "ok" : "warn", row.passed ? "Passed" : "Needs work")}</li>`;
  }).join("");
  const title = development ? evaluation.passed ? "Data checks passed" : "Needs changes" : evaluation.passed ? "Evaluation passed" : "Needs changes";
  return `<section class="analysis-result" aria-label="Result at a glance"><div class="analysis-verdict"><span class="stage-eyebrow">RESULT</span><h2>${title}</h2><p>${evaluation.comparison.length - failed.length} of ${evaluation.comparison.length} checks passed.</p></div>
    ${development ? `<p class="analysis-scope"><strong>Data checks only.</strong> Answer quality is untested.</p>` : `<p class="analysis-scope">Passing checks does not approve a release.</p>`}
    <ul class="analysis-checks" aria-label="Checks explained">${checklist}</ul></section>`;
}
