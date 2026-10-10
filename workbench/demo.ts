import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setting } from "../env.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { authorDraft, submit, approve } from "../registry/transition.js";
import { loadWorkflow, DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { createWorkbenchServer } from "./server.js";
import { chatConfiguration } from "./chat-config.js";
import { memoryPipelines } from "./pipeline.js";
import { memoryEmail } from "./email.js";
import { memoryModelStudio } from "./studio/engine.js";
import { assistantGuards, studioAssistants } from "./assistant-resolver.js";
import { chatModelLoader, createScheduler } from "./scheduler.js";
import { createLearningSchedule } from "./learning-schedule.js";
import { createDocuments, memoryDocumentStore } from "./documents.js";
import { applyWorkflowTemplate } from "./workflow-templates.js";

const workspaceId = "demo-workspace";
const actors = ["alex.writer", "sam.reviewer", "jordan.reviewer", "taylor.admin"];
const context = {
  store: memoryStore(), audit: memoryAudit(),
  members: memoryMembers(actors.map((actor, index) => ({ workspaceId, actor, roles: index === 0 ? ["author"] : index === 3 ? ["admin"] : ["approver"] }))),
  workflow: loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 }),
};

for (const [index, title] of ["Research assistant", "Case intake", "Knowledge curator", "Reference reader"].entries()) {
  const name = title.toLowerCase().replaceAll(" ", "-");
  await authorDraft(context, { workspaceId, actor: actors[0]!, definition: {
    name, title, description: ["Find relevant conversations and cite the original source.", "Summarize an incoming case before a person reviews it.", "Organize existing knowledge into a clear reading list.", "Read a reviewed reference definition from the MCP catalog."][index]!,
    category: "knowledge", version: "1.0.0", tools: ["list_conversations"], optionalTools: [], scopes: ["read"],
    instructions: "Read relevant conversations. Cite your sources. Ask for clarification when evidence is missing. Do not change any records.", publisher: "demo-workspace",
  } });
  if (index < 2 || index === 3) await submit(context, { workspaceId, name, actor: actors[0]! });
  if (index === 0 || index === 3) await approve(context, { workspaceId, name, actor: actors[1]! });
  if (index === 3) await approve(context, { workspaceId, name, actor: actors[2]! });
}

const email = memoryEmail(actors.map((actor) => ({ workspaceId, actor, email: `${actor}@example.test` })));
for (const event of await context.audit.list(workspaceId)) {
  const record = await context.store.get(workspaceId, event.agentName);
  if (record) await email.capture(event, record, context.members, context.workflow);
}
email.invite(workspaceId, "taylor.admin", { email: "casey@example.test", role: "approver", note: "Help the team review agents before they become available." });

// A Model Studio project part way through the flow, so the studio opens
// with something to look at. Sample records only; the dataset is synthetic.
const studio = memoryModelStudio();
const seeded = studio.execute(workspaceId, actors[0]!, ["author"], { action: "create_project", name: "Helpdesk assistant", recipeId: "it-support",
  purpose: "Answer common workstation and access questions from the internal helpdesk." }, context.workflow.requiredApprovals);
const sample = Array.from({ length: 120 }, (_, index) => JSON.stringify({ messages: [
  { role: "user", content: `Sample request ${index + 1}: I cannot reach the shared drive from my laptop.` },
  { role: "assistant", content: "Check that you are on the office network or VPN, then reconnect the drive from File Explorer. If it still fails, share the error text and I will escalate." },
] })).join("\n");
const withDataset = studio.execute(workspaceId, actors[0]!, ["author"], { action: "register_dataset", projectId: seeded.projects[0]!.id, name: "Helpdesk transcripts (synthetic)",
  source: { kind: "inline", text: sample } }, context.workflow.requiredApprovals);
studio.execute(workspaceId, actors[0]!, ["author"], { action: "validate_dataset", datasetId: withDataset.datasets[0]!.id }, context.workflow.requiredApprovals);
// A second project shows another kind of team: a consulting practice that
// delivers Salesforce work for federal agencies, training a delivery
// assistant on its own engagement notes (synthetic here; the agencies are
// fictional).
const agency = studio.execute(workspaceId, actors[0]!, ["author"], { action: "create_project", name: "Delivery assistant", recipeId: "salesforce-delivery",
  purpose: "Answer agency and delivery questions from our own implementation notes, in our wording, without inventing org configuration." }, context.workflow.requiredApprovals);
const engagements: [string, string, string][] = [
  ["Bureau of Grants Oversight", "grant inquiry cases from the public portal land in one national queue and miss the regional SLA",
    "Rebuilt case assignment on Region and Program, added a catch all queue with an SLA alert, and recorded the change as ATO evidence for the routing control."],
  ["Office of Benefits Review", "appeal records use two record types with different stage names, so reporting cannot roll up",
    "Aligned the stage picklist across both record types in the Government Cloud org and migrated open appeals with a data loader job run from the sandbox first."],
  ["Federal Fleet Agency", "regional coordinators cannot see vehicle incident cases owned by other regions",
    "Set Case sharing to public read only for the coordinator profile and added a region sharing rule; no PII field was exposed, confirmed with the ISSO."],
  ["Interagency Records Service", "duplicate contact records after the quarterly mailing list import",
    "Enabled duplicate rules on Contact with a matching rule on email and last name, merged existing pairs in batches, and logged the merge report for the records officer."],
  ["Bureau of Grants Oversight", "the reporting team wants case metrics in the agency data platform",
    "Scheduled a nightly export of case fields (no narrative text) to the agency's data platform through the approved integration user; the boundary review is on the next step list."],
];
const caseNotes = Array.from({ length: 80 }, (_, index) => {
  const [agencyName, ask, done] = engagements[index % engagements.length]!;
  return JSON.stringify({ messages: [
    { role: "user", content: `Agency: ${agencyName}. Ask ${index + 1}: ${ask}.` },
    { role: "assistant", content: `What we did: ${done} Next step: confirm with the agency program owner in the weekly call.` },
  ] });
}).join("\n");
const agencyData = studio.execute(workspaceId, actors[0]!, ["author"], { action: "register_dataset", projectId: agency.projects.find((project) => project.name === "Delivery assistant")!.id,
  name: "Engagement notes, Q3 (synthetic)", source: { kind: "inline", text: caseNotes } }, context.workflow.requiredApprovals);
studio.execute(workspaceId, actors[0]!, ["author"], { action: "validate_dataset", datasetId: agencyData.datasets.find((dataset) => dataset.name.startsWith("Engagement notes"))!.id }, context.workflow.requiredApprovals);
// The agency project is taken all the way to a live assistant, so the
// workflow, the scheduler and the editor extension have a worker to use
// from the first minute. Every step is the ordinary command with the
// ordinary rules: two distinct reviewers sign the release.
{
  const approvals = context.workflow.requiredApprovals;
  const run = (actor: string, roles: ("author" | "approver" | "admin")[], command: Record<string, unknown>) => studio.execute(workspaceId, actor, roles, command, approvals);
  const projectId = agency.projects.find((project) => project.name === "Delivery assistant")!.id;
  const datasetId = agencyData.datasets.find((dataset) => dataset.name.startsWith("Engagement notes"))!.id;
  let s = run(actors[0]!, ["author"], { action: "configure_training", projectId, datasetId, provider: "local-dev" });
  s = run(actors[0]!, ["author"], { action: "create_job", configId: s.configs.find((config) => config.datasetId === datasetId)!.id });
  const jobId = s.jobs.find((job) => job.projectId === projectId)!.id;
  s = run(actors[0]!, ["author"], { action: "record_job", jobId });
  s = run(actors[0]!, ["author"], { action: "run_evaluation", jobId });
  s = run(actors[0]!, ["author"], { action: "request_release", evaluationId: s.evaluations.find((evaluation) => evaluation.jobId === jobId)!.id });
  const release = s.releases.find((item) => item.projectId === projectId)!;
  run(actors[1]!, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  run(actors[2]!, ["approver"], { action: "approve_release", releaseId: release.id, expectedHash: release.contentHash });
  run(actors[0]!, ["author"], { action: "assign_profile", name: "Northwind Federal delivery bot", releaseId: release.id,
    instructions: "You are Northwind Federal's delivery assistant for Salesforce work at federal agencies. Answer the way our consultants write: name the agency and the org, say what we did in numbered steps, name the control or ATO evidence touched when a change affects one, and end with 'Next step:'. Never invent org configuration; ask for the org, the object and the requirement first. Never ask for, repeat or infer PII, credentials or agency data." });
}

const assets = new Map();
for (const [path, file, type] of [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/agency.css", "agency.css", "text/css; charset=utf-8"],
  ["/pipeline.css", "pipeline.css", "text/css; charset=utf-8"],
  ["/chat.css", "chat.css", "text/css; charset=utf-8"],
  ["/theme.css", "theme.css", "text/css; charset=utf-8"],
  ["/mcp.css", "mcp.css", "text/css; charset=utf-8"],
  ["/email.css", "email.css", "text/css; charset=utf-8"],
  ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
  ["/icon.svg", "icon.svg", "image/svg+xml"],
]) assets.set(path!, { type: type!, body: readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url))) });

// These public identities belong only to disposable sample data. This entry
// point cannot open a real registry or listen on a public interface.
const chat = chatConfiguration(true);
const assistants = studioAssistants(studio);
const pipelines = memoryPipelines(assistantGuards(assistants));
// The workspace opens on the practice's delivery workflow with the assistant
// already staffing Discovery and QA, so the first thing a visitor sees is
// the assistant at work. An admin applies the template and staffs it, under
// the same guard that refuses an assistant that cannot work.
{
  const bot = studio.snapshot(workspaceId).profiles.find((profile) => profile.name === "Northwind Federal delivery bot")!;
  const applied = applyWorkflowTemplate(pipelines, workspaceId, actors[3]!, ["admin"], "salesforce-agency", context.workflow.requiredApprovals);
  pipelines.execute(workspaceId, actors[3]!, ["admin"], { action: "configure", expectedVersion: applied.version, config: { ...applied.config,
    stages: applied.config.stages.map((stage) => stage.id === "discovery" || stage.id === "qa" ? { ...stage, assistantId: bot.id } : stage) } }, context.workflow.requiredApprovals);
}
// Assistants draft their stages in the background. Sample data only; no job survives a restart.
const scheduler = createScheduler({ pipelines, assistants, loadModel: chatModelLoader(chat) });
// Learning schedules in the demo work from registered content only; there is no import folder in memory mode.
const learning = createLearningSchedule({ studio, requiredApprovals: context.workflow.requiredApprovals });
learning.set(workspaceId, actors[0]!, ["author"], { projectId: studio.snapshot(workspaceId).projects.find((project) => project.name === "Delivery assistant")!.id, cadence: "weekly" });
setInterval(() => { try { learning.tick(workspaceId); } catch { /* recorded on the run */ } void scheduler.tick(workspaceId).catch(() => undefined); }, 20_000).unref();
// The documentation portal. One agency SOP is seeded so the first run can carry reference material.
const documents = createDocuments({ store: memoryDocumentStore(), studio, pipelines, requiredApprovals: context.workflow.requiredApprovals });
documents.execute(workspaceId, actors[0]!, ["author"], { action: "add_document", title: "Grant Inquiry Routing SOP (synthetic)", text: [
  "Grant Inquiry Routing SOP (v3). Fictional agency documentation for the sample workspace.",
  "1. Purpose. Portal inquiries must reach the regional team within one business day of submission.",
  "2. Regions. Northeast, Southeast, Central, Mountain, Pacific. Each region owns a queue named GI-<Region>.",
  "3. Programs. Research, Infrastructure, Community. The program is read from the portal form and never inferred from the message text.",
  "4. Catch all. An inquiry with no region or program goes to GI-Triage and pages the duty officer within the hour.",
  "5. Evidence. Every routing change is recorded as evidence for the access control before it is deployed to production.",
].join("\n\n") });
const server = createWorkbenchServer({ context, assets, email, pipelines, studio, scheduler, learning, documents, ...(chat ? { chat } : {}), demo: true, authenticate: async (request) => {
  const actor = request.headers.authorization?.replace(/^Bearer /, "");
  return actor && actors.includes(actor) ? { workspaceId, actor } : undefined;
} });
const desktop = process.argv.includes("--desktop") && !!process.send;
const port = desktop ? 0 : Number(setting("MAGENTIC_WORKBENCH_PORT") ?? "4173");
if (!desktop && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("MAGENTIC_WORKBENCH_PORT must be 1–65535.");
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local server has no TCP address.");
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`Magentic Developer: ${url} (sample data only)`);
  if (desktop) process.send!({ url });
});
if (desktop) process.once("disconnect", () => {
  server.close(); server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close());
