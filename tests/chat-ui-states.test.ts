import assert from "node:assert/strict";
import test from "node:test";
import type { ChatAccessSummary } from "../workbench/chat-access.js";
import { chatConnectionsPage } from "../workbench/chat-connections-view.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";

const summary: ChatAccessSummary = {
  tier: "free", auto: false, managedReady: false,
  connections: [{ provider: "openai", models: ["saved-model"], connectedAt: "2026-01-01" }],
  accountedTokens: 0, budgetDate: "2026-01-01", mcp: { active: false },
};
const cards = (html: string) => [...html.matchAll(/<article class="provider-card[\s\S]*?<\/article>/g)].map(match => match[0]!);

test("connection setup comes before plans and shows saved access without claiming inference health", () => {
  const html = chatConnectionsPage(summary).body;
  const [connected, missing] = cards(html);
  assert.ok(html.indexOf("Your accounts") < html.indexOf("Plans &amp; company access"));
  assert.match(connected!, /Connected/);
  assert.match(connected!, /saved-model/);
  assert.match(connected!, /model availability may change/);
  assert.match(connected!, /Open chat/);
  assert.match(missing!, /Not connected/);
  assert.doesNotMatch(missing!, /Open chat|saved-model/);
});

test("a failed update stays on its provider, retains model IDs and does not claim the saved connection is unchanged", () => {
  const html = chatConnectionsPage(summary, undefined, {
    provider: "openai", state: "error", models: ['new-model"><script>'], message: "Could not confirm <update>",
  }).body;
  const [failed, untouched] = cards(html);
  assert.match(failed!, /Update failed/);
  assert.match(failed!, /role="alert"/);
  assert.match(failed!, /Could not confirm &lt;update&gt;/);
  assert.match(failed!, /new-model&quot;&gt;&lt;script&gt;/);
  assert.match(failed!, /saved-model/);
  assert.match(failed!, /Refresh to confirm access/);
  assert.doesNotMatch(failed!, /unchanged|<script>/);
  assert.doesNotMatch(untouched!, /Update failed|new-model/);
  assert.match(html, /data-chat-access-refresh/);
});

test("verification disables competing credential forms and never renders a saved credential", () => {
  const html = chatConnectionsPage(summary, undefined, { provider: "google", state: "verifying", models: ["candidate"] }).body;
  const rows = cards(html);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.match(row, /type="password"[^>]*disabled/);
    assert.doesNotMatch(row, /type="password"[^>]*value=/);
    assert.match(row, /type="submit" disabled/);
  }
  assert.match(rows[2]!, /aria-busy="true"/);
  assert.match(rows[2]!, /Checking API access/);
  assert.doesNotMatch(rows[0]!, /Checking API access/);
});

test("each assistant reply keeps its actual model and reported usage even when it matches the selection", () => {
  const state = emptyChat();
  state.selectedModel = "local-model";
  state.messages = [
    { role: "user", content: "Summarize the handoff." },
    { role: "assistant", model: "local-model", content: "Review the draft first.", usage: { promptTokens: 50, completionTokens: 12 }, elapsedMs: 800 },
    { role: "assistant", model: "other<model>", content: "No measured usage." },
  ];
  const html = chatView({ configured: true, model: "local-model" }, state, [], { base: true });
  assert.match(html, /class="chat-reply-model">local-model</);
  assert.match(html, /other&lt;model&gt;/);
  assert.match(html, /50 input · 12 output tokens \(reported\)/);
  assert.match(html, /0.8s/);
  assert.match(html, /Token usage not reported/);
  assert.equal((html.match(/class="chat-message-footer"/g) ?? []).length, 2);
});
