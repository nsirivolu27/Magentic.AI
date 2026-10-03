import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize, hashIntent, intentFromPreview, jiraIntentSchema, jiraSiteFromEnv,
  JiraError, previewDelivery, restDelivery, type JiraIntent,
} from "../workbench/jira.js";
import type { JiraPreview } from "../workbench/pipeline.js";

const WS = "magentic";
const RUN = "11111111-1111-4111-8111-111111111111";

function preview(overrides: Partial<JiraPreview> = {}): JiraPreview {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    eventId: "33333333-3333-4333-8333-333333333333",
    action: "create_issue", project: "KAN", issueType: "Task", issueKey: null,
    summary: "Durable local workspace storage", status: "To Do",
    comment: "design: storage boundary recorded", delivery: "preview",
    ...overrides,
  };
}

/** The site these delivery tests target. An intent now names its destination. */
const ORIGIN = "https://x.atlassian.net";

function intent(overrides: Partial<JiraIntent> = {}): JiraIntent {
  return jiraIntentSchema.parse({ ...intentFromPreview(preview(), WS, RUN, { siteOrigin: ORIGIN }), ...overrides });
}

test("an intent carries the trail back to the stage event", () => {
  const value = intentFromPreview(preview(), WS, RUN);
  assert.equal(value.previewId, preview().id);
  assert.equal(value.eventId, preview().eventId);
  assert.equal(value.runId, RUN);
  assert.equal(value.workspaceId, WS);
});

test("an update without an issue key, and a create with one, are both refused", () => {
  // update_issue is the preview vocabulary; add_comment is what it does.
  assert.throws(() => intent({ action: "update_issue", operation: "add_comment", issueKey: null }));
  assert.throws(() => intent({ action: "create_issue", operation: "create_issue", issueKey: "KAN-1" }));
});

test("an issue key from another project is refused", () => {
  assert.throws(() => intent({ action: "update_issue", operation: "add_comment", issueKey: "OTHER-4" }));
});

test("only an admin can authorize a Jira action", () => {
  assert.throws(
    () => authorize(intent(), "a.rivera", ["author"]),
    (error: unknown) => error instanceof JiraError && /cannot authorize/.test(error.message),
  );
  const pending = authorize(intent(), "s.patel", ["admin"]);
  assert.equal(pending.status, "pending");
  assert.equal(pending.authorizedBy, "s.patel");
  assert.equal(pending.attempts, 0);
  assert.equal(pending.evidence, undefined, "authorizing is not sending");
});

test("preview mode never sends and says so", async () => {
  const pending = authorize(intent(), "s.patel", ["admin"]);
  const delivery = previewDelivery();
  assert.equal(delivery.mode, "preview");
  const after = await delivery.send(pending);
  assert.equal(after.status, "pending");
  assert.equal(after.evidence, undefined);
  assert.match(after.lastError ?? "", /nothing was sent/i);
});

test("a site is only configured when every part is present", () => {
  assert.equal(jiraSiteFromEnv({}), undefined, "nothing set is preview mode, not an error");
  // Partly configured is a mistake worth naming, not a silent fallback.
  assert.throws(
    () => jiraSiteFromEnv({ MAGENTIC_JIRA_URL: "https://magenticai.atlassian.net" }),
    (error: unknown) => error instanceof JiraError && /MAGENTIC_JIRA_EMAIL/.test(error.message),
  );
  const site = jiraSiteFromEnv({
    MAGENTIC_JIRA_URL: "https://magenticai.atlassian.net/jira/software/projects/KAN",
    MAGENTIC_JIRA_EMAIL: "someone@example.test",
    MAGENTIC_JIRA_API_TOKEN: "token",
  });
  assert.equal(site?.baseUrl, "https://magenticai.atlassian.net", "only the origin is kept");
  assert.throws(() => jiraSiteFromEnv({
    MAGENTIC_JIRA_URL: "http://insecure.example", MAGENTIC_JIRA_EMAIL: "a@b.test", MAGENTIC_JIRA_API_TOKEN: "t",
  }), /https/);
});

test("a create posts to the issue endpoint and records the returned key as evidence", async () => {
  const seen: { url: string; method: string; body: unknown; auth: string }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({
      url: String(url), method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).authorization),
    });
    return new Response(JSON.stringify({ key: "KAN-42" }), { status: 201 });
  };

  const pending = authorize(intent(), "s.patel", ["admin"]);
  const after = await restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "secret" }, fake).send(pending);

  assert.equal(seen[0]?.url, `${ORIGIN}/rest/api/3/issue`);
  assert.equal(seen[0]?.method, "POST");
  assert.deepEqual((seen[0]?.body as { fields: { project: { key: string } } }).fields.project, { key: "KAN" });
  assert.equal(after.status, "sent");
  assert.equal(after.attempts, 1);
  assert.equal(after.evidence?.issueKey, "KAN-42");
  assert.equal(after.evidence?.url, `${ORIGIN}/browse/KAN-42`);
});

test("an update comments on the named issue", async () => {
  const seen: string[] = [];
  const fake: typeof fetch = async (url) => { seen.push(String(url)); return new Response(null, { status: 204 }); };
  const pending = authorize(intent({ action: "update_issue", operation: "add_comment", issueKey: "KAN-7" }), "s.patel", ["admin"]);
  const after = await restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "s" }, fake).send(pending);
  assert.equal(seen[0], `${ORIGIN}/rest/api/3/issue/KAN-7/comment`);
  assert.equal(after.evidence?.issueKey, "KAN-7");
});

test("editing an intent after authorization stops it being delivered", async () => {
  const pending = authorize(intent(), "s.patel", ["admin"]);
  const tampered = { ...pending, intent: { ...pending.intent, summary: "Something else entirely" } };
  let called = false;
  const fake: typeof fetch = async () => { called = true; return new Response("{}", { status: 200 }); };

  const after = await restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "s" }, fake).send(tampered);
  assert.equal(called, false, "nothing may be sent for content nobody authorized");
  assert.equal(after.status, "failed");
  assert.match(after.lastError ?? "", /authorize it again/i);
  assert.notEqual(hashIntent(tampered.intent), tampered.intentHash);
});

test("a refusal from Jira is recorded without leaking the credential", async () => {
  const fake: typeof fetch = async () => new Response("nope", { status: 403 });
  const pending = authorize(intent(), "s.patel", ["admin"]);
  const after = await restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "super-secret-token" }, fake).send(pending);

  assert.equal(after.status, "failed");
  assert.equal(after.attempts, 1);
  assert.match(after.lastError ?? "", /403/);
  assert.equal(after.lastError?.includes("super-secret-token"), false, "the token must never reach an error message");
  assert.equal(after.evidence, undefined);
});

test("an action already sent is not sent twice", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ key: "KAN-1" }), { status: 201 }); };
  const delivery = restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "s" }, fake);
  const once = await delivery.send(authorize(intent(), "s.patel", ["admin"]));
  const twice = await delivery.send(once);
  assert.equal(calls, 1, "delivery is idempotent for an action that already has evidence");
  assert.equal(twice.evidence?.issueKey, "KAN-1");
});
