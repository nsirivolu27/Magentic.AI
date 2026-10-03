import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { memoryAudit } from "../registry/audit.js";
import { memoryStore } from "../registry/store.js";
import { memoryMembers } from "../registry/roles.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "../workbench/server.js";
import type { AgentModel, ChatEvent } from "../workbench/chat.js";
import { fileModelStudio, memoryModelStudio, type ModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";

/**
 * The last step of the slice: a chatbot profile answering in the existing
 * chat layer, and the server refusing profiles whose release is not fit to
 * answer. The model is scripted, so what is asserted is what reached it.
 */

const W = "one";

function records(count: number): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [
    { role: "user", content: `Question ${index}` }, { role: "assistant", content: `Answer ${index}` },
  ] })).join("\n");
}

async function fixture(t: TestContext, studio: ModelStudio = memoryModelStudio()) {
  const prompts: string[] = [];
  const model: AgentModel = { async invoke(prompt) { prompts.push(prompt); return { content: JSON.stringify({ type: "answer", content: "Hello from the profile." }) }; } };
  const context = {
    store: memoryStore(), audit: memoryAudit(), workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 },
    members: memoryMembers([
      { workspaceId: W, actor: "writer", roles: ["author"] },
      { workspaceId: W, actor: "reviewer", roles: ["approver"] },
      { workspaceId: W, actor: "second", roles: ["approver"] },
      { workspaceId: W, actor: "admin", roles: ["admin"] },
    ]),
  };
  const server = createWorkbenchServer({ context, assets: new Map(), studio,
    chat: { provider: "test", model: "test-model", loadModel: async () => model },
    authenticate: async (req) => {
      const actor = req.headers.authorization?.replace(/^Bearer /, "");
      return actor ? { workspaceId: W, actor } : undefined;
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (actor: string, path: string, data: unknown) => fetch(base + path, { method: "POST",
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const studioCommand = async (actor: string, data: unknown): Promise<StudioSnapshot> => {
    const response = await post(actor, "/api/studio", data);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as StudioSnapshot;
  };
  return { base, post, studioCommand, prompts, studio };
}

async function events(response: Response): Promise<ChatEvent[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChatEvent);
}

/** Drive the slice over HTTP as far as an approved release. */
async function approvedRelease(f: Awaited<ReturnType<typeof fixture>>) {
  let s = await f.studioCommand("writer", { action: "create_project", name: "Repo helper", recipeId: "coding-assistant", purpose: "Answer repo questions." });
  const project = s.projects[0]!;
  s = await f.studioCommand("writer", { action: "register_dataset", projectId: project.id, name: "Pairs", source: { kind: "inline", text: records(60) } });
  s = await f.studioCommand("writer", { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = await f.studioCommand("writer", { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = await f.studioCommand("writer", { action: "create_job", configId: s.configs[0]!.id });
  s = await f.studioCommand("writer", { action: "record_job", jobId: s.jobs[0]!.id });
  s = await f.studioCommand("writer", { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = await f.studioCommand("writer", { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = await f.studioCommand("reviewer", { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = await f.studioCommand("second", { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  assert.equal(s.releases[0]!.status, "approved");
  return { project, release: s.releases[0]! };
}

test("an approved profile answers through /api/chat and its instructions reach the model", async (t) => {
  const f = await fixture(t);
  const { release } = await approvedRelease(f);
  const s = await f.studioCommand("writer", { action: "assign_profile", name: "Repo bot", releaseId: release.id, instructions: "Always answer in one sentence." });
  const profile = s.profiles[0]!;

  const response = await f.post("writer", "/api/chat", { profile: profile.id, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(response.status, 200);
  const stream = await events(response);
  assert.deepEqual(stream.at(-1), { type: "answer", content: "Hello from the profile." });
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0]!, /You are "Repo bot"/);
  assert.match(f.prompts[0]!, /Repo helper v1 \(development artifact\)/, "the model is told this is a development artifact");
  assert.match(f.prompts[0]!, /Always answer in one sentence\./);
  assert.match(f.prompts[0]!, /grant no tools or permissions/);

  // Without a profile, the ordinary assistant answers as before.
  const plain = await f.post("writer", "/api/chat", { messages: [{ role: "user", content: "Hi" }] });
  assert.equal(plain.status, 200);
  await plain.text();
  assert.match(f.prompts[1]!, /You are Magentic/);
  assert.doesNotMatch(f.prompts[1]!, /Repo bot/);
});

test("the chat layer refuses profiles on unapproved, retired or missing releases", async (t) => {
  const f = await fixture(t);
  const { release } = await approvedRelease(f);
  let s = await f.studioCommand("writer", { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const profile = s.profiles[0]!;

  const missing = await f.post("writer", "/api/chat", { profile: "00000000-0000-4000-8000-000000000000", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(missing.status, 404);
  assert.match((await missing.json() as { error: string }).error, /not found/);

  s = await f.studioCommand("admin", { action: "retire_release", releaseId: release.id, note: "Replaced." });
  assert.equal(s.profiles[0]!.status, "disabled");
  const retired = await f.post("writer", "/api/chat", { profile: profile.id, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(retired.status, 409);
  assert.match((await retired.json() as { error: string }).error, /disabled/);
  assert.equal(f.prompts.length, 0, "no model call was made for a refused profile");

  // A pending release cannot be assigned at all, so no profile can point at one.
  const pending = await f.post("writer", "/api/studio", { action: "assign_profile", name: "Early", releaseId: release.id });
  assert.equal(pending.status, 409);
});

test("a studio file edited behind the server stops profiles from answering", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "studio-chat-"));
  const f = await fixture(t, fileModelStudio(directory, join(directory, "import")));
  const { release } = await approvedRelease(f);
  const s = await f.studioCommand("writer", { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const ok = await f.post("writer", "/api/chat", { profile: s.profiles[0]!.id, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(ok.status, 200);
  await ok.text();

  // Drop one signature on disk but leave the release marked approved.
  const path = join(directory, `${W}-${createHash("sha256").update(W).digest("hex").slice(0, 32)}.json`);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.releases[0].approvals.pop();
  writeFileSync(path, JSON.stringify(document));

  const refused = await f.post("writer", "/api/chat", { profile: s.profiles[0]!.id, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /integrity check/);
  assert.equal(f.prompts.length, 1, "the tampered profile never reached the model");
  // The rest of the workspace still loads; the studio's failure travels as a message.
  const workspace = await fetch(f.base + "/api/workspace", { headers: { Authorization: "Bearer writer" } });
  assert.equal(workspace.status, 200);
  const data = await workspace.json() as { studio?: unknown; studioError?: string };
  assert.equal(data.studio, undefined);
  assert.match(data.studioError ?? "", /not internally consistent/);
});

test("the workspace snapshot carries the studio and /api/studio enforces roles", async (t) => {
  const f = await fixture(t);
  const workspace = await fetch(f.base + "/api/workspace", { headers: { Authorization: "Bearer writer" } });
  const data = await workspace.json() as { studio: StudioSnapshot };
  assert.equal(data.studio.storage, "memory");
  assert.equal(data.studio.recipes.length, 6);
  assert.deepEqual(data.studio.providers.map((provider) => provider.id), ["local-dev"]);
  const refused = await f.post("reviewer", "/api/studio", { action: "create_project", name: "P", recipeId: "coding-assistant" });
  assert.equal(refused.status, 403);
  const invalid = await f.post("writer", "/api/studio", { action: "create_project", name: "P", recipeId: "nope" });
  assert.equal(invalid.status, 400);
});
