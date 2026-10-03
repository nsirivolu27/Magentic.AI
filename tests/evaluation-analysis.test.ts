import assert from "node:assert/strict";
import test from "node:test";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { evaluationAnalysis } from "../workbench/evaluation-analysis.js";

function evaluated(count: number) {
  const studio = memoryModelStudio();
  const command = (raw: Record<string, unknown>) => studio.execute("analysis", "author", ["author"], raw, 2);
  let snapshot = command({ action: "create_project", name: "Documentation", recipeId: "coding-assistant", purpose: "Test explanation" });
  snapshot = command({ action: "register_dataset", projectId: snapshot.projects[0]!.id, name: "Examples", source: { kind: "inline", text: Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [{ role: "user", content: `Question ${index}` }, { role: "assistant", content: `Answer ${index}` }] })).join("\n") } });
  snapshot = command({ action: "validate_dataset", datasetId: snapshot.datasets[0]!.id });
  snapshot = command({ action: "configure_training", projectId: snapshot.projects[0]!.id, datasetId: snapshot.datasets[0]!.id, provider: "local-dev" });
  snapshot = command({ action: "create_job", configId: snapshot.configs[0]!.id });
  snapshot = command({ action: "record_job", jobId: snapshot.jobs[0]!.id });
  snapshot = command({ action: "run_evaluation", jobId: snapshot.jobs[0]!.id });
  return { snapshot, evaluation: snapshot.evaluations[0]! };
}

test("analysis explains the failed check first and gives a concrete example target", () => {
  const { snapshot, evaluation } = evaluated(12);
  const html = evaluationAnalysis(snapshot, evaluation);
  assert.ok(html.indexOf("Enough examples") < html.indexOf("Example format"));
  assert.match(html, /12 examples · minimum 40/);
  assert.match(html, /Add varied examples/);
  assert.match(html, /3 of 4 checks passed/);
  assert.match(html, /Data checks only/);
  assert.match(html, /Answer quality is untested/);
});

test("a previous release's result raises the displayed coverage requirement", () => {
  const { snapshot, evaluation } = evaluated(12);
  evaluation.comparison.find((row) => row.metric === "coverage")!.baseline = 1;
  const html = evaluationAnalysis(snapshot, evaluation);
  assert.match(html, /12 examples · minimum 49/);
  assert.match(html, /Previously 100%/);
  assert.match(html, /Restore the previous result/);
});

test("passing data checks never claim model quality and unknown checks are escaped", () => {
  const { snapshot, evaluation } = evaluated(60);
  const html = evaluationAnalysis(snapshot, evaluation);
  assert.match(html, /Data checks passed/);
  assert.match(html, /Answer quality is untested/);
  assert.doesNotMatch(html, /analysis-fix/);
  evaluation.evaluator = "custom";
  evaluation.comparison[0]!.metric = "<script>unknown</script>";
  const custom = evaluationAnalysis(snapshot, evaluation);
  assert.match(custom, /&lt;script&gt;unknown/);
  assert.doesNotMatch(custom, /<script>|Data checks only/);
});
