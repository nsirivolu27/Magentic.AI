import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers, type MemberDirectory } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "../workbench/server.js";
import { memoryEmail, invitationSchema } from "../workbench/email.js";
import { emailView } from "../workbench/email-view.js";

const definition = { name: "reader", title: "Reader", description: "Read conversations.", version: "1.0.0", tools: ["list_conversations"], instructions: "Read only." };

async function fixture(t: TestContext, failMail = false) {
  const directory = memoryMembers([
    { workspaceId: "one", actor: "writer", roles: ["author"] },
    { workspaceId: "one", actor: "reviewer", roles: ["approver"] },
    { workspaceId: "one", actor: "second", roles: ["approver"] },
    { workspaceId: "one", actor: "admin", roles: ["admin"] },
    { workspaceId: "two", actor: "outsider", roles: ["admin"] },
  ]);
  const members: MemberDirectory = { async rolesFor(workspaceId, actor) {
    if (failMail && actor === "broken-contact") throw new Error("Directory unavailable.");
    return directory.rolesFor(workspaceId, actor);
  } };
  const context = { store: memoryStore(), audit: memoryAudit(), members, workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 } };
  const email = memoryEmail(["writer", "reviewer", "second", "admin", "broken-contact"].map((actor) => ({
    workspaceId: "one", actor, email: `${actor}@example.test`,
  })));
  const server = createWorkbenchServer({ context, email, assets: new Map(), authenticate: async (request) => {
    const actor = request.headers.authorization?.replace("Bearer ", "");
    return actor ? { workspaceId: actor === "outsider" ? "two" : "one", actor } : undefined;
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(actor: string, path = "/api/workspace", data?: unknown) {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function draft() {
    await request("writer", "/api/records", { definition });
    return (await request("writer")).data.records[0].hash as string;
  }
  return { request, context, email, draft };
}

test("review requests route to current approvers without exposing another workspace", async (t) => {
  const { request, draft } = await fixture(t);
  const expectedHash = await draft();
  await request("writer", "/api/records/reader/submit", { expectedHash });
  const mailbox = (await request("reviewer")).data.mail;
  assert.equal(mailbox.delivery, "preview");
  assert.equal(mailbox.messages.length, 1);
  assert.equal(mailbox.messages[0].recipient, "reviewer@example.test");
  assert.equal(mailbox.messages[0].definitionHash, expectedHash);
  assert.equal(mailbox.messages[0].status, "preview");
  assert.equal((await request("writer")).data.mail.messages.filter((message: { recipientActor: string }) => message.recipientActor === "writer").length, 0);
  assert.deepEqual((await request("outsider")).data.mail.messages, []);
  assert.equal((await request("unknown")).status, 403);
});

test("approval mail distinguishes one signature from meeting the threshold", async (t) => {
  const { request, draft } = await fixture(t);
  const expectedHash = await draft();
  await request("writer", "/api/records/reader/submit", { expectedHash });
  await request("reviewer", "/api/records/reader/approve", { expectedHash });
  let mail = (await request("writer")).data.mail.messages[0];
  assert.match(mail.subject, /Approval recorded/);
  assert.match(mail.text, /1 of 2/);
  assert.match(mail.text, /not yet eligible/);
  await request("second", "/api/records/reader/approve", { expectedHash });
  mail = (await request("writer")).data.mail.messages[0];
  assert.match(mail.subject, /Approval complete/);
  assert.match(mail.text, /2 of 2/);
  assert.match(mail.text, /next MCP catalog load/);
  const count = (await request("admin")).data.mail.messages.length;
  assert.equal((await request("second", "/api/records/reader/approve", { expectedHash })).status, 409);
  assert.equal((await request("admin")).data.mail.messages.length, count);
});

test("invitation drafts are admin-only, validated, deduplicated and do not grant access", async (t) => {
  const { request, context } = await fixture(t);
  const input = { email: "NEW@example.test", role: "approver" };
  assert.equal((await request("writer", "/api/email/invitations", input)).status, 403);
  assert.equal((await request("admin", "/api/email/invitations", { ...input, email: "not-an-email" })).status, 400);
  assert.equal((await request("admin", "/api/email/invitations", { ...input, actor: "outsider" })).status, 400);
  assert.equal((await request("admin", "/api/email/invitations", { ...input, role: "admin" })).status, 400);
  const created = await request("admin", "/api/email/invitations", input);
  assert.equal(created.status, 200);
  assert.equal(created.data.recipient, "new@example.test");
  assert.equal(created.data.status, "preview");
  assert.deepEqual(await context.members.rolesFor("one", "new@example.test"), []);
  assert.equal((await request("admin", "/api/email/invitations", { ...input, email: "new@example.test" })).status, 409);
  assert.equal((await request("outsider", `/api/email/${created.data.id}/cancel`, {})).status, 404);
  assert.equal((await request("reviewer", `/api/email/${created.data.id}/cancel`, {})).status, 403);
  assert.equal((await request("admin", `/api/email/${created.data.id}/cancel`, {})).status, 200);
  assert.equal((await request("admin", "/api/email/invitations", input)).status, 200);
});

test("notification preferences belong to the actor and affect only future mail", async (t) => {
  const { request, draft } = await fixture(t);
  await request("reviewer", "/api/email/preferences", { reviews: false, updates: true });
  assert.equal((await request("reviewer", "/api/email/preferences", { reviews: false, updates: true, actor: "second" })).status, 400);
  const expectedHash = await draft();
  await request("writer", "/api/records/reader/submit", { expectedHash });
  assert.deepEqual((await request("reviewer")).data.mail.messages, []);
  assert.equal((await request("second")).data.mail.messages.length, 1);
  await request("second", "/api/email/preferences", { reviews: false, updates: false });
  assert.equal((await request("second")).data.mail.messages.length, 1);
  assert.deepEqual((await request("writer")).data.mail.preferences, { reviews: true, updates: true });
});

test("only a recipient can mark their preview viewed", async (t) => {
  const { request, draft } = await fixture(t);
  const expectedHash = await draft();
  await request("writer", "/api/records/reader/submit", { expectedHash });
  const message = (await request("reviewer")).data.mail.messages[0];
  assert.equal((await request("writer", `/api/email/${message.id}/viewed`, {})).status, 404);
  assert.equal((await request("admin", `/api/email/${message.id}/viewed`, {})).status, 404);
  assert.equal((await request("reviewer", `/api/email/${message.id}/viewed`, {})).status, 200);
  assert.equal((await request("reviewer")).data.mail.messages[0].viewed, true);
});

test("notification failure leaves a successful transition saved and returns a warning", async (t) => {
  const { request, draft, context } = await fixture(t, true);
  const expectedHash = await draft();
  const result = await request("writer", "/api/records/reader/submit", { expectedHash });
  assert.equal(result.status, 200);
  assert.match(result.data.emailWarning, /action was saved/);
  assert.equal((await context.store.get("one", "reader"))?.status, "review");
  assert.equal((await context.audit.list("one")).length, 2);
  assert.deepEqual((await request("admin")).data.mail.messages, []);
});

test("replaying an event does not duplicate notification previews", async (t) => {
  const { request, draft, context, email } = await fixture(t);
  const expectedHash = await draft();
  await request("writer", "/api/records/reader/submit", { expectedHash });
  const event = (await context.audit.list("one"))[1]!;
  const record = (await context.store.get("one", "reader"))!;
  await email.capture(event, record, context.members, context.workflow);
  assert.equal(email.mailbox("one", "admin", true).messages.length, 3);
});

test("email previews escape user text and reject invalid invitation fields", () => {
  const email = memoryEmail();
  const message = email.invite("one", "admin", { email: "person@example.test", role: "author", note: '<img src=x onerror="alert(1)">' });
  const markup = emailView(email.mailbox("one", "admin", true), "admin", "invitations", "", message.id);
  assert.ok(markup.includes("&lt;img"));
  assert.ok(!markup.includes("<img"));
  assert.match(markup, /Preview · not sent/);
  assert.equal(invitationSchema.safeParse({ email: "x@example.test\r\nBcc: other@example.test", role: "author" }).success, false);
});
