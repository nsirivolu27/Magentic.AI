import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "../catalog/schema.js";
import { memoryAudit } from "../registry/audit.js";
import { isServable, validApprovers } from "../registry/record.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers, PermissionError } from "../registry/roles.js";
import {
  approve, authorDraft, requestChanges, retire, submit,
  TransitionError, type TransitionContext,
} from "../registry/transition.js";

const WORKSPACE = "dos-consular";

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "records-intake",
    title: "Records intake",
    description: "Scopes a records request.",
    category: "records",
    version: "1.0.0",
    tools: ["list_conversations"],
    optionalTools: [],
    scopes: ["read"],
    instructions: "Scope a request. Change nothing.",
    publisher: "magentic",
    ...overrides,
  };
}

function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  let tick = 0;
  return {
    store: memoryStore(),
    audit: memoryAudit(),
    now: () => new Date(Date.UTC(2026, 8, 19, 0, 0, tick++)),
    ...overrides,
  };
}

async function toReview(ctx: TransitionContext, def = definition(), author = "a.rivera") {
  await authorDraft(ctx, { workspaceId: WORKSPACE, definition: def, actor: author });
  await submit(ctx, { workspaceId: WORKSPACE, name: def.name, actor: author });
}

test("a definition walks draft to review to approved", async () => {
  const ctx = context();
  await toReview(ctx);
  const approved = await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  assert.equal(approved.status, "approved");
  assert.deepEqual(validApprovers(approved), ["m.okafor"]);
  assert.equal(isServable(approved), true);
});

test("the author cannot approve their own definition", async () => {
  const ctx = context();
  await toReview(ctx);
  await assert.rejects(
    () => approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "a.rivera" }),
    (error: unknown) => error instanceof TransitionError && /cannot also approve/.test(error.message),
  );
});

test("self approval is possible only when a deployment turns it on", async () => {
  const ctx = context({ allowSelfApproval: true });
  await toReview(ctx);
  const approved = await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "a.rivera" });
  assert.equal(approved.status, "approved");
});

test("one approver cannot sign the same version twice", async () => {
  const ctx = context();
  await toReview(ctx);
  await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  await assert.rejects(
    () => approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" }),
    /already signed/,
  );
});

test("two approvers each add a signature", async () => {
  const ctx = context();
  await toReview(ctx);
  await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  const twice = await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "j.chen" });
  assert.deepEqual(validApprovers(twice), ["j.chen", "m.okafor"]);
  assert.equal(isServable(twice, 2), true);
});

test("an approved definition cannot be edited in place", async () => {
  const ctx = context();
  await toReview(ctx);
  await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  await assert.rejects(
    () => authorDraft(ctx, { workspaceId: WORKSPACE, definition: definition({ scopes: ["read", "write"] }), actor: "a.rivera" }),
    /cannot be edited in place/,
  );
});

test("sending a record back to draft drops its signatures", async () => {
  const ctx = context();
  await toReview(ctx);
  const back = await requestChanges(ctx, {
    workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor", note: "Narrow the scope.",
  });
  assert.equal(back.status, "draft");
  assert.deepEqual(back.approvals, [], "a signature is on a version someone has now been asked to change");
});

test("an approved record can be retired", async () => {
  const ctx = context();
  await toReview(ctx);
  await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  const gone = await retire(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  assert.equal(gone.status, "retired");
  assert.equal(isServable(gone), false, "retired is not served whatever signatures it kept");
});

test("illegal moves are refused and name what is allowed", async () => {
  const ctx = context();
  await authorDraft(ctx, { workspaceId: WORKSPACE, definition: definition(), actor: "a.rivera" });
  await assert.rejects(
    () => retire(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" }),
    /is draft and can only move to: review/,
  );
});

test("an unknown agent is refused rather than created", async () => {
  const ctx = context();
  await assert.rejects(
    () => submit(ctx, { workspaceId: WORKSPACE, name: "nope", actor: "a.rivera" }),
    /has no agent named/,
  );
});

test("every move leaves an audit event with the hash that was signed", async () => {
  const ctx = context();
  await toReview(ctx);
  await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor", note: "Read only." });

  const events = await ctx.audit.list(WORKSPACE);
  assert.deepEqual(events.map((event) => event.action), ["authored", "submitted", "approved"]);
  assert.deepEqual(events.map((event) => event.actor), ["a.rivera", "a.rivera", "m.okafor"]);
  assert.equal(events[2]?.note, "Read only.");
  for (const event of events) assert.match(event.definitionHash, /^[0-9a-f]{64}$/);
});

test("the audit log keeps events for a record that was removed", async () => {
  const ctx = context();
  await toReview(ctx);
  await ctx.store.remove(WORKSPACE, "records-intake");
  const events = await ctx.audit.list(WORKSPACE, "records-intake");
  assert.equal(events.length, 2, "what people did outlives the record they did it to");
});

test("a non-member cannot do anything", async () => {
  const ctx = context({ members: memoryMembers([{ workspaceId: WORKSPACE, actor: "a.rivera", roles: ["author"] }]) });
  await assert.rejects(
    () => authorDraft(ctx, { workspaceId: WORKSPACE, definition: definition(), actor: "stranger" }),
    (error: unknown) => error instanceof PermissionError && /not a member/.test(error.message),
  );
});

test("an author cannot approve, even a definition someone else wrote", async () => {
  const members = memoryMembers([
    { workspaceId: WORKSPACE, actor: "a.rivera", roles: ["author"] },
    { workspaceId: WORKSPACE, actor: "b.nguyen", roles: ["author"] },
  ]);
  const ctx = context({ members });
  await toReview(ctx);
  await assert.rejects(
    () => approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "b.nguyen" }),
    (error: unknown) => error instanceof PermissionError && /none of those may approve/.test(error.message),
  );
});

test("an approver signs, and an admin may do both", async () => {
  const members = memoryMembers([
    { workspaceId: WORKSPACE, actor: "a.rivera", roles: ["author"] },
    { workspaceId: WORKSPACE, actor: "m.okafor", roles: ["approver"] },
    { workspaceId: WORKSPACE, actor: "s.patel", roles: ["admin"] },
  ]);
  const ctx = context({ members });
  await toReview(ctx);
  const signed = await approve(ctx, { workspaceId: WORKSPACE, name: "records-intake", actor: "m.okafor" });
  assert.equal(signed.status, "approved");

  const second = context({ members });
  await authorDraft(second, { workspaceId: WORKSPACE, definition: definition(), actor: "s.patel" });
  await submit(second, { workspaceId: WORKSPACE, name: "records-intake", actor: "s.patel" });
});

test("roles are not checked when no directory is configured", async () => {
  const ctx = context();
  await authorDraft(ctx, { workspaceId: WORKSPACE, definition: definition(), actor: "anyone" });
  assert.ok(await ctx.store.get(WORKSPACE, "records-intake"), "personal mode keeps working");
});
