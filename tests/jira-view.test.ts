import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { jiraReviewView, jiraHistoryView, type JiraHistory } from "../workbench/jira-view.js";
import { authorize, intentFromPreview, hashIntent } from "../workbench/jira.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { pipelineView } from "../workbench/pipeline-view.js";

function fixture() {
  const engine = memoryPipelines();
  const snapshot = engine.execute("one", "owner", ["admin"], {
    action: "start", requestId: randomUUID(), title: "Review <script>alert(1)</script>", brief: "Keep the exact reviewed words.",
  }, 1);
  const run = snapshot.runs[0]!;
  const intent = intentFromPreview(run.jira[0]!, "one", run.id, { siteOrigin: "https://jira.example" });
  const action = authorize(intent, "owner", ["admin"]);
  const history: JiraHistory = { mode: "preview", siteOrigin: intent.siteOrigin, runId: run.id,
    total: 1, offset: 0, nextOffset: null, actions: [action] };
  return { snapshot, run, intent, action, history };
}

test("Jira reviews escape content, show the destination and hash, and require confirmation", () => {
  const { intent } = fixture();
  const review = { mode: "preview" as const, intent, expectedIntentHash: hashIntent(intent) };
  const html = jiraReviewView(review);
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes(review.expectedIntentHash)); assert.ok(html.includes(intent.eventId));
  assert.match(html, /nothing will be sent/); assert.match(html, /Save local preview/);
  assert.match(html, /id="jira-confirm" disabled/); assert.match(html, /type="checkbox"/);
  const live = jiraReviewView({ ...review, mode: "live" });
  assert.match(live, /Send to Jira/); assert.ok(live.includes("https://jira.example"));
});

test("Jira evidence distinguishes pending and uncertain outcomes and refuses unsafe links", () => {
  const { action, history } = fixture();
  assert.match(jiraHistoryView(history), /No confirmed Jira delivery/);
  const uncertain = jiraHistoryView({ ...history, actions: [{ ...action, status: "uncertain", lastError: "<img src=x>" }] });
  assert.match(uncertain, /will not be retried automatically/); assert.ok(!uncertain.includes("<img"));
  for (const url of ["javascript:alert(1)", "https://another.example/browse/ENG-1"]) {
    const html = jiraHistoryView({ ...history, actions: [{ ...action, status: "sent", evidence: {
      issueKey: "ENG-1", url, at: new Date().toISOString(),
    } }] });
    assert.ok(!html.includes("href=")); assert.ok(html.includes("ENG-1"));
  }
  const sent = jiraHistoryView({ ...history, actions: [{ ...action, status: "sent", evidence: {
    issueKey: "ENG-1", url: "https://jira.example/browse/ENG-1", at: new Date().toISOString(),
  } }] });
  assert.match(sent, /href="https:\/\/jira.example\/browse\/ENG-1"/);
});

test("history pages stay bound to the run and show retry timing", () => {
  const { action, history } = fixture();
  const html = jiraHistoryView({ ...history, total: 50, offset: 20, nextOffset: 40,
    actions: [{ ...action, status: "failed", retryNotBefore: "2026-09-22T12:00:00.000Z" }] });
  assert.ok(html.includes(`data-jira-history="${history.runId}"`));
  assert.match(html, /data-jira-offset="0"/); assert.match(html, /data-jira-offset="40"/);
  assert.match(html, /2026-09-22T12:00:00.000Z/);
  assert.match(jiraHistoryView({ ...history, total: 0, actions: [] }), /No saved actions yet/);
});

test("Jira controls follow server capabilities and missing issue keys cannot be reviewed", () => {
  const { snapshot } = fixture();
  const readOnly = pipelineView(snapshot, "owner", ["admin"], undefined, undefined, undefined, undefined, { canReview: false });
  assert.match(readOnly, /Saved actions &amp; evidence|Saved actions & evidence/);
  assert.ok(!readOnly.includes("data-jira-review="));
  const editable = pipelineView(snapshot, "owner", ["admin"], undefined, undefined, undefined, undefined, { canReview: true });
  assert.ok(editable.includes("data-jira-review="));
  snapshot.runs[0]!.jira[0]!.action = "update_issue";
  const unbound = pipelineView(snapshot, "owner", ["admin"], undefined, undefined, undefined, undefined, { canReview: true });
  assert.ok(!unbound.includes("data-jira-review="));
  assert.match(unbound, /confirmed issue key/);
  const legacy = pipelineView(snapshot, "owner", ["admin"]);
  assert.ok(!legacy.includes("data-jira-history="));
});
