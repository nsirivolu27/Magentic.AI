import assert from "node:assert/strict";
import test from "node:test";
import { workspaceConsole, workspaceAgents } from "../workbench/workspace-console.js";
import { slackControls } from "../workbench/slack-view.js";
import { queueForAudience, type QueueItem } from "../workbench/operations-model.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { applyConfigurable, type AgentConfigurable } from "../workbench/agent-configurables.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

function snapshot(): WorkbenchSnapshot {
  return { workspaceId: "one", actor: "operator", roles: ["admin"], canAuthor: true, demo: false,
    workflow: DEFAULT_WORKFLOW, records: [], audit: [], mcp: { agents: [], withheld: [] }, chat: { configured: false },
    pipelines: memoryPipelines().snapshot("one"), studio: memoryModelStudio().snapshot("one") };
}
test("workspace controls retain agent context and only offer administrative assignment labels to admins", () => {
  const s = snapshot();
  let html = workspaceConsole(s, true, new URLSearchParams("tab=agents&controls=slack"));
  assert.ok(html.includes("#/workspace?tab=agents&controls="));
  assert.match(html, /Stage assignments/); assert.match(html, /\/companies/);
  assert.match(html, /Not connected/); assert.doesNotMatch(html, /data-slack-action="send"/);
  s.roles = ["approver"];
  html = workspaceConsole(s, false, new URLSearchParams());
  assert.match(html, /View workflow/); assert.doesNotMatch(html, /Stage assignments/);
  assert.match(html, /Access &amp; setup/);
});
test("team agents match assigned content, escape labels and exclude other workspaces", () => {
  const s = snapshot(), stage = s.pipelines!.config.stages[0]!;
  s.studio!.profiles.push({ id: "foreign", workspaceId: "two", name: "Other company profile", releaseId: "release", instructions: "private",
    status: "active", createdBy: "owner", createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" });
  const agent: AgentConfigurable = { id: "00000000-0000-4000-8000-000000000001", name: "<script>agent</script>",
    purpose: "Review docs", model: "local", instructions: "Read docs", bot: { kind: "planner", maxSteps: 2, timeoutSeconds: 30, allowedTools: [] } };
  s.pipelines!.config.configurables = [agent];
  s.pipelines!.config = applyConfigurable(s.pipelines!.config, agent.id, stage.id);
  let html = workspaceAgents(s);
  assert.doesNotMatch(html, /Other company profile|foreign/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes("#/workflows/" + stage.id));
  s.pipelines!.config.stages[0]!.instructions = "Changed";
  html = workspaceAgents(s); assert.match(html, /Unassigned/);
  s.roles = ["author"]; assert.doesNotMatch(workspaceAgents(s), /Create agent|Assign stages/);
});
test("personal queue includes owned work and eligible reviews without changing the team list", () => {
  const base: QueueItem = { id: "one", title: "Task", kind: "Work", owner: "operator", state: "active", phase: "Intake", detail: "", href: "#/desk", action: "Open" };
  const rows: QueueItem[] = [base, { ...base, id: "two", owner: "other" }, { ...base, id: "three", owner: "other", state: "review" }];
  assert.deepEqual(queueForAudience(rows, "operator", "mine").map(row => row.id), ["one", "three"]);
  assert.equal(queueForAudience(rows, "operator", "team").length, 3);
  assert.equal(rows.length, 3);
});
test("Slack UI exposes exact escaped preview only to permitted senders and reports uncertainty", () => {
  const summary = { configured: true, ready: true, canSend: true, channel: "#audit", receipts: [] };
  const preview = { id: "preview", channel: "#audit", text: "<img src=x>", hash: "hash", expiresAt: "later" };
  assert.match(slackControls(summary, preview), /&lt;img src=x&gt;/);
  assert.match(slackControls(summary, preview), /data-slack-action="send"/);
  assert.doesNotMatch(slackControls({ ...summary, canSend: false }, preview), /data-slack-action="send"|img/);
  assert.match(slackControls({ ...summary, receipts: [{ id: "id", actor: "operator", channel: "#audit", at: "now", contentHash: "hash", state: "unknown" }] }), /Unconfirmed/);
});
