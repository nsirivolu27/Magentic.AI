import assert from "node:assert/strict";
import test from "node:test";
import { findSecretKinds, MAX_DATASET_BYTES, validateJsonl } from "../workbench/studio/dataset.js";
import { compareMetrics, developmentEvaluator, REGRESSION_TOLERANCE } from "../workbench/studio/evaluation.js";
import { RECIPES, listRecipes } from "../workbench/studio/recipes.js";

const messages = (user: string, assistant: string) => JSON.stringify({ messages: [{ role: "user", content: user }, { role: "assistant", content: assistant }] });

test("a clean messages dataset passes and is counted", () => {
  const report = validateJsonl([messages("a", "b"), messages("c", "d"), "", messages("e", "f")].join("\n"), "messages");
  assert.equal(report.records, 3, "blank lines are not records");
  assert.equal(report.rejected, 0);
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues, []);
  assert.match(report.contentHash, /^[0-9a-f]{64}$/);
});

test("shape problems name the line and the field", () => {
  const text = [
    messages("a", "b"),
    JSON.stringify({ messages: [{ role: "user", content: "only a user turn" }, { role: "user", content: "again" }] }),
    JSON.stringify({ prompt: "wrong shape for this recipe", completion: "x" }),
    JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], extra: true }),
  ].join("\n");
  const report = validateJsonl(text, "messages");
  assert.equal(report.rejected, 3);
  assert.deepEqual(report.issues.map((issue) => [issue.line, issue.code]), [[2, "wrong-shape"], [3, "wrong-shape"], [4, "wrong-shape"]]);
  assert.match(report.issues[0]!.message, /last message must be from the assistant/);
  assert.equal(report.passed, false);
});

test("prompt-completion is its own shape", () => {
  const good = validateJsonl(JSON.stringify({ prompt: "p", completion: "c" }), "prompt-completion");
  assert.equal(good.passed, true);
  const bad = validateJsonl(messages("a", "b"), "prompt-completion");
  assert.equal(bad.rejected, 1);
});

test("credentials are found on the raw line and reported by kind only", () => {
  const lines = [
    messages("key?", "AKIAIOSFODNN7EXAMPLE"),
    messages("token?", "ghp_" + "a".repeat(36)),
    messages("pem?", "-----BEGIN RSA PRIVATE KEY-----"),
    messages("jwt?", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    messages("config?", "api_key = 0123456789abcdef0123"),
    "{ this is not json but has xoxb-123456789012-abcdefghij }",
    messages("fine", "The password policy requires twelve characters."),
  ].join("\n");
  const report = validateJsonl(lines, "messages");
  assert.equal(report.secretFindings, 6);
  assert.equal(report.records, 7);
  assert.equal(report.rejected, 6);
  assert.deepEqual(report.issues.map((issue) => issue.line), [1, 2, 3, 4, 5, 6]);
  for (const issue of report.issues) {
    assert.equal(issue.code, "secret");
    assert.doesNotMatch(issue.message, /AKIA|ghp_|BEGIN|eyJ|0123456789abcdef|xoxb/, "the message names the kind, never the value");
  }
  assert.deepEqual(findSecretKinds("nothing here"), []);
  assert.deepEqual(findSecretKinds("AKIAIOSFODNN7EXAMPLE and ghp_" + "b".repeat(36)), ["aws-access-key", "github-token"]);
});

test("duplicates are counted but do not reject", () => {
  const report = validateJsonl([messages("a", "b"), messages("a", "b"), messages("c", "d")].join("\n"), "messages");
  assert.equal(report.duplicates, 1);
  assert.equal(report.rejected, 0);
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues.map((issue) => [issue.line, issue.code]), [[2, "duplicate"]]);
});

test("empty and oversized inputs are refused before parsing", () => {
  assert.deepEqual(validateJsonl("\n\n", "messages").issues.map((issue) => issue.code), ["empty"]);
  const huge = validateJsonl("x".repeat(MAX_DATASET_BYTES + 1), "messages");
  assert.deepEqual(huge.issues.map((issue) => issue.code), ["too-large"]);
  assert.equal(huge.records, 0);
});

test("the development evaluator scores readiness and says so", () => {
  const evaluator = developmentEvaluator();
  assert.match(evaluator.note, /does not measure model quality/);
  const recipe = RECIPES["coding-assistant"];
  const metrics = evaluator.evaluate({ recipe, config: {} as never, artifact: {} as never,
    validation: { at: "", by: "", passed: true, records: 25, rejected: 0, duplicates: 5, secretFindings: 0, issues: [], contentHash: "" } });
  assert.deepEqual(metrics, { recordValidity: 1, uniqueness: 0.8, secretHygiene: 1, coverage: 0.5 });
});

test("comparison applies thresholds and a small regression tolerance", () => {
  const thresholds = { a: 0.9, b: 0.5 };
  const pass = compareMetrics({ a: 0.95, b: 0.6 }, thresholds, { a: 0.96, b: 0.1 });
  assert.equal(pass.passed, true, "0.95 is within tolerance of a 0.96 baseline");
  const regress = compareMetrics({ a: 0.95, b: 0.6 }, thresholds, { a: 0.95 + REGRESSION_TOLERANCE + 0.01, b: 0.1 });
  assert.equal(regress.passed, false);
  assert.deepEqual(regress.comparison.map((row) => [row.metric, row.passed]), [["a", false], ["b", true]]);
  const missing = compareMetrics({ a: 1 }, thresholds, {});
  assert.equal(missing.passed, false, "a metric the evaluator did not report counts as zero");
  assert.equal(compareMetrics({}, {}, {}).passed, false, "no thresholds is not a pass");
});

test("every recipe is complete and consistent", () => {
  const recipes = listRecipes();
  assert.equal(recipes.length, 6);
  for (const recipe of recipes) {
    assert.deepEqual(Object.keys(recipe.thresholds).sort(), ["coverage", "recordValidity", "secretHygiene", "uniqueness"]);
    assert.deepEqual(Object.keys(recipe.baselineMetrics).sort(), Object.keys(recipe.thresholds).sort());
    assert.equal(recipe.thresholds.secretHygiene, 1, "no recipe tolerates a credential");
    assert.ok(recipe.minRecords > 0);
    assert.ok(recipe.profileInstructions.length > 40);
  }
});
