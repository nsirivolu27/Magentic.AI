import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize, intentFromPreview, jiraIntentSchema, JiraError, restDelivery,
  type JiraIntent, type JiraSite,
} from "../workbench/jira.js";
import type { JiraPreview } from "../workbench/pipeline.js";

const ORIGIN = "https://x.atlassian.net";
const SITE: JiraSite = { baseUrl: ORIGIN, email: "a@b.test", apiToken: "s" };
const WS = "magentic";
const RUN = "11111111-1111-4111-8111-111111111111";

function preview(): JiraPreview {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    eventId: "33333333-3333-4333-8333-333333333333",
    action: "update_issue", project: "KAN", issueType: "Task", issueKey: "KAN-3",
    summary: "Durable Jira actions", status: "In Progress",
    comment: "build: lifecycle wired", delivery: "preview",
  };
}

function intent(overrides: Partial<JiraIntent> = {}): JiraIntent {
  return jiraIntentSchema.parse({
    ...intentFromPreview(preview(), WS, RUN, { siteOrigin: ORIGIN, operation: "add_comment" }),
    ...overrides,
  });
}

test("update_fields puts the named fields and nothing else", async () => {
  const seen: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  };
  const action = authorize(intent({ operation: "update_fields", fields: { summary: "New summary", labels: ["magentic"] } }), "s.patel", ["admin"]);
  const after = await restDelivery(SITE, fake).send(action);

  assert.equal(seen[0]?.method, "PUT");
  assert.equal(seen[0]?.url, `${ORIGIN}/rest/api/3/issue/KAN-3`);
  const fields = (seen[0]?.body as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(Object.keys(fields).sort(), ["labels", "summary"], "only what was authorized is sent");
  assert.equal(after.status, "sent");
  assert.equal(after.steps.at(-1)?.name, "update_fields");
});

test("a field nobody allowed cannot be smuggled into an update", () => {
  assert.throws(() => intent({ operation: "update_fields", fields: { assignee: "someone" } as never }));
  assert.throws(() => intent({ operation: "update_fields", fields: {} as never }), /at least one field/);
});

test("update_fields without fields, and other operations with them, are refused", () => {
  assert.throws(() => intent({ operation: "update_fields" }), /which fields/);
  assert.throws(() => intent({ operation: "add_comment", fields: { summary: "x" } }), /Only update_fields/);
});

test("a transition discovers the valid id rather than sending a status name", async () => {
  const seen: { url: string; method: string; body?: unknown }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ transitions: [
        { id: "11", name: "Start", to: { name: "In Progress" } },
        { id: "31", name: "Finish", to: { name: "Done" } },
      ] }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };

  const action = authorize(intent({ operation: "transition_issue" }), "s.patel", ["admin"]);
  const after = await restDelivery(SITE, fake).send(action);

  assert.equal(seen[0]?.method, "GET");
  assert.equal(seen[0]?.url, `${ORIGIN}/rest/api/3/issue/KAN-3/transitions`);
  assert.deepEqual((seen[1]?.body as { transition: { id: string } }).transition, { id: "11" }, "the discovered id, not the name");
  assert.equal(after.status, "sent");
  assert.deepEqual(after.steps.map((item) => item.name), ["discover_transition", "transition_issue"]);
});

test("a status with no valid transition is refused and names what is available", async () => {
  const fake: typeof fetch = async () => new Response(JSON.stringify({ transitions: [{ id: "31", to: { name: "Done" } }] }), { status: 200 });
  const action = authorize(intent({ operation: "transition_issue", status: "Blocked" }), "s.patel", ["admin"]);
  const after = await restDelivery(SITE, fake).send(action);
  assert.equal(after.status, "failed");
  assert.match(after.lastError ?? "", /no transition to "Blocked"/);
  assert.match(after.lastError ?? "", /Done/, "the available ones are named so it is fixable");
});

test("a transition that fails after discovery keeps the discovery step", async () => {
  let calls = 0;
  const failing: typeof fetch = async (_url, init) => {
    calls++;
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ transitions: [{ id: "11", to: { name: "In Progress" } }] }), { status: 200 });
    }
    return new Response("boom", { status: 500 });
  };
  const action = authorize(intent({ operation: "transition_issue" }), "s.patel", ["admin"]);
  const first = await restDelivery(SITE, failing).send(action);

  assert.equal(first.status, "failed");
  assert.deepEqual(first.steps.map((item) => item.name), ["discover_transition"], "the completed step is kept");
  assert.equal(first.steps[0]?.detail, "11");

  // The retry reuses the discovered id instead of asking again.
  const before = calls;
  const succeeding: typeof fetch = async (_url, init) => {
    calls++;
    assert.notEqual(init?.method ?? "GET", "GET", "discovery must not be repeated");
    return new Response(null, { status: 204 });
  };
  const second = await restDelivery(SITE, succeeding).send({ ...first, status: "pending" });
  assert.equal(second.status, "sent");
  assert.equal(calls, before + 1, "exactly one request on the retry");
});

test("an unparseable answer is uncertain, not sent and not failed", async () => {
  const fake: typeof fetch = async () => new Response("<html>gateway</html>", { status: 200 });
  const action = authorize(intent({ operation: "create_issue", issueKey: null, action: "create_issue" }), "s.patel", ["admin"]);
  const after = await restDelivery(SITE, fake).send(action);
  assert.equal(after.status, "uncertain");
  assert.equal(after.evidence, undefined);
  assert.match(after.lastError ?? "", /could not parse/i);
});

test("an action authorized for one site is refused by another", async () => {
  let called = false;
  const fake: typeof fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  const action = authorize(intent(), "s.patel", ["admin"]);
  const elsewhere = restDelivery({ baseUrl: "https://other.atlassian.net", email: "a@b.test", apiToken: "s" }, fake);
  const after = await elsewhere.send(action);

  assert.equal(called, false, "a destination change must stop the request before it leaves");
  assert.equal(after.status, "failed");
  assert.match(after.lastError ?? "", /authorized for https:\/\/x\.atlassian\.net/);
});

test("every payload carries its correlation marker", async () => {
  const bodies: string[] = [];
  const fake: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ key: "KAN-1" }), { status: 201 }); };
  const action = authorize(intent({ operation: "create_issue", issueKey: null, action: "create_issue" }), "s.patel", ["admin"]);
  await restDelivery(SITE, fake).send(action);
  assert.match(bodies[0] ?? "", new RegExp(`magentic:${action.id}`), "the marker is how a lost confirmation gets resolved");
});

test("the token is never in a thrown error", async () => {
  const fake: typeof fetch = async () => new Response("no", { status: 401 });
  const action = authorize(intent(), "s.patel", ["admin"]);
  const after = await restDelivery({ baseUrl: ORIGIN, email: "a@b.test", apiToken: "tok_do_not_leak" }, fake).send(action);
  assert.match(after.lastError ?? "", /401/);
  assert.equal(after.lastError?.includes("tok_do_not_leak"), false);
  assert.ok(JiraError);
});
