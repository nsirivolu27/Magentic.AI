import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { AgentDefinition } from "../catalog/schema.js";
import { memoryAudit } from "../registry/audit.js";
import { loadRegistryCatalog } from "../registry/catalog.js";
import { isServable } from "../registry/record.js";
import { memoryMembers, PermissionError } from "../registry/roles.js";
import { resolveCatalog, resolveWorkflow } from "../registry/source.js";
import { fileStore, memoryStore, TRANSITIONS } from "../registry/store.js";
import { approve, authorDraft, requestChanges, retire, submit, type TransitionContext } from "../registry/transition.js";
import { DEFAULT_WORKFLOW, loadWorkflow, workflowSchema, type Workflow } from "../registry/workflow.js";

const definition: AgentDefinition = {
  name: "reader",
  title: "Reader",
  description: "Reads conversations.",
  category: "general",
  version: "1.0.0",
  tools: ["list_conversations"],
  optionalTools: [],
  scopes: ["read"],
  instructions: "Read only.",
  publisher: "magentic",
};
const input = { workspaceId: "agency-a", name: definition.name };

function context(workflow: Workflow = DEFAULT_WORKFLOW): TransitionContext {
  return { store: memoryStore(), audit: memoryAudit(), workflow };
}

async function review(ctx: TransitionContext): Promise<void> {
  await authorDraft(ctx, { workspaceId: input.workspaceId, definition, actor: "writer" });
  await submit(ctx, { ...input, actor: "writer" });
}

test("the default workflow preserves every transition and action role", () => {
  assert.deepEqual(loadWorkflow(DEFAULT_WORKFLOW), DEFAULT_WORKFLOW);
  assert.deepEqual(DEFAULT_WORKFLOW.states, ["draft", "review", "approved", "retired"]);
  assert.deepEqual(DEFAULT_WORKFLOW.transitions, {
    draft: ["review"], review: ["draft", "approved"], approved: ["retired"], retired: [],
  });
  assert.deepEqual(DEFAULT_WORKFLOW.transitions, TRANSITIONS);
  assert.deepEqual(DEFAULT_WORKFLOW.roles, {
    author: "author", submit: "author", approve: "approver", "request-changes": "approver", retire: "approver",
  });
  assert.equal(DEFAULT_WORKFLOW.requiredApprovals, 1);
  assert.strictEqual(resolveWorkflow({}), DEFAULT_WORKFLOW);
});

test("two approvals withhold one signature and count distinct people on current content", async () => {
  const workflow = loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 });
  const ctx = context(workflow);
  await review(ctx);
  const one = await approve(ctx, { ...input, actor: "reviewer-1" });
  assert.equal(isServable(one, workflow), false);
  assert.equal(isServable({ ...one, approvals: [...one.approvals, ...one.approvals] }, workflow), false);
  const catalog = await loadRegistryCatalog(ctx.store, input.workspaceId, {
    allowWrites: false, workflow, requiredApprovals: 1, known: definition.tools,
  });
  assert.equal(catalog.entries.length, 0);
  assert.equal(catalog.withheld[0]?.reason, "approvals-stale");

  const two = await approve(ctx, { ...input, actor: "reviewer-2" });
  assert.equal(isServable(two, workflow), true);
  assert.equal(isServable({ ...two, definition: { ...definition, instructions: "Changed." } }, workflow), false);
  assert.equal(isServable({ ...two, status: "review" }, workflow), false);
});

test("undeclared transition destinations and sources fail at load with the field named", () => {
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW,
    states: ["draft", "approved"],
    transitions: { draft: ["review"] },
  }), /transitions\.draft\.0: State review is not declared/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW,
    states: ["draft", "approved"],
    transitions: { review: ["approved"] },
  }), /transitions\.review: State review is not declared/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW, transitions: { draft: ["missing"] },
  }), /transitions\.draft\.0/);
});

test("unknown keys are rejected at every config level", () => {
  assert.equal(workflowSchema.safeParse({ ...DEFAULT_WORKFLOW, surprise: true }).success, false);
  assert.throws(() => loadWorkflow({ ...DEFAULT_WORKFLOW, surprise: true }), /surprise/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW, roles: { ...DEFAULT_WORKFLOW.roles, bypass: "author" },
  }), /roles:.*bypass/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW, transitions: { ...DEFAULT_WORKFLOW.transitions, missing: [] },
  }), /transitions:.*missing/);
  assert.throws(() => loadWorkflow({ ...DEFAULT_WORKFLOW, allowSelfApproval: true }), /allowSelfApproval/);
});

test("required approvals are whole numbers from one to ten", () => {
  for (const requiredApprovals of [0, -1, 1.5, 11, "2", NaN]) {
    assert.throws(() => loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals }), /requiredApprovals/);
  }
  assert.equal(loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 10 }).requiredApprovals, 10);
});

test("legacy numeric callers cannot serve an unsigned record with an invalid count", async () => {
  const ctx = context();
  await review(ctx);
  const approved = await approve(ctx, { ...input, actor: "reviewer" });
  for (const count of [0, -1, 1.5, NaN]) {
    assert.equal(isServable({ ...approved, approvals: [] }, count), false);
  }
});

test("duplicate states, duplicate destinations and unknown roles fail at load", () => {
  assert.throws(() => loadWorkflow({ ...DEFAULT_WORKFLOW, states: [...DEFAULT_WORKFLOW.states, "draft"] }), /states/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW, transitions: { draft: ["review", "review"] },
  }), /transitions\.draft/);
  assert.throws(() => loadWorkflow({
    ...DEFAULT_WORKFLOW, roles: { ...DEFAULT_WORKFLOW.roles, approve: "anyone" },
  }), /roles\.approve/);
});

test("a workflow can disable submission and approval without writing a record or audit event", async () => {
  const ctx = context(loadWorkflow({ ...DEFAULT_WORKFLOW, transitions: {} }));
  await authorDraft(ctx, { workspaceId: input.workspaceId, definition, actor: "writer" });
  await assert.rejects(() => submit(ctx, { ...input, actor: "writer" }), /can only move to: nothing/);
  await assert.rejects(() => approve(ctx, { ...input, actor: "reviewer" }), /can only move to: nothing/);
  assert.equal((await ctx.store.get(input.workspaceId, input.name))?.status, "draft");
  assert.equal((await ctx.audit.list(input.workspaceId)).length, 1);
});

test("a workflow can add an approval transition without allowing self approval", async () => {
  const workflow = loadWorkflow({ ...DEFAULT_WORKFLOW, transitions: { draft: ["approved"] } });
  const ctx = context(workflow);
  await authorDraft(ctx, { workspaceId: input.workspaceId, definition, actor: "writer" });
  await assert.rejects(() => approve(ctx, { ...input, actor: "writer" }), /cannot also approve/);
  const approved = await approve(ctx, { ...input, actor: "reviewer" });
  assert.equal(isServable(approved, workflow), true);
});

test("configured signing roles cannot bypass the self approval flag", async () => {
  const workflow = loadWorkflow({
    ...DEFAULT_WORKFLOW, roles: { ...DEFAULT_WORKFLOW.roles, approve: "author" },
  });
  const ctx = context(workflow);
  ctx.members = memoryMembers([
    { workspaceId: input.workspaceId, actor: "writer", roles: ["author"] },
    { workspaceId: input.workspaceId, actor: "other-writer", roles: ["author"] },
  ]);
  await review(ctx);
  await assert.rejects(() => approve(ctx, { ...input, actor: "writer" }), /cannot also approve/);
  await approve(ctx, { ...input, actor: "other-writer" });
  ctx.allowSelfApproval = true;
  await approve(ctx, { ...input, actor: "writer" });
});

test("configured roles apply to every action and to additional signatures", async () => {
  const workflow = loadWorkflow({
    ...DEFAULT_WORKFLOW,
    roles: { author: "admin", submit: "admin", approve: "admin", "request-changes": "admin", retire: "admin" },
  });
  const ctx = context(workflow);
  ctx.members = memoryMembers([
    { workspaceId: input.workspaceId, actor: "writer", roles: ["admin"] },
    { workspaceId: input.workspaceId, actor: "reviewer", roles: ["approver", "author"] },
    { workspaceId: input.workspaceId, actor: "admin-reviewer", roles: ["admin"] },
  ]);
  await assert.rejects(() => authorDraft(ctx, {
    workspaceId: input.workspaceId, definition, actor: "reviewer",
  }), PermissionError);
  await authorDraft(ctx, { workspaceId: input.workspaceId, definition, actor: "writer" });
  await assert.rejects(() => submit(ctx, { ...input, actor: "reviewer" }), PermissionError);
  await submit(ctx, { ...input, actor: "writer" });
  await assert.rejects(() => requestChanges(ctx, { ...input, actor: "reviewer" }), PermissionError);
  await assert.rejects(() => approve(ctx, { ...input, actor: "reviewer" }), PermissionError);
  await approve(ctx, { ...input, actor: "admin-reviewer" });
  await assert.rejects(() => approve(ctx, { ...input, actor: "reviewer" }), PermissionError);
  await assert.rejects(() => retire(ctx, { ...input, actor: "reviewer" }), PermissionError);
  await retire(ctx, { ...input, actor: "admin-reviewer" });
});

test("reopening an approved record drops signatures before it can be edited", async () => {
  const workflow = loadWorkflow({
    ...DEFAULT_WORKFLOW, transitions: { ...DEFAULT_WORKFLOW.transitions, approved: ["draft"] },
  });
  const ctx = context(workflow);
  await review(ctx);
  await approve(ctx, { ...input, actor: "reviewer" });
  const draft = await requestChanges(ctx, { ...input, actor: "reviewer" });
  assert.deepEqual(draft.approvals, []);
  const edited = await authorDraft(ctx, {
    workspaceId: input.workspaceId, definition: { ...definition, instructions: "Changed." }, actor: "writer",
  });
  assert.equal(isServable(edited, workflow), false);
});

test("startup loads the workspace workflow and its threshold takes precedence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "workflow.json");
  const workflow = loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 });
  writeFileSync(path, JSON.stringify(workflow));
  const ctx = context(workflow);
  ctx.store = fileStore(directory);
  await review(ctx);
  await approve(ctx, { ...input, actor: "reviewer-1" });
  const env = {
    MAGENTIC_REGISTRY_DIR: directory,
    MAGENTIC_WORKSPACE: input.workspaceId,
    MAGENTIC_WORKFLOW_FILE: relative(process.cwd(), path),
    MAGENTIC_REQUIRED_APPROVALS: "1",
  };
  const resolved = await resolveCatalog(import.meta.url, false, env);
  assert.deepEqual(resolved.workflow, workflow);
  assert.equal(resolved.catalog?.entries.length, 0);
  assert.equal(resolved.withheld[0]?.reason, "approvals-stale");
  await approve(ctx, { ...input, actor: "reviewer-2" });
  assert.equal((await resolveCatalog(import.meta.url, false, env)).catalog?.entries.length, 1);
  assert.equal(resolveWorkflow({ MAGENTIC_REQUIRED_APPROVALS: "2" }).requiredApprovals, 2);
});

test("different workspace loads keep their policies separate", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-workspaces-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  writeFileSync(first, JSON.stringify({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 }));
  writeFileSync(second, JSON.stringify({ ...DEFAULT_WORKFLOW, requiredApprovals: 3 }));
  assert.equal(resolveWorkflow({ MAGENTIC_WORKFLOW_FILE: first }).requiredApprovals, 2);
  assert.equal(resolveWorkflow({ MAGENTIC_WORKFLOW_FILE: second }).requiredApprovals, 3);
  assert.equal(DEFAULT_WORKFLOW.requiredApprovals, 1);
});

test("file mode still ignores the legacy registry threshold", async () => {
  const resolved = await resolveCatalog(import.meta.url, false, { MAGENTIC_REQUIRED_APPROVALS: "unused" });
  assert.equal(resolved.mode, "files");
});

test("invalid workflow files fail at startup with the setting and field named", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "magentic-invalid-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "workflow.json");
  const env = { MAGENTIC_WORKFLOW_FILE: path };
  assert.throws(() => resolveWorkflow(env), /MAGENTIC_WORKFLOW_FILE.*workflow\.json/);
  writeFileSync(path, "{broken");
  await assert.rejects(() => resolveCatalog(import.meta.url, false, env), /MAGENTIC_WORKFLOW_FILE/);
  writeFileSync(path, JSON.stringify({ ...DEFAULT_WORKFLOW, requiredApprovals: 0 }));
  await assert.rejects(() => resolveCatalog(import.meta.url, false, env), /MAGENTIC_WORKFLOW_FILE.*requiredApprovals/);
});
