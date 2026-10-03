import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEVELOPMENT_PLAYBOOKS, playbookBrief } from "../workbench/playbooks.js";
import { memoryPipelines, pipelineCommandSchema } from "../workbench/pipeline.js";
import { deskView } from "../workbench/desk-view.js";

test("every starter creates a valid session without changing the configured phases or approval policy", () => {
  assert.equal(new Set(DEVELOPMENT_PLAYBOOKS.map(item => item.id)).size, 4);
  for (const starter of DEVELOPMENT_PLAYBOOKS) {
    const engine = memoryPipelines();
    const before = engine.snapshot("one");
    const command = pipelineCommandSchema.parse({ action: "start", requestId: randomUUID(), title: starter.title, brief: playbookBrief(starter) });
    const after = engine.execute("one", "owner", ["author"], command, 2);
    assert.deepEqual(after.config, before.config);
    assert.deepEqual(after.runs[0]!.config, before.config);
    assert.equal(after.runs[0]!.requiredApprovals, 2);
    assert.match(after.runs[0]!.brief, /CONTEXT & STACK/);
    assert.match(after.runs[0]!.brief, /ACCEPTANCE CRITERIA/);
    assert.equal(after.runs[0]!.current, 0);
  }
});

test("desk preserves and escapes personal draft text, with starter application gated by role", () => {
  const snapshot = memoryPipelines().snapshot("one");
  const draft = { title: '<script>alert("x")</script>', brief: "My Kotlin application\nKeep this acceptance criterion." };
  const html = deskView(snapshot, undefined, ["author"], "all", "", draft, "mobile");
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes(draft.brief));
  assert.match(html, /Replace draft with this starter/);
  assert.match(html, /data-playbook="mobile" aria-pressed="true"/);
  assert.doesNotMatch(deskView(snapshot, undefined, ["approver"], "all", "", undefined, "mobile"), /data-use-playbook=/);
});

test("the data starter requires source evidence without claiming a dataset was loaded", () => {
  const starter = DEVELOPMENT_PLAYBOOKS.find(item => item.id === "data-ai")!;
  assert.match(playbookBrief(starter), /dataset URL, publisher, license, version/);
  assert.match(playbookBrief(starter), /has not downloaded or validated a dataset/);
});
