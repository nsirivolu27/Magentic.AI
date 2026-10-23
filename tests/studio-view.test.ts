import assert from "node:assert/strict";
import test from "node:test";
import { memoryModelStudio, type StudioSnapshot } from "../workbench/studio/engine.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { emptyStudioUi, studioListPage, studioProjectPage } from "../workbench/studio-view.js";
import { assistantFlow, projectFlow } from "../workbench/flow-model.js";
import { eligibility, eventText, phaseReport, viewerOf } from "../workbench/studio-model.js";
import { attentionItems, homeView, navCounts } from "../workbench/home-view.js";
import { assistantDetailPage, assistantRows, assistantsListPage } from "../workbench/assistants-view.js";
import { activityPage, approvalDetailPage, approvalsQueuePage, evaluationDetailPage, evaluationsListPage } from "../workbench/review-views.js";
import { chatView, emptyChat } from "../workbench/chat-view.js";
import { memoryPipelines, DEFAULT_PIPELINE } from "../workbench/pipeline.js";
import { assistantGuards, studioAssistants } from "../workbench/assistant-resolver.js";
import { agenticUnits, runNodes, stageNodes } from "../workbench/units.js";
import { workflowPage } from "../workbench/workflow-view.js";

/**
 * The pages are pure functions of the workspace snapshot. These tests drive
 * a studio through its states and check what each page says at each one:
 * the phase it reports, the one action it offers, the reason it withholds
 * an action, and that nothing unapproved is ever offered for use.
 */

const W = "view-workspace";
const dataset = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify({ messages: [
  { role: "user", content: `Q${index}` }, { role: "assistant", content: `A${index}` },
] })).join("\n");

function snapshotWith(studio: StudioSnapshot, actor = "alex", roles: ("author" | "approver" | "admin")[] = ["author"]): WorkbenchSnapshot {
  return { studio, workspaceId: W, actor, roles, workflow: { ...DEFAULT_WORKFLOW, requiredApprovals: 2 }, canAuthor: roles.includes("author") || roles.includes("admin"),
    records: [], audit: [], demo: true, mcp: { agents: [], withheld: [] }, chat: { configured: true, provider: "ollama", model: "m" } };
}

/** A studio driven to each stage, so every page can be checked at every step. */
function fixtures() {
  const studio = memoryModelStudio({ now: () => "2026-09-25T12:00:00.000Z" });
  const exec = (actor: string, roles: ("author" | "approver" | "admin")[], command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  const empty = studio.snapshot(W);
  let s = exec("alex", ["author"], { action: "create_project", name: "Repo helper", recipeId: "coding-assistant", purpose: "Answer repo questions." });
  const defined = s;
  const project = s.projects[0]!;
  s = exec("alex", ["author"], { action: "register_dataset", projectId: project.id, name: "Pairs", source: { kind: "inline", text: dataset(60) + "\nnot json" } });
  s = exec("alex", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  const rejected = s;
  s = exec("alex", ["author"], { action: "register_dataset", projectId: project.id, name: "Clean pairs", source: { kind: "inline", text: dataset(12) } });
  s = exec("alex", ["author"], { action: "validate_dataset", datasetId: s.datasets[1]!.id });
  s = exec("alex", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[1]!.id, provider: "local-dev" });
  s = exec("alex", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  const running = s;
  s = exec("alex", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("alex", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  const failed = s;
  s = exec("alex", ["author"], { action: "register_dataset", projectId: project.id, name: "Full pairs", source: { kind: "inline", text: dataset(60) } });
  s = exec("alex", ["author"], { action: "validate_dataset", datasetId: s.datasets[2]!.id });
  s = exec("alex", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[2]!.id, provider: "local-dev" });
  s = exec("alex", ["author"], { action: "create_job", configId: s.configs[1]!.id });
  s = exec("alex", ["author"], { action: "record_job", jobId: s.jobs[1]!.id });
  s = exec("alex", ["author"], { action: "run_evaluation", jobId: s.jobs[1]!.id });
  const passed = s;
  s = exec("alex", ["author"], { action: "request_release", evaluationId: s.evaluations[1]!.id });
  const pending = s;
  const release = s.releases[0]!;
  s = exec("sam", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("jordan", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  const approved = s;
  s = exec("alex", ["author"], { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const live = s;
  s = exec("taylor", ["admin"], { action: "retire_release", releaseId: release.id, note: "Superseded." });
  const retired = s;
  return { empty, defined, rejected, running, failed, passed, pending, approved, live, retired, project, release };
}

test("phase reports distinguish complete, current, blocked, failed and not started", () => {
  const f = fixtures();
  const at = (studio: StudioSnapshot) => phaseReport(studio, f.project);
  assert.equal(at(f.defined).current, "data");
  assert.deepEqual(at(f.defined).states, { define: "complete", data: "current", train: "not-started", evaluate: "not-started", approve: "not-started", use: "not-started" });
  assert.equal(at(f.rejected).states.data, "failed");
  assert.match(at(f.rejected).blocking ?? "", /rejected: 1 of 61 records failed/);
  assert.equal(at(f.running).states.train, "current");
  assert.match(at(f.running).blocking ?? "", /running/);
  assert.equal(at(f.failed).states.evaluate, "failed");
  assert.match(at(f.failed).blocking ?? "", /coverage 24% \(needs 80%\)/);
  assert.equal(at(f.pending).current, "approve");
  assert.match(at(f.pending).blocking ?? "", /needs 2 more approvals/);
  assert.equal(at(f.approved).states.approve, "complete");
  assert.equal(at(f.approved).current, "use");
  assert.equal(at(f.live).states.use, "complete");
  assert.equal(at(f.retired).states.approve, "blocked", "a retired release does not count as approved");
  assert.match(at(f.retired).blocking ?? "", /retired/);
});

test("the project page offers one primary action and explains a withheld one", () => {
  const f = fixtures();
  const ui = emptyStudioUi();
  const page = (studio: StudioSnapshot, phase?: string, actor = "alex", roles: ("author" | "approver" | "admin")[] = ["author"]) => studioProjectPage(snapshotWith(studio, actor, roles), f.project.id, phase, ui);
  const data = page(f.rejected, "data");
  assert.match(data.body, /Failed\.<\/strong> Pairs was rejected/);
  assert.match(data.body, /1 issue block training/);
  assert.match(data.body, /Line numbers only/);
  assert.doesNotMatch(data.body, /Q0/, "record content never reaches the page");
  const train = page(f.defined, "train");
  assert.match(train.actions ?? "", /disabled title="Needs a validated dataset"/);
  const evaluate = page(f.failed, "evaluate");
  assert.match(evaluate.body, /Failed\.<\/strong> coverage 24%/);
  assert.match(evaluate.body, /A release cannot be requested from this evaluation/);
  assert.match(evaluate.actions ?? "", /Fix the data/);
  const approve = page(f.pending, "approve", "alex", ["author", "approver"]);
  assert.match(approve.actions ?? "", /disabled title="You requested this release, so someone else has to review it\."/);
  assert.match(page(f.pending, "approve").actions ?? "", /disabled title="Approvers and admins review releases\."/);
  const reviewer = page(f.pending, "approve", "sam", ["approver"]);
  assert.match(reviewer.actions ?? "", /Review release v1/);
  const use = page(f.approved, "use");
  assert.match(use.actions ?? "", /Create assistant/);
  assert.match(use.body, /Allowed tools/);
  const retired = page(f.retired, "use");
  assert.match(retired.actions ?? "", /disabled title="No approved release available"/);
  assert.match(retired.body, /Disabled/);
  // The graph is the navigation: every node links to its panel and the open one is marked.
  assert.match(use.body, /<ol class="graph[^>]*aria-label="Repo helper connections"/);
  assert.match(use.body, /class="node pending selected ready"><a href="#\/studio\/[^"]+\/use" aria-current="step"/);
  assert.match(page(f.live, "use").body, /class="node linked selected"><a href="#\/assistants\/[^"]+" aria-current="step"/);
  assert.doesNotMatch(use.body, /class="stepper"/);
  assert.match(use.actions ?? "", /Approved · v1/);
  assert.match(page(f.live, "use").actions ?? "", /Live · v1/);
  assert.match(page(f.pending, "approve").actions ?? "", /Waiting for review · v1/);
  assert.match(page(f.defined, "data").actions ?? "", /Needs data/);
});

test("the flow model draws each project as a chain whose states come from the records", () => {
  const f = fixtures();
  const states = (studio: StudioSnapshot) => projectFlow(studio, f.project).nodes.map((node) => `${node.id}:${node.state}`).join(" ");
  assert.equal(states(f.defined), "recipe:linked dataset:pending candidate:blocked evaluation:blocked release:blocked assistant:blocked tools:pending");
  assert.equal(states(f.rejected), "recipe:linked dataset:broken candidate:blocked evaluation:blocked release:blocked assistant:blocked tools:pending");
  assert.equal(states(f.running), "recipe:linked dataset:linked candidate:active evaluation:blocked release:blocked assistant:blocked tools:pending");
  assert.equal(states(f.failed), "recipe:linked dataset:linked candidate:linked evaluation:broken release:blocked assistant:blocked tools:pending");
  assert.equal(states(f.passed), "recipe:linked dataset:linked candidate:linked evaluation:linked release:pending assistant:blocked tools:pending");
  assert.equal(states(f.pending), "recipe:linked dataset:linked candidate:linked evaluation:linked release:active assistant:blocked tools:pending");
  assert.equal(states(f.approved), "recipe:linked dataset:linked candidate:linked evaluation:linked release:linked assistant:pending tools:pending");
  assert.equal(states(f.live), "recipe:linked dataset:linked candidate:linked evaluation:linked release:linked assistant:linked tools:linked");
  assert.equal(states(f.retired), "recipe:linked dataset:linked candidate:linked evaluation:linked release:blocked assistant:blocked tools:pending");
  const live = projectFlow(f.live, f.project).nodes;
  assert.equal(live.find((node) => node.id === "assistant")?.value, "Repo bot");
  assert.match(live.find((node) => node.id === "assistant")?.href ?? "", /#\/assistants\//);
  assert.equal(live.find((node) => node.id === "release")?.note, "2 of 2 signed");
  assert.equal(projectFlow(f.failed, f.project).nodes.find((node) => node.id === "evaluation")?.note, "1 of 4 metrics");
  // The assistant's own chain: release, itself, tools.
  const profile = f.retired.profiles[0]!;
  const chain = assistantFlow(f.retired, profile, f.retired.releases.find((release) => release.id === profile.releaseId));
  assert.deepEqual(chain.map((node) => `${node.id}:${node.state}`), ["release:broken", "assistant:blocked", "tools:pending"]);
});

test("the project list is a filterable list of chains", () => {
  const f = fixtures();
  const ui = emptyStudioUi();
  const list = studioListPage(snapshotWith(f.pending), ui);
  assert.match(list.body, /class="flow-row"/);
  assert.match(list.body, /class="graph compact"/);
  assert.match(list.body, /Waiting for review/);
  assert.match(list.body, /data-studio-filter="owner"/);
  ui.filters.owner = "nobody";
  assert.match(studioListPage(snapshotWith(f.pending), ui).body, /No projects match these filters/);
  ui.filters.owner = "";
  ui.filters.state = "blocked";
  assert.match(studioListPage(snapshotWith(f.failed), ui).body, /Blocked/);
  assert.match(studioListPage(snapshotWith(f.live), ui).body, /No projects match/);
});

test("workspace home lists what needs attention and links each item to its place", () => {
  const f = fixtures();
  const author = attentionItems(snapshotWith(f.failed));
  assert.deepEqual(author.map((item) => [item.tone, item.href]), [["bad", `#/studio/${f.project.id}/evaluate`]]);
  const reviewer = attentionItems(snapshotWith(f.pending, "sam", ["approver"]));
  assert.equal(reviewer.length, 1);
  assert.match(reviewer[0]!.title, /needs your approval/);
  assert.equal(reviewer[0]!.href, `#/approvals/${f.release.id}`);
  assert.equal(attentionItems(snapshotWith(f.pending)).length, 0, "the requester is not asked to approve their own release");
  const unassigned = attentionItems(snapshotWith(f.approved));
  assert.match(unassigned[0]!.title, /approved but not assigned/);
  assert.equal(navCounts(snapshotWith(f.pending, "sam", ["approver"])).approvals, 1);
  const html = homeView(snapshotWith(f.live));
  assert.match(html, /aria-label="Projects"/);
  assert.match(html, /class="graph compact"/);
  assert.doesNotMatch(html, /Getting started|class="checklist"/);
  assert.match(html, /Agentic units/);
  assert.match(html, /Repo bot/);
  assert.match(html, /Nothing needs your attention/);
  assert.match(homeView(snapshotWith(f.empty)), /Create a model project/);
});

test("assistants never offer an unapproved or retired release", () => {
  const f = fixtures();
  const rows = assistantRows(snapshotWith(f.live));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "workspace");
  assert.equal(rows[1]!.usable, true);
  const after = assistantRows(snapshotWith(f.retired));
  assert.equal(after[1]!.usable, false);
  assert.match(after[1]!.statusHtml, /Disabled/);
  const page = assistantDetailPage(snapshotWith(f.retired), after[1]!.id, "<div>chat</div>");
  assert.match(page.body, /Disabled\.<\/strong>/);
  assert.doesNotMatch(page.body, /<div>chat<\/div>/, "no chat for a disabled assistant");
  const livePage = assistantDetailPage(snapshotWith(f.live), after[1]!.id, "<div>chat</div>");
  assert.match(livePage.body, /aria-label="Chat"/);
  assert.match(livePage.body, /class="graph[^"]*" aria-label="Repo bot connections"/);
  assert.match(livePage.body, /list_approved_agents/);
  assert.match(assistantsListPage(snapshotWith(f.live)).body, /Allowed tools/);
  const locked = chatView({ configured: true, provider: "ollama", model: "m" }, { ...emptyChat(), profile: after[1]!.id }, [{ id: after[1]!.id, name: "Repo bot", release: "v1" }], { locked: true });
  assert.doesNotMatch(locked, /id="chat-profile"/, "the page chose the assistant; no picker");
});

test("evaluations lead with the outcome and list failed thresholds first", () => {
  const f = fixtures();
  const list = evaluationsListPage(snapshotWith(f.failed));
  assert.match(list.body, /Failed · 1 of 4/);
  assert.match(list.body, /Cannot request/);
  const detail = evaluationDetailPage(snapshotWith(f.failed), f.failed.evaluations[0]!.id);
  assert.match(detail.body, /Failed\.<\/strong> coverage 24%/);
  const firstRow = detail.body.indexOf("<tr class=\"fail\"");
  const firstPass = detail.body.indexOf("<tr class=\"pass\"");
  assert.ok(firstRow !== -1 && firstRow < firstPass, "failed rows come first");
  assert.match(detail.body, /no per example results/);
  assert.match(detail.actions ?? "", /Fix the data and rerun/);
  const passedDetail = evaluationDetailPage(snapshotWith(f.passed), f.passed.evaluations[1]!.id);
  assert.match(passedDetail.actions ?? "", /Request approval/);
});

test("the approval queue states eligibility and the decision page explains the change", () => {
  const f = fixtures();
  const queue = approvalsQueuePage(snapshotWith(f.pending, "sam", ["approver"]));
  assert.match(queue.body, /You can review/);
  assert.match(approvalsQueuePage(snapshotWith(f.pending, "alex", ["author", "approver"])).body, /someone else has to review it/);
  const detail = approvalDetailPage(snapshotWith(f.pending, "sam", ["approver"]), f.release.id, emptyStudioUi());
  assert.match(detail.body, /What is changing/);
  assert.match(detail.body, /first release/);
  assert.match(detail.body, /Approve release v1/);
  assert.match(detail.body, /After approval/);
  assert.match(detail.body, /Candidate versus baseline/);
  const requester = approvalDetailPage(snapshotWith(f.pending), f.release.id, emptyStudioUi());
  assert.doesNotMatch(requester.body, /data-studio-decision="approve_release"/);
  assert.equal(eligibility(f.release, viewerOf("alex", ["admin"])).canApprove, false, "an admin who requested it still cannot sign");
});

test("activity reads as sentences with state transitions", () => {
  const f = fixtures();
  const page = activityPage(snapshotWith(f.retired));
  assert.match(page.body, /retired release <strong>Repo helper<\/strong>/);
  assert.match(page.body, /<b>approved<\/b> → <b>retired<\/b>/);
  assert.match(page.body, /gave the final approval for release/);
  assert.match(page.body, /Technical/);
  const text = eventText(f.retired, f.retired.events.find((event) => event.action === "rejected" || event.entity === "dataset")!);
  assert.equal(text.object, "Repo helper");
  assert.match(text.href, /#\/studio\//);
  const filtered = activityPage(snapshotWith(f.retired), f.project.id);
  assert.match(filtered.title, /Repo helper/);
});

test("agentic units join assistants to the workflow stages they staff", () => {
  // A real studio, driven to a live assistant, so the binding runs through the real rules.
  const studio = memoryModelStudio({ now: () => "2026-09-25T12:00:00.000Z" });
  const exec = (actor: string, roles: ("author" | "approver" | "admin")[], command: Record<string, unknown>) => studio.execute(W, actor, roles, command, 2);
  let s = exec("alex", ["author"], { action: "create_project", name: "Repo helper", recipeId: "coding-assistant", purpose: "Answer repo questions." });
  const project = s.projects[0]!;
  s = exec("alex", ["author"], { action: "register_dataset", projectId: project.id, name: "Full pairs", source: { kind: "inline", text: dataset(60) } });
  s = exec("alex", ["author"], { action: "validate_dataset", datasetId: s.datasets[0]!.id });
  s = exec("alex", ["author"], { action: "configure_training", projectId: project.id, datasetId: s.datasets[0]!.id, provider: "local-dev" });
  s = exec("alex", ["author"], { action: "create_job", configId: s.configs[0]!.id });
  s = exec("alex", ["author"], { action: "record_job", jobId: s.jobs[0]!.id });
  s = exec("alex", ["author"], { action: "run_evaluation", jobId: s.jobs[0]!.id });
  s = exec("alex", ["author"], { action: "request_release", evaluationId: s.evaluations[0]!.id });
  const release = s.releases[0]!;
  s = exec("sam", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("jordan", ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  s = exec("alex", ["author"], { action: "assign_profile", name: "Repo bot", releaseId: release.id });
  const profile = s.profiles[0]!;
  const engine = memoryPipelines(assistantGuards(studioAssistants(studio)));
  engine.execute(W, "taylor", ["admin"], { action: "configure", expectedVersion: 1,
    config: { ...DEFAULT_PIPELINE, stages: DEFAULT_PIPELINE.stages.map((stage, index) => index === 1 ? { ...stage, assistantId: profile.id } : stage) } }, 2);
  const withWorkflow = (studioSnapshot: StudioSnapshot, actor = "alex", roles: ("author" | "approver" | "admin")[] = ["author"]): WorkbenchSnapshot =>
    ({ ...snapshotWith(studioSnapshot, actor, roles), pipelines: engine.snapshot(W) });
  const live = withWorkflow(s);
  const units = agenticUnits(live);
  assert.equal(units.length, 1);
  assert.equal(units[0]!.usable, true);
  assert.deepEqual(units[0]!.stages.map((stage) => stage.id), ["planning"]);
  const nodes = stageNodes(live);
  assert.equal(nodes.length, 7);
  assert.deepEqual(nodes.slice(0, 3).map((node) => `${node.id}:${node.state}:${node.value}`), ["intake:pending:Requirements agent", "planning:linked:Repo bot", "design:pending:Architecture agent"]);
  // Admins get the staffing form with only usable assistants; authors do not.
  const admin = workflowPage(withWorkflow(s, "taylor", ["admin"]), "planning");
  assert.match(admin.body, /<form id="workflow-stage" data-stage="planning"/);
  assert.match(admin.body, /<option value="[0-9a-f-]+" selected>Repo bot · v1 Repo helper<\/option>/);
  assert.doesNotMatch(workflowPage(live, "planning").body, /id="workflow-stage"/);
  // The assistant page lists the stage it staffs.
  const detail = assistantDetailPage(live, profile.id, "<div>chat</div>");
  assert.match(detail.body, /Workflow stages/);
  assert.match(detail.body, /href="#\/workflows\/planning"/);
  // A run reads as a chain of progress, and the assistant counts as working.
  engine.execute(W, "alex", ["author"], { action: "start", requestId: "11111111-1111-4111-8111-111111111111", title: "Ship", brief: "Do it." }, 2);
  const run = engine.snapshot(W).runs[0]!;
  assert.deepEqual(runNodes(run).slice(0, 2).map((node) => `${node.state}:${node.value}`), ["active:Working", "pending:Waiting"]);
  assert.match(workflowPage(withWorkflow(s), undefined).body, /aria-label="Ship progress"/);
  engine.execute(W, "alex", ["author"], { action: "complete", runId: run.id, expectedRevision: run.revision, note: "Captured the scope." }, 2);
  assert.equal(agenticUnits(withWorkflow(s))[0]!.working, 1, "the run moved to the stage Repo bot staffs");
  assert.equal(stageNodes(withWorkflow(s))[1]!.state, "active");
  // Retiring the release breaks the stage, and every page says so.
  const retired = exec("taylor", ["admin"], { action: "retire_release", releaseId: release.id, note: "Superseded." });
  const stale = withWorkflow(retired);
  assert.equal(stageNodes(stale)[1]!.state, "broken");
  const page = workflowPage(stale, "planning");
  assert.match(page.actions ?? "", /1 stage cannot run/);
  assert.match(page.body, /This stage cannot run\.<\/strong> The assistant is disabled\./);
  assert.match(homeView(stale), /A stage cannot run/);
  assert.throws(() => engine.execute(W, "alex", ["author"], { action: "start", requestId: "22222222-2222-4222-8222-222222222222", title: "Again", brief: "Try." }, 2), /Stage "Planning"/);
});
