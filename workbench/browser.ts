import type { OntologyCatalog } from "./ontology.js";
import { formatTokens } from "./model-usage.js";
import type { RegistryRecord } from "../registry/record.js";
import type { AuditEvent } from "../registry/audit.js";
import type { Workflow } from "../registry/workflow.js";
import type { Role, Action } from "../registry/roles.js";
import type { Mailbox } from "./email.js";
import { emailView, type MailFolder } from "./email-view.js";

import type { McpOverview } from "./mcp-portal.js";
import { emptyInspector, mcpView, mcpRequest as sendMcpRequest, formatToolResult, type InspectorTool } from "./mcp-view.js";

import { chatView, emptyChat } from "./chat-view.js";
import type { ChatAvailability, ChatEvent } from "./chat.js";

import { botTimeline } from "./bot-view.js";
import { developmentAgentConfig } from "./bot-profiles.js";
import { BOT_REPOSITORY_TOOLS, type BotSnapshot, type BotPolicy } from "./bot-schema.js";
import { DEVELOPMENT_PLAYBOOKS, playbookBrief, type SessionDraft } from "./playbooks.js";
import type { SessionFilter } from "./desk-view.js";
import { workspaceView, workList, workProgress } from "./workspace-view.js";
import { materialsSchema, FEDERAL_SERVICE_STARTER, type Material } from "./materials.js";
import { jiraReviewView, jiraHistoryView, type JiraReview, type JiraHistory } from "./jira-view.js";
import { pipelineView } from "./pipeline-view.js";
import type { PipelineSnapshot, PipelineConfig } from "./pipeline.js";
import { emptyStudioUi, studioListPage, studioProjectPage, type Page, type StudioUi } from "./studio-view.js";
import { documentsPage } from "./documents-view.js";
import { activityPage, approvalDetailPage, approvalsQueuePage, evaluationDetailPage, evaluationsListPage } from "./review-views.js";
import { assistantDetailPage, assistantsListPage, WORKSPACE_ASSISTANT } from "./assistants-view.js";
import { homeView, navCounts } from "./home-view.js";
import { workflowPage } from "./workflow-view.js";
import { WORKFLOW_TEMPLATES } from "./workflow-templates.js";
import { hint, setHints } from "./ui.js";
import type { StudioSnapshot } from "./studio/engine.js";
import type { WorkbenchSnapshot } from "./snapshot.js";

type RecordView = WorkbenchSnapshot["records"][number];
type Snapshot = WorkbenchSnapshot;
const node = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const localMode = document.documentElement.dataset.mode === "local";
let selectedWorkspace = "";
let workspaceList: import("./workspace-directory.js").WorkspaceListing | undefined;
let workspaceRequestId = crypto.randomUUID();
let refreshVersion = 0;
let snapshot: Snapshot;
let filter = "all";
/**
 * Routing.
 *
 * The hash is the address of a place in the workspace: a page, and within
 * it a project, assistant, evaluation or release. Navigation writes the
 * hash; rendering reads it. Nothing else remembers where the user is, so
 * the back button, a reload and a pasted link all land in the same place.
 */
interface Route { view: string; id?: string; sub?: string; query: URLSearchParams }
const PRIMARY_VIEWS = ["workspace", "assistants", "workflows", "studio", "documents", "evaluations", "approvals", "activity"];
const LEGACY_VIEWS = ["desk", "pipelines", "agents", "email", "mcp", "workflow", "chat"];
function parseRoute(hash: string): Route {
  const [path, search = ""] = hash.replace(/^#\/?/, "").split("?");
  const [view = "workspace", id, sub] = path!.split("/").filter(Boolean);
  const query = new URLSearchParams(search);
  if (view === "chat") return { view: "assistants", id: WORKSPACE_ASSISTANT, query };
  if (!PRIMARY_VIEWS.includes(view) && !LEGACY_VIEWS.includes(view)) return { view: "workspace", query };
  return { view, ...(id ? { id } : {}), ...(sub ? { sub } : {}), query };
}
let route: Route = parseRoute(location.hash);
// Hints are off until this browser turns them on. The pages read on their own.
let hintsOn = false;
try { hintsOn = localStorage.getItem("magentic.hints") === "on"; } catch { /* storage blocked: hints stay off */ }
setHints(hintsOn);
const hintsSwitch = document.querySelector<HTMLInputElement>("#hints-switch");
if (hintsSwitch) {
  hintsSwitch.checked = hintsOn;
  hintsSwitch.addEventListener("change", () => {
    hintsOn = hintsSwitch.checked; setHints(hintsOn);
    try { localStorage.setItem("magentic.hints", hintsOn ? "on" : "off"); } catch { /* per browser convenience only */ }
    if (snapshot) render();
  });
}
/** The legacy pages still read a plain view name. */
let view = route.view;
function navigate(hash: string): void {
  if (location.hash === hash) { route = parseRoute(hash); view = route.view; render(); return; }
  location.hash = hash;
}
window.addEventListener("hashchange", () => {
  route = parseRoute(location.hash); view = route.view;
  delete studioUi.confirm; delete studioUi.error;
  // A notice belongs to the action that produced it, not to the next page.
  notify("");
  if (snapshot) render();
});
let sessionFilter: SessionFilter = "all";
let sessionQuery = "";
let sessionDraft: SessionDraft = { title: "", brief: "" };
let selectedPlaybook: string | undefined;
let draftMaterials: Material[] = [];
let selectedRun: string | undefined;
let selectedPhase: number | undefined;
let botRequestId = crypto.randomUUID();
let botPoll: ReturnType<typeof setTimeout> | undefined;
let pipelineDraft: PipelineConfig | undefined;
let runRequestId = crypto.randomUUID();
let chatState = emptyChat();
let studioUi: StudioUi = emptyStudioUi();
let chatController: AbortController | undefined;
let editing: RecordView | undefined;
let busy = false;
let inspector = emptyInspector();
let mailFolder: MailFolder = "inbox";
let mailQuery = "";
let selectedMail: string | undefined;
const identity = node<HTMLSelectElement>("#identity");
const detail = node<HTMLDialogElement>("#detail");
const editor = node<HTMLDialogElement>("#editor");
const form = node<HTMLFormElement>("#draft-form");

function requestHeaders(workspace = selectedWorkspace): Record<string, string> {
  return { "Content-Type": "application/json", ...(localMode
    ? (workspace ? { "X-Magentic-Workspace": workspace } : {})
    : { Authorization: `Bearer ${identity.value}` }) };
}
function mcpRequest(_token: string, method: string, params: unknown, protocolVersion?: string) {
  return sendMcpRequest(localMode ? "" : identity.value, method, params, protocolVersion, requestHeaders());
}
async function api(path: string, data?: unknown, workspace = selectedWorkspace): Promise<unknown> {
  const response = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    headers: requestHeaders(workspace),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(localMode && response.status === 401 ? "The local session expired. Close and reopen Magentic Developer to sign in again." : result.error ?? "Request failed.");
  return result;
}

function notify(message: string, error = false): void {
  node("#notice").textContent = message;
  node("#notice").classList.toggle("error", error);
}

async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  const next = await api("/api/workspace") as Snapshot;
  if (version !== refreshVersion) return;
  snapshot = next;
  render();
  const agentName = new URLSearchParams(location.hash.slice(1)).get("agent");
  if (agentName && snapshot.records.some((record) => record.definition.name === agentName)) {
    history.replaceState(null, "", location.pathname);
    showRecord(agentName);
  }
}

function render(): void {
  watchSchedule();
  document.body.classList.toggle("developer-desk", view === "desk");
  renderWorkspaces();
  const primary = PRIMARY_VIEWS.includes(view);
  node("#new-agent").hidden = !snapshot.canAuthor || view !== "agents";
  node("#new-invitation").hidden = !snapshot.mail?.canInvite || view !== "email";
  const unread = snapshot.mail?.messages.filter((message) => message.recipientActor === snapshot.actor && !message.viewed).length ?? 0;
  node("#mail-badge").textContent = String(unread);
  node("#mail-badge").hidden = unread === 0;
  const counts = navCounts(snapshot);
  node("#nav-approvals").textContent = String(counts.approvals); node("#nav-approvals").hidden = counts.approvals === 0;
  node("#nav-attention").textContent = String(counts.attention); node("#nav-attention").hidden = counts.attention === 0;
  document.querySelectorAll<HTMLAnchorElement>("a.nav[data-route]").forEach((link) => {
    const active = link.dataset.route === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (view !== "agents") node("#metrics").hidden = true;
  scheduleBotPoll();

  if (primary) {
    node("#agent-panel").hidden = true;
    node("#other-panel").hidden = true;
    const page = currentPage();
    setHeading(page);
    node("#view").hidden = false;
    // A refused command is shown where the person is working, above the page it concerns.
    node("#view").innerHTML = (studioUi.error ? `<div class="inline-error" role="alert">${escape(studioUi.error)}</div>` : "") + page.body;
    if (view === "assistants" && route.id) { const transcript = document.querySelector(".chat-transcript"); if (transcript) transcript.scrollTop = transcript.scrollHeight; }
    return;
  }
  node("#view").hidden = true;
  renderLegacy();
}

/** The six primary pages, from the route and the snapshot. */
function currentPage(): Page {
  switch (view) {
    case "workspace": return { title: "Workspace", context: `${snapshot.workspaceId} · acting as ${snapshot.actor}`, body: hint("Each row is a project drawn as its chain of connections. Click any box to open it.") + homeView(snapshot) };
    case "assistants":
      // The chat below an assistant always speaks as that assistant.
      if (route.id) { const wanted = route.id === WORKSPACE_ASSISTANT ? "" : route.id; if (chatState.profile !== wanted) { chatController?.abort(); chatState = { ...emptyChat(), models: chatState.models, options: chatState.options, selectedModel: chatState.selectedModel, profile: wanted }; } }
      return route.id ? assistantDetailPage(snapshot, route.id, chatView(snapshot.chat, chatState, chatProfiles(), { locked: route.id !== WORKSPACE_ASSISTANT })) : assistantsListPage(snapshot);
    case "workflows": return workflowPage(snapshot, route.id, studioUi);
    case "documents": return { ...documentsPage(snapshot, route.id, studioUi), body: hint("Paste documentation once; attach it to a running workflow or add it to an assistant's project from here.") + documentsPage(snapshot, route.id, studioUi).body };
    case "studio": return route.id ? studioProjectPage(snapshot, route.id, route.sub, studioUi) : studioListPage(snapshot, studioUi);
    case "evaluations": { const page = route.id ? evaluationDetailPage(snapshot, route.id) : evaluationsListPage(snapshot); return route.id ? page : { ...page, body: hint("An evaluation checks a candidate model against the scores it must reach. Passed means a release can be requested; failed tells you what to fix.") + page.body }; }
    case "approvals": { const page = route.id ? approvalDetailPage(snapshot, route.id, studioUi) : approvalsQueuePage(snapshot); return route.id ? page : { ...page, body: hint("Releases wait here until enough reviewers sign them. Open one to see exactly what you would be approving.") + page.body }; }
    default: { const page = activityPage(snapshot, route.query.get("project") ?? undefined); return { ...page, body: hint("Everything that happened in this workspace, newest first: who did it, to what, and the state it left behind.") + page.body }; }
  }
}

const PAGE_NAMES: Record<string, string> = { workspace: "Workspace", assistants: "Assistants", workflows: "Workflows", studio: "Model Studio", documents: "Documents", evaluations: "Evaluations", approvals: "Approvals", activity: "Activity",
  desk: "Work desk", pipelines: "Automation setup", agents: "Agents", email: "Email", mcp: "MCP", workflow: "Workflow policy" };

function setHeading(page: Page): void {
  node("#title").textContent = page.title;
  node("#subtitle").textContent = page.context ?? "";
  node("#crumbs").innerHTML = page.crumbs ? page.crumbs.map(([label, href]) => `<a href="${escape(href)}">${escape(label)}</a> / `).join("") : "";
  node("#page-actions").innerHTML = page.actions ?? "";
  node("#breadcrumb").textContent = page.crumbs ? `${page.crumbs.map(([label]) => label).join(" / ")} / ${page.title}` : page.title;
  document.title = `${page.title} · Magentic`;
}

function renderLegacy(): void {
  setHeading({ body: "", title: PAGE_NAMES[view] ?? view, context: view === "desk" ? "Work items, their context and the next agent handoff." : view === "pipelines" ? "Stages, gates and Jira previews for automated work." : view === "email" ? "Invitation and review previews. Nothing is sent." : view === "mcp" ? "Connect tools to reviewed definitions." : view === "workflow" ? "The active approval policy." : "Agent definitions, reviewed and approved." });
  node("#metrics").hidden = view !== "agents";
  if (view === "agents") {
    node("#metrics").innerHTML = [
      ["Total agents", snapshot.records.length, "In your workspace", "▦", "all", "Browse agents"],
      ["Awaiting review", snapshot.records.filter((r) => r.status === "review" || (r.status === "approved" && !r.eligible)).length, "Need a second signature", "◷", "needs-review", "View pending reviews"],
      ["Approval-ready", snapshot.records.filter((r) => r.eligible).length, "Current signatures meet policy", "✓", "ready", "View ready agents"],
      ["Required approvals", snapshot.workflow.requiredApprovals, "Distinct people, same content", "♧", "workflow", "Open policy"],
    ].map(([label, value, subtitle, icon, target, hint]) => `<button class="metric" data-summary="${target}" aria-label="${hint}"><span class="metric-label">${label}</span><span class="metric-mark" aria-hidden="true">${icon}</span><span class="metric-value">${value}</span><small>${subtitle}</small></button>`).join("");
  }
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.filter === filter);
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
  const query = node<HTMLInputElement>("#search").value.toLowerCase();
  const records = snapshot.records.filter((record) => (filter === "all" || record.status === filter
      || (filter === "ready" && record.eligible)
      || (filter === "needs-review" && (record.status === "review" || (record.status === "approved" && !record.eligible))))
    && `${record.definition.title} ${record.definition.description} ${record.definition.name}`.toLowerCase().includes(query));
  node("#records").innerHTML = records.length ? `<div class="record-header"><span>AGENT</span><span>STATUS</span><span>APPROVALS</span><span class="access-header">ACCESS</span><span></span></div>` + records.map((r) => `
    <button class="record" data-record="${escape(r.definition.name)}" aria-label="Review ${escape(r.definition.title)}">
      <div class="record-main"><span class="agent-icon">${escape(r.definition.title.charAt(0))}</span><div><div class="agent-name">${escape(r.definition.title)}</div><div class="agent-description">${escape(r.definition.description)}</div></div></div>
      <span class="badge ${r.status}">${r.status === "review" ? "In review" : r.status}</span>
      <span class="signatures">${r.validApprovers.length} / ${snapshot.workflow.requiredApprovals} <small>${r.eligible ? "Policy satisfied" : "Not yet eligible"}</small></span>
      <span class="access">${r.definition.scopes.includes("write") ? "Read + write" : "Read only"}</span><span class="arrow">↗</span>
    </button>`).join("") : '<p class="empty">No agents match this view.</p>';
  const other = node("#other-panel");
  node("#agent-panel").hidden = view !== "agents";
  other.hidden = view === "agents";
  other.classList.toggle("mail-panel", view === "email");
  other.classList.toggle("mcp-panel", view === "mcp");
  other.classList.toggle("chat-panel", false);
  other.classList.toggle("pipeline-panel", view === "pipelines" || view === "desk");
  if (view === "desk") other.innerHTML = workspaceView(snapshot.pipelines, snapshot.bots, snapshot.actor, snapshot.roles, sessionDraft, draftMaterials, selectedRun, selectedPhase, sessionQuery, snapshot.ontology);
  if (view === "pipelines") other.innerHTML = pipelineView(snapshot.pipelines, snapshot.actor, snapshot.roles, selectedRun, pipelineDraft, snapshot.bots, selectedPhase, snapshot.jira);
  if (view === "mcp") other.innerHTML = mcpView(snapshot.mcp, inspector, new URL("/api/mcp", location.origin).href, snapshot.demo, snapshot.actor);
  if (view === "email") other.innerHTML = emailView(snapshot.mail, snapshot.actor, mailFolder, mailQuery, selectedMail);
  if (view === "workflow") {
    other.innerHTML = `<p class="muted">The active workspace policy. File changes take effect on server restart.</p><div class="flow">${snapshot.workflow.states.map((state) => `<span>${escape(state)}</span>`).join(" → ")}</div><p><strong>${snapshot.workflow.requiredApprovals} distinct approvals</strong> must match the current definition. Authors cannot sign their own work.</p>`
      + Object.entries(snapshot.workflow.transitions).map(([from, targets]) => `<div class="policy-row"><span>${escape(from)}</span><strong>${escape(targets?.join(", ") || "No outgoing transitions")}</strong></div>`).join("")
      + '<h3 class="mt14">Required roles</h3>' + Object.entries(snapshot.workflow.roles).map(([action, role]) => `<div class="policy-row"><span>${escape(action)}</span><strong>${escape(role)}</strong></div>`).join("");
  }
}

function setView(next: string): void {
  navigate(`#/${next}`);
}

function permitted(action: Action): boolean {
  return snapshot.roles.includes("admin") || snapshot.roles.includes(snapshot.workflow.roles[action]);
}

function showRecord(name: string): void {
  const record = snapshot.records.find((item) => item.definition.name === name)!;
  const targets = snapshot.workflow.transitions[record.status] ?? [];
  const actions: [Action, string, boolean][] = [
    ["submit", "Send for review", targets.includes("review")],
    ["approve", "Approve this version", (targets.includes("approved") || record.status === "approved") && record.author !== snapshot.actor && !record.validApprovers.includes(snapshot.actor)],
    ["request-changes", "Request changes", targets.includes("draft")],
    ["retire", "Retire agent", targets.includes("retired")],
  ];
  node("#detail-content").innerHTML = `<div class="dialog-top"><span class="badge ${record.status}">${record.status}</span><button class="icon-button" data-close="detail" aria-label="Close review">×</button></div>
    <h2 id="detail-title">${escape(record.definition.title)}</h2><p class="muted">${escape(record.definition.description)}</p>
    <h3>Instructions being reviewed</h3><div class="definition-text">${escape(record.definition.instructions)}</div>
    <p class="muted">By ${escape(record.author)} · Version ${escape(record.definition.version)} · ${record.definition.scopes.includes("write") ? "Requests read and write access" : "Read only"}</p>
    <h3>Tools</h3><p class="muted">${record.definition.tools.map(escape).join(", ")}</p>
    <h3>Approvals · ${record.validApprovers.length} of ${snapshot.workflow.requiredApprovals}</h3>
    ${record.validApprovers.map((actor) => `<div class="approval-line">✓ ${escape(actor)} signed this content</div>`).join("") || '<p class="muted">No current signatures yet.</p>'}
    <p class="muted">${record.eligible ? "Signatures meet policy. Check the MCP catalog for tool availability. Conversation execution requires the separate relay adapter." : "This definition is not eligible to be served."}</p>
    <h3>Content fingerprint</h3><p class="hash">${record.hash}</p>
    <label class="muted" for="review-note">Review note (optional)</label><textarea id="review-note" class="detail-note" maxlength="2000" rows="2"></textarea>
    <p class="error-message" id="detail-error" role="alert"></p><div class="dialog-footer">
    ${record.status === "draft" && permitted("author") ? `<button class="secondary" data-edit="${escape(name)}">Edit draft</button>` : ""}
    ${actions.filter(([action, , enabled]) => enabled && permitted(action)).map(([action, label]) => `<button class="${action === "approve" || action === "submit" ? "primary" : "secondary"}" data-action="${action}" data-name="${escape(name)}" data-hash="${record.hash}">${label}</button>`).join("")}
    </div>`;
  if (!detail.open) detail.showModal();
}

function openEditor(record?: RecordView): void {
  editing = record;
  form.reset();
  for (const key of ["name", "title", "description", "instructions"] as const) {
    (form.elements.namedItem(key) as HTMLInputElement).value = record?.definition[key] ?? "";
  }
  (form.elements.namedItem("name") as HTMLInputElement).disabled = !!record;
  (form.elements.namedItem("tools") as HTMLInputElement).value = record?.definition.tools.join(", ") ?? "list_conversations";
  (form.elements.namedItem("write") as HTMLInputElement).checked = record?.definition.scopes.includes("write") ?? false;
  node("#editor-title").textContent = record ? "Make the next version clearer." : "Start with a clear purpose.";
  node("#form-error").textContent = "";
  detail.close();
  editor.showModal();
}

function lock(value: boolean): void {
  busy = value;
  document.body.classList.toggle("is-busy", value);
  node("main").setAttribute("aria-busy", String(value));
  node("#workspace-status").textContent = value ? "Working…" : "Ready";
  node<HTMLButtonElement>("#refresh-workspace").disabled = value;
  identity.disabled = value;
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("#local-workspaces input, #local-workspaces button, #local-workspaces select").forEach(input => { input.disabled = value; });
  document.querySelectorAll<HTMLButtonElement>("dialog button, [data-mcp-action], [data-mcp-agent]").forEach((button) => {
    button.disabled = value || (button.dataset.mcpAction === "run" && !inspector.tools.length)
      || (button.id === "jira-confirm" && !document.querySelector<HTMLInputElement>("#jira-confirm-reviewed")?.checked);
  });
}

document.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLElement>("button");
  if (!button || busy) return;
  if (!snapshot) { if (button.id === "refresh-workspace") void boot(); return; }
  if (button.id === "stop-chat") { chatController?.abort(); return; }
  if (button.id === "new-chat") { chatController?.abort(); chatState = { ...emptyChat(), models: chatState.models, options: chatState.options, selectedModel: chatState.selectedModel, profile: chatState.profile }; render(); return; }
  if (button.id === "refresh-models") { void loadChatModels(); return; }
  if (button.id === "retry-chat") { void sendChat(true); return; }
  if (button.dataset.chatPrompt) { chatState.draft = button.dataset.chatPrompt; void sendChat(); return; }
  if (button.dataset.close) { node<HTMLDialogElement>(`#${button.dataset.close}`).close(); return; }
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("selected", (item as HTMLElement).dataset.filter === filter));
    render();
  }
  if (button.dataset.view) setView(button.dataset.view);
  if (button.dataset.open) { const target = document.getElementById(button.dataset.open) as HTMLDetailsElement | null; if (target) { target.open = true; target.querySelector("input")?.focus(); } }
  if (button.dataset.summary) {
    filter = button.dataset.summary === "workflow" ? "all" : button.dataset.summary;
    node<HTMLInputElement>("#search").value = "";
    setView(button.dataset.summary === "workflow" ? "workflow" : "agents");
  }
  if (button.id === "refresh-workspace") {
    lock(true);
    try { await refresh(); notify("Workspace refreshed. You're viewing the latest data."); }
    catch (error) { notify((error as Error).message, true); }
    finally { lock(false); }
  }
  if (button.dataset.mcpAction || button.dataset.mcpAgent) {
    lock(true);
    const started = performance.now();
    try {
      if (button.dataset.mcpAction === "copy") {
        await navigator.clipboard.writeText(new URL("/api/mcp", location.origin).href);
        notify("MCP endpoint URL copied.");
      } else if (button.dataset.mcpAction === "refresh") {
        await refresh(); notify("Catalog refreshed against the current signatures.");
      } else {
        if (button.dataset.mcpAction === "connect" || !inspector.protocolVersion) {
          inspector = emptyInspector();
          const initialized = await mcpRequest(identity.value, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "magentic-portal-inspector", version: "0.1.0" } });
          const protocolVersion = initialized.protocolVersion as string;
          await mcpRequest(identity.value, "notifications/initialized", {}, protocolVersion);
          const listed = await mcpRequest(identity.value, "tools/list", {}, protocolVersion);
          inspector.tools = listed.tools as InspectorTool[];
          inspector.protocolVersion = protocolVersion;
          inspector.selected = inspector.tools[0]?.name ?? "";
          inspector.output = JSON.stringify(initialized, null, 2);
        }
        if (button.dataset.mcpAgent) {
          inspector.selected = "get_approved_agent";
          inspector.arguments = JSON.stringify({ name: button.dataset.mcpAgent }, null, 2);
        }
        if (button.dataset.mcpAction === "run" || button.dataset.mcpAgent) {
          const args: unknown = JSON.parse(inspector.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be a JSON object.");
          const result = await mcpRequest(identity.value, "tools/call", { name: inspector.selected, arguments: args }, inspector.protocolVersion);
          inspector.failed = result.isError === true;
          inspector.output = formatToolResult(result);
        }
        notify("");
        inspector.elapsed = Math.round(performance.now() - started);
        await refresh();
      }
    } catch (error) { inspector.failed = true; inspector.output = (error as Error).message; render(); notify((error as Error).message, true); }
    finally { lock(false); render(); }
  }
  if (button.dataset.mailFolder) {
    mailFolder = button.dataset.mailFolder as MailFolder; selectedMail = undefined; mailQuery = ""; render();
  }
  if (button.id === "mail-back") { selectedMail = undefined; render(); }
  if (button.dataset.mailAgent) showRecord(button.dataset.mailAgent);
  if (button.id === "new-invitation") {
    node<HTMLFormElement>("#invite-form").reset(); node("#invite-error").textContent = "";
    node<HTMLDialogElement>("#invite-dialog").showModal();
  }
  if (button.id === "mail-preferences" && snapshot.mail) {
    const preferencesForm = node<HTMLFormElement>("#preferences-form");
    for (const key of ["reviews", "updates"] as const) {
      (preferencesForm.elements.namedItem(key) as HTMLInputElement).checked = snapshot.mail.preferences[key];
    }
    node("#preferences-error").textContent = "";
    node<HTMLDialogElement>("#preferences-dialog").showModal();
  }
  if (button.dataset.mailId) {
    selectedMail = button.dataset.mailId;
    const message = snapshot.mail?.messages.find((item) => item.id === selectedMail);
    if (message?.recipientActor === snapshot.actor && !message.viewed) {
      lock(true);
      try { await api(`/api/email/${selectedMail}/viewed`, {}); await refresh(); }
      catch (error) { notify((error as Error).message, true); }
      finally { lock(false); }
    } else render();
  }
  if (button.dataset.cancelInvite) {
    lock(true);
    try { await api(`/api/email/${button.dataset.cancelInvite}/cancel`, {}); await refresh(); notify("Invitation draft cancelled. No email was sent."); }
    catch (error) { notify((error as Error).message, true); }
    finally { lock(false); }
  }
  if (button.dataset.record) showRecord(button.dataset.record);
  if (button.id === "new-agent") openEditor();
  if (button.dataset.edit) openEditor(snapshot.records.find((record) => record.definition.name === button.dataset.edit));
  if (button.dataset.action) {
    lock(true);
    try {
      const saved = await api(`/api/records/${button.dataset.name}/${button.dataset.action}`, { expectedHash: button.dataset.hash, note: node<HTMLTextAreaElement>("#review-note").value }) as { emailWarning?: string };
      await refresh();
      detail.close();
      notify(saved.emailWarning ?? "Saved. The workspace, audit trail, and email previews are up to date.", !!saved.emailWarning);
    } catch (error) { node("#detail-error").textContent = (error as Error).message; }
    finally { lock(false); }
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  lock(true);
  try {
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
    const definition = {
      ...(editing?.definition ?? { category: "general", version: "1.0.0", optionalTools: [], publisher: snapshot.workspaceId }),
      name: editing?.definition.name ?? value("name"), title: value("title"), description: value("description"),
      instructions: value("instructions"), tools: value("tools").split(",").map((tool) => tool.trim()).filter(Boolean),
      scopes: (form.elements.namedItem("write") as HTMLInputElement).checked ? ["read", "write"] : ["read"],
    };
    await api("/api/records", { definition, ...(editing ? { expectedHash: editing.hash } : {}) });
    await refresh();
    editor.close();
    notify("Draft saved. Send it for review when it is ready.");
  } catch (error) { node("#form-error").textContent = (error as Error).message; }
  finally { lock(false); }
});

identity.addEventListener("change", async () => {
  chatController?.abort(); chatState = emptyChat();
  selectedPhase = undefined; botRequestId = crypto.randomUUID();
  if (botPoll) clearTimeout(botPoll);
  selectedRun = undefined; pipelineDraft = undefined; runRequestId = crypto.randomUUID();
  detail.close(); editor.close();
  node<HTMLDialogElement>("#invite-dialog").close(); node<HTMLDialogElement>("#preferences-dialog").close();
  selectedMail = undefined; mailFolder = "inbox"; mailQuery = ""; inspector = emptyInspector(); lock(true);
  try { await refresh(); await loadChatModels(); notify(`Exploring as ${snapshot.actor}.`); }
  catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});
node("#search").addEventListener("input", () => { if (snapshot) render(); });
void boot();

node<HTMLFormElement>("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  lock(true);
  const inviteForm = node<HTMLFormElement>("#invite-form");
  const value = (name: string) => (inviteForm.elements.namedItem(name) as HTMLInputElement).value;
  try {
    const message = await api("/api/email/invitations", { email: value("email"), role: value("role"), note: value("note") }) as { id: string };
    mailFolder = "invitations"; selectedMail = message.id; mailQuery = "";
    await refresh(); node<HTMLDialogElement>("#invite-dialog").close();
    notify("Invitation preview created. No email was sent and no access was granted.");
  } catch (error) { node("#invite-error").textContent = (error as Error).message; }
  finally { lock(false); }
});

node<HTMLFormElement>("#preferences-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  lock(true);
  const preferencesForm = node<HTMLFormElement>("#preferences-form");
  try {
    await api("/api/email/preferences", {
      reviews: (preferencesForm.elements.namedItem("reviews") as HTMLInputElement).checked,
      updates: (preferencesForm.elements.namedItem("updates") as HTMLInputElement).checked,
    });
    await refresh(); node<HTMLDialogElement>("#preferences-dialog").close(); notify("Notification preferences saved.");
  } catch (error) { node("#preferences-error").textContent = (error as Error).message; }
  finally { lock(false); }
});

document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== "mail-search") return;
  mailQuery = input.value; selectedMail = undefined;
  render(); node<HTMLInputElement>("#mail-search").focus();
});

document.addEventListener("change", (event) => {
  const profile = event.target as HTMLSelectElement;
  if (profile.name?.startsWith("bot-")) {
    const selection = document.querySelector<HTMLSelectElement>(`select[name="profile-${profile.name.slice(4)}"]`);
    if (selection?.value && selection.selectedOptions[0]?.dataset.kind !== profile.value) selection.value = "";
    return;
  }
  if (!profile.name?.startsWith("profile-") || !profile.value) return;
  const option = profile.selectedOptions[0];
  const kind = document.querySelector<HTMLSelectElement>(`select[name="bot-${profile.name.slice(8)}"]`);
  if (kind && option?.dataset.kind) kind.value = option.dataset.kind;
});

document.addEventListener("change", (event) => {
  const input = event.target as HTMLSelectElement;
  if (input.id !== "mcp-tool") return;
  inspector.selected = input.value;
  inspector.arguments = input.value === "get_approved_agent" ? JSON.stringify({ name: snapshot.mcp.agents[0]?.name ?? "agent-name" }, null, 2) : "{}";
  render();
});
document.addEventListener("input", (event) => {
  const input = event.target as HTMLTextAreaElement;
  if (input.id === "mcp-arguments") inspector.arguments = input.value;
});

/** Active profiles whose release is approved, for the picker in Assistants. */
function chatProfiles(): { id: string; name: string; release: string }[] {
  const studio = snapshot.studio;
  if (!studio) return [];
  return studio.profiles.filter((profile) => profile.status === "active").flatMap((profile) => {
    const release = studio.releases.find((item) => item.id === profile.releaseId);
    if (!release || release.status !== "approved") return [];
    const project = studio.projects.find((item) => item.id === release.projectId);
    const job = studio.jobs.find((item) => item.id === release.jobId);
    return [{ id: profile.id, name: profile.name, release: `${project?.name ?? "Project"} v${release.version} · ${job?.artifact?.label ?? "unknown"} artifact` }];
  });
}
function renderChat(): void {
  if (view !== "assistants" || !route.id) return;
  const draft = document.querySelector<HTMLTextAreaElement>("#chat-input");
  if (draft && !chatState.busy) chatState.draft = draft.value;
  render();
}

async function sendChat(retry = false): Promise<void> {
  if (chatState.busy || chatState.loadingModels || !snapshot.chat.configured) return;
  const state = chatState;
  const selectedModel = state.selectedModel || snapshot.chat.model || "";
  if (state.options.find((model) => model.id === selectedModel)?.available === false) return;
  if (!retry) {
    const text = state.draft.trim();
    if (!text) return;
    if (text.length > 4000) { state.error = "Keep your message under 4,000 characters."; renderChat(); return; }
    state.messages.push({ role: "user", content: text });
    state.draft = "";
  }
  state.error = ""; state.tools = []; state.busy = true; state.phase = "Connecting to Magentic…";
  const controller = new AbortController();
  chatController = controller;
  renderChat();
  let finished = false;
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: requestHeaders(),
      body: JSON.stringify({ model: selectedModel, ...(state.profile ? { profile: state.profile } : {}), messages: state.messages.map(({ role, content }) => ({ role, content })) }),
      signal: controller.signal,
    });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? "Chat request failed."); }
    if (!response.body) throw new Error("The server returned no response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, newline)) as ChatEvent;
        pending = pending.slice(newline + 1);
        if (chatState !== state) continue;
        if (event.type === "thinking") state.phase = event.message;
        if (event.type === "tool") {
          if (event.state === "running") state.tools.push({ name: event.name, state: event.state });
          else {
            const tool = state.tools.findLast((item) => item.name === event.name && item.state === "running");
            if (tool) tool.state = event.state;
          }
          state.phase = event.state === "running" ? `Using ${event.name}…` : "Preparing an answer…";
        }
        if (event.type === "answer") {
          const profile = chatProfiles().find((item) => item.id === state.profile);
          const cost = event.usage ? ` · ${formatTokens(event.usage)}` : "";
          state.messages.push({ role: "assistant", content: event.content, model: (profile ? `${profile.release} · ${selectedModel}` : selectedModel) + cost, tools: [...state.tools], ...(profile ? { assistant: profile.name } : {}) }); finished = true;
        }
        if (event.type === "error") { state.error = event.message; finished = true; }
        renderChat();
      }
    }
    if (!finished) throw new Error("The connection ended before an answer arrived. Try again.");
  } catch (error) {
    if (chatState === state) state.error = controller.signal.aborted ? "Stopped. You can try again or start a new chat." : (error as Error).message;
  } finally {
    if (chatState === state) {
      state.busy = false; chatController = undefined; renderChat();
      if (view === "assistants") document.querySelector<HTMLTextAreaElement>("#chat-input")?.focus();
    }
  }
}

document.addEventListener("submit", (event) => {
  if ((event.target as HTMLElement).id !== "chat-form") return;
  event.preventDefault(); void sendChat();
});
document.addEventListener("input", (event) => {
  const input = event.target as HTMLTextAreaElement;
  if (input.id === "chat-input") chatState.draft = input.value;
});
document.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).id === "chat-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); void sendChat();
  }
});

async function loadChatModels(): Promise<void> {
  if (!snapshot.chat.configured || chatState.busy) return;
  const state = chatState;
  state.loadingModels = true; renderChat();
  try {
    const result = await api("/api/chat/models") as { models: string[]; options?: typeof state.options };
    if (chatState !== state) return;
    state.models = result.models;
    state.options = result.options ?? [];
    const desired = state.selectedModel || snapshot.chat.model || "";
    state.selectedModel = state.options.some((model) => model.id === desired) || result.models.includes(desired) ? desired : result.models[0] ?? state.options[0]?.id ?? "";
    state.error = result.models.length || state.options.length ? "" : "No models are installed. Install a model in Ollama, then refresh this list.";
  } catch (error) { if (chatState === state) state.error = (error as Error).message; }
  finally { if (chatState === state) { state.loadingModels = false; renderChat(); } }
}
document.addEventListener("change", (event) => {
  const input = event.target as HTMLSelectElement;
  if (chatState.busy) return;
  if (input.id === "chat-model") { chatState.selectedModel = input.value; renderChat(); }
  if (input.id === "chat-profile") { chatState.profile = input.value; renderChat(); }
});

// ------------------------------------------------------------ Model Studio

// Unsaved form values survive navigation between phases: every input in a
// form marked data-draft is mirrored into studioUi.drafts and rendered back.
document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  const form = input.closest<HTMLFormElement>("form[data-draft]");
  if (!form || !input.name) return;
  const key = form.dataset.draft!;
  studioUi.drafts[key] = { ...studioUi.drafts[key], [input.name]: input.value };
});
document.addEventListener("change", (event) => {
  const input = event.target as HTMLSelectElement;
  if (input.dataset.studioFilter) { studioUi.filters = { ...studioUi.filters, [input.dataset.studioFilter]: input.value }; render(); }
});
// A table row that names a destination opens it, unless the click was on a control inside it.
document.addEventListener("click", (event) => {
  const target = event.target as Element;
  if (target.closest("a, button, input, select, textarea, summary, details")) return;
  const row = target.closest<HTMLTableRowElement>("tr[data-href]");
  if (row?.dataset.href) navigate(row.dataset.href);
});
async function studioCommand(data: Record<string, unknown>, message: string): Promise<void> {
  lock(true);
  try {
    const workspace = selectedWorkspace;
    const result = await api("/api/studio", data, workspace) as StudioSnapshot;
    if (workspace !== selectedWorkspace) return;
    snapshot.studio = result; delete snapshot.studioError;
    delete studioUi.confirm; delete studioUi.error;
    render(); notify(message);
  } catch (error) { studioUi.error = (error as Error).message; render(); }
  finally { lock(false); }
}
document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot) return;

  if (button.dataset.studioChat) { chatState.profile = button.dataset.studioChat; navigate(`#/assistants/${button.dataset.studioChat}`); }
  if (button.dataset.confirm) { studioUi.confirm = button.dataset.confirm; render(); }
  if (button.hasAttribute("data-cancel-confirm")) { delete studioUi.confirm; render(); }
  if (button.dataset.documentRemove) void documentCommand({ action: "remove_document", documentId: button.dataset.documentRemove }, "Document removed from the portal.").then(() => { delete studioUi.confirm; navigate("#/documents"); });
  // Switching the workflow to a template replaces the definition, so it is confirmed inline first.
  if (button.dataset.workflowTemplate && snapshot.pipelines) {
    const config = WORKFLOW_TEMPLATES[button.dataset.workflowTemplate];
    if (config) void workflowCommand({ action: "configure", expectedVersion: snapshot.pipelines.version, config: structuredClone(config) }).then(() => { delete studioUi.confirm; navigate("#/workflows"); });
  }
  // The owner turns an assistant's draft into the stage output; it is the ordinary complete command with the draft as the note.
  if (button.dataset.runDraft && snapshot.pipelines) {
    const run = snapshot.pipelines.runs.find((item) => item.id === button.dataset.runDraft);
    const draft = run?.stages[run.current]?.draft;
    if (run && draft) void workflowCommand({ action: "complete", runId: run.id, expectedRevision: run.revision, note: draft.text });
  }
  if (button.dataset.jobRetry) void scheduleCommand({ action: "retry", jobId: button.dataset.jobRetry });
  if (button.dataset.learningRun) void learningCommand({ action: "run", projectId: button.dataset.learningRun }, "Learning cycle finished. Its steps are under Learning schedule.");
  if (button.dataset.studioAction && button.dataset.id) {
    const action = button.dataset.studioAction;
    const id = button.dataset.id;
    const key = { archive_project: "projectId", validate_dataset: "datasetId", create_job: "configId", record_job: "jobId", cancel_job: "jobId",
      run_evaluation: "jobId", request_release: "evaluationId", disable_profile: "profileId" }[action];
    if (!key) return;
    // Requesting a release moves the work to the Approve phase, where the outcome is.
    const evaluation = action === "request_release" ? snapshot.studio?.evaluations.find((item) => item.id === id) : undefined;
    void studioCommand({ action, [key]: id }, { validate_dataset: "Validation finished. Issues are listed by line number; record content is never shown.",
      create_job: "Job started. Check its status to record the result.", record_job: "Job result recorded.", cancel_job: "Job cancelled.",
      run_evaluation: "Evaluation recorded against the recipe thresholds.", request_release: "Release requested. It needs distinct approvals before it can be used.",
      archive_project: "Project archived.", disable_profile: "Assistant disabled." }[action] ?? "Saved.").then(() => {
      if (evaluation && snapshot.studio?.releases.some((release) => release.evaluationId === evaluation.id)) navigate(`#/studio/${evaluation.projectId}/approve`);
      if (action === "archive_project" && snapshot.studio?.projects.find((project) => project.id === id)?.status === "archived") navigate("#/studio");
    });
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target as HTMLFormElement;
  const decision = (event as SubmitEvent).submitter?.dataset.studioDecision;
  if (!form.id.startsWith("studio-") && !decision) return;
  event.preventDefault(); if (busy) return;
  const data = new FormData(form);
  const field = (name: string) => String(data.get(name) ?? "").trim();
  if (decision) {
    const note = field("note");
    if (decision !== "approve_release" && !note) { notify("Write a note explaining the decision.", true); return; }
    const command = decision === "retire_release" ? { action: decision, releaseId: form.dataset.release, note }
      : { action: decision, releaseId: form.dataset.release, expectedHash: form.dataset.hash, ...(note ? { note } : {}) };
    void studioCommand(command, decision === "approve_release" ? "Your approval is recorded against this release hash." : decision === "reject_release" ? "Release rejected." : "Release retired. Its assistants are disabled.").then(() => { delete studioUi.drafts[form.dataset.draft!]; });
    return;
  }
  if (form.id === "studio-project") {
    const before = snapshot.studio?.projects.length ?? 0;
    void studioCommand({ action: "create_project", name: field("name"), recipeId: field("recipeId"), purpose: field("purpose") }, "Project created. Register a dataset next.").then(() => {
      const created = snapshot.studio?.projects.at(-1);
      if (created && (snapshot.studio?.projects.length ?? 0) > before) { delete studioUi.drafts.project; navigate(`#/studio/${created.id}/data`); }
    });
  }
  if (form.id === "studio-dataset") {
    const text = field("text"), path = field("path");
    if (!text && !path) { notify("Paste records or name a file in the import folder.", true); return; }
    const key = form.dataset.draft!;
    const before = snapshot.studio?.datasets.length ?? 0;
    void studioCommand({ action: "register_dataset", projectId: form.dataset.project, name: field("name"),
      source: text ? { kind: "inline", text } : { kind: "file", path } }, "Dataset registered. Validate it before training.").then(() => {
      if ((snapshot.studio?.datasets.length ?? 0) > before) { delete studioUi.drafts[key]; render(); }
    });
  }
  if (form.id === "studio-config") {
    const hyperparameters = { epochs: Number(field("epochs")), learningRate: Number(field("learningRate")), batchSize: Number(field("batchSize")) };
    const before = snapshot.studio?.configs.length ?? 0;
    await studioCommand({ action: "configure_training", projectId: form.dataset.project, datasetId: field("datasetId"), provider: field("provider"),
      baseModel: field("baseModel"), hyperparameters }, "Configuration saved.");
    const config = snapshot.studio?.configs.at(-1);
    // Only a configuration this submit created starts a job. A refused save
    // must not start a job on an older configuration.
    if (config && (snapshot.studio?.configs.length ?? 0) > before) { delete studioUi.drafts[form.dataset.draft!]; void studioCommand({ action: "create_job", configId: config.id }, "Training job started. Check the job to record its result."); }
  }
  if (form.id === "studio-profile") {
    const key = form.dataset.draft!;
    const before = snapshot.studio?.profiles.length ?? 0;
    void studioCommand({ action: "assign_profile", name: field("name"), releaseId: field("releaseId"), instructions: field("instructions") }, "Assistant created. Open it under Assistants to test it.").then(() => {
      if ((snapshot.studio?.profiles.length ?? 0) > before) { delete studioUi.drafts[key]; render(); }
    });
  }
});


function readPipelineConfig(): PipelineConfig {
  const previous = pipelineDraft ?? snapshot.pipelines!.config;
  const data = new FormData(node<HTMLFormElement>("#pipeline-config"));
  const field = (name: string) => String(data.get(name) ?? "").trim();
  return { name: field("pipelineName"), description: field("description"),
    jira: { enabled: data.has("jiraEnabled"), project: field("project"), issueType: field("issueType") },
    stages: previous.stages.map((stage, index) => ({ ...(snapshot.bots ? { bot: {
      allowedTools: BOT_REPOSITORY_TOOLS.filter(tool => data.has(`tool-${index}-${tool}`)), maxToolCalls: Number(field(`toolcalls-${index}`)),
      ...(field(`profile-${index}`) ? { profile: field(`profile-${index}`) as NonNullable<BotPolicy["profile"]> } : {}),
      kind: field(`bot-${index}`) as BotPolicy["kind"], maxSteps: Number(field(`steps-${index}`)), timeoutSeconds: Number(field(`timeout-${index}`)),
    } } : stage.bot ? { bot: stage.bot } : {}), ...(stage.assistantId ? { assistantId: stage.assistantId } : {}), id: stage.id, name: field(`name-${index}`), agent: field(`agent-${index}`),
      model: field(`model-${index}`), jiraStatus: field(`status-${index}`), instructions: field(`instructions-${index}`),
      context: field(`context-${index}`), approval: data.has(`approval-${index}`) })) };
}
async function pipelineCommand(data: unknown): Promise<void> {
  if (snapshot.bots?.busy) { notify("A bot is working. Stop it or wait before changing the pipeline.", true); return; }
  lock(true);
  try {
    const result = await api("/api/pipeline", data) as PipelineSnapshot;
    snapshot.pipelines = result; selectedPhase = undefined;
    if ((data as { action: string }).action === "start") { sessionDraft = { title: "", brief: "" }; selectedPlaybook = undefined; draftMaterials = []; selectedRun = result.runs.find(run => run.requestId === runRequestId)?.id; runRequestId = crypto.randomUUID(); setView("desk"); }
    if ((data as { action: string }).action === "configure") pipelineDraft = undefined;
    render(); notify("Workflow updated. Jira actions remain previews.");
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
}
function pipelineAction(action: string, note?: string): Promise<void> {
  const run = snapshot.pipelines?.runs.find(item => item.id === selectedRun) ?? snapshot.pipelines?.runs[0];
  if (!run) return Promise.resolve();
  return pipelineCommand({ action, runId: run.id, expectedRevision: run.revision, ...(note ? { note } : {}) });
}
// Staffing a stage is a configure command with one field changed. The
// engine refuses an assistant that cannot work, and says so on the page.
document.addEventListener("submit", (event) => {
  const target = event.target as HTMLFormElement;
  if (target.id !== "workflow-stage" || !snapshot.pipelines) return;
  event.preventDefault();
  if (busy) return;
  const stageId = target.dataset.stage;
  const assistantId = String(new FormData(target).get("assistantId") ?? "");
  const config = structuredClone(snapshot.pipelines.config);
  config.stages = config.stages.map((stage) => {
    if (stage.id !== stageId) return stage;
    const { assistantId: _previous, ...rest } = stage;
    return assistantId ? { ...rest, assistantId } : rest;
  });
  void workflowCommand({ action: "configure", expectedVersion: snapshot.pipelines.version, config });
});
async function documentCommand(data: unknown, message: string): Promise<void> {
  lock(true);
  try { await api("/api/documents", data); delete studioUi.error; await refresh(); notify(message); }
  catch (error) { studioUi.error = (error as Error).message; render(); }
  finally { lock(false); }
}
document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (!["document-add", "document-attach", "document-project"].includes(form.id)) return;
  event.preventDefault();
  if (busy) return;
  const data = new FormData(form);
  if (form.id === "document-add") {
    void documentCommand({ action: "add_document", title: String(data.get("title") ?? "").trim(), text: String(data.get("text") ?? "") }, "Document added.").then(() => form.reset());
  } else if (form.id === "document-attach") {
    void documentCommand({ action: "attach_to_run", documentId: form.dataset.document, runId: String(data.get("runId") ?? "") }, "Attached as reference material.");
  } else {
    void documentCommand({ action: "add_to_project", documentId: form.dataset.document, projectId: String(data.get("projectId") ?? "") }, "Added to the project as a dataset.");
  }
});
async function learningCommand(data: unknown, message: string): Promise<void> {
  lock(true);
  try { await api("/api/learning", data); delete studioUi.error; await refresh(); notify(message); }
  catch (error) { studioUi.error = (error as Error).message; render(); }
  finally { lock(false); }
}
document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id !== "studio-learning") return;
  event.preventDefault();
  if (busy) return;
  const data = new FormData(form);
  const key = `learning:${form.dataset.project}`;
  void learningCommand({ action: "set", projectId: form.dataset.project, cadence: String(data.get("cadence") ?? "weekly"),
    ...(data.has("pattern") ? { pattern: String(data.get("pattern") ?? "").trim() } : {}), paused: data.has("paused") }, "Learning schedule saved.").then(() => { delete studioUi.drafts[key]; });
});
async function scheduleCommand(data: unknown): Promise<void> {
  lock(true);
  try { await api("/api/schedule", data); delete studioUi.error; await refresh(); }
  catch (error) { studioUi.error = (error as Error).message; render(); }
  finally { lock(false); }
}
async function workflowCommand(data: unknown): Promise<void> {
  if (snapshot.bots?.busy) { studioUi.error = "A bot is working. Stop it or wait before changing the workflow."; render(); return; }
  lock(true);
  try {
    await api("/api/pipeline", data);
    pipelineDraft = undefined; delete studioUi.error;
    // The scheduler may have queued work for the new stage; read everything back.
    await refresh(); notify("Workflow updated.");
  } catch (error) { studioUi.error = (error as Error).message; render(); }
  finally { lock(false); }
}
// While an assistant is queued or drafting, the page keeps itself current.
let scheduleWatch: ReturnType<typeof setTimeout> | undefined;
function watchSchedule(): void {
  clearTimeout(scheduleWatch); scheduleWatch = undefined;
  const active = snapshot.schedule?.jobs.some((job) => job.status === "queued" || job.status === "running");
  if (active && !busy) scheduleWatch = setTimeout(() => { void refresh().catch(() => undefined); }, 4000);
}
document.addEventListener("submit", (event) => {
  const target = event.target as HTMLFormElement;
  if (!target.id.startsWith("pipeline-") && target.id !== "desk-start") return;
  event.preventDefault();
  if (busy) return;
  const data = new FormData(target);
  if (target.id === "pipeline-start" || target.id === "desk-start") void pipelineCommand({ action: "start", requestId: runRequestId,
    title: String(data.get("title")), brief: String(data.get("brief")), ...(target.id === "desk-start" ? { materials: draftMaterials } : {}), ...(data.get("issueKey") ? { issueKey: String(data.get("issueKey")).trim() } : {}) });
  if (target.id === "pipeline-output") void pipelineAction("complete", String(data.get("note")));
  if (target.id === "pipeline-block") void pipelineAction("block", String(data.get("note")));
  if (target.id === "pipeline-config") { pipelineDraft = readPipelineConfig(); void pipelineCommand({ action: "configure", expectedVersion: snapshot.pipelines!.version, config: pipelineDraft }); }
});
document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot) return;
  if (button.dataset.pipelineSelect) { selectedRun = button.dataset.pipelineSelect; selectedPhase = undefined; render(); }
  if (button.dataset.pipelineAction) void pipelineAction(button.dataset.pipelineAction);
  if (button.dataset.pipelineEdit && snapshot.roles.includes("admin")) {
    pipelineDraft = readPipelineConfig();
    const action = button.dataset.pipelineEdit;
    const index = Number(button.dataset.index);
    if (action === "add" && pipelineDraft.stages.length < 12) pipelineDraft.stages.push({ id: `stage-${crypto.randomUUID().slice(0,8)}`,
      name: "New stage", agent: "Development agent", instructions: "Record the expected work and acceptance evidence.",
      model: "qwen2.5-coder:7b", context: "Previous stage outputs", approval: false, jiraStatus: "In Progress" });
    if (action === "remove" && pipelineDraft.stages.length > 1) pipelineDraft.stages.splice(index, 1);
    const other = action === "up" ? index - 1 : action === "down" ? index + 1 : -1;
    if (other >= 0 && other < pipelineDraft.stages.length) [pipelineDraft.stages[index], pipelineDraft.stages[other]] = [pipelineDraft.stages[other]!, pipelineDraft.stages[index]!];
    if (action === "discard") pipelineDraft = undefined;
    render();
    node<HTMLDetailsElement>(".pipeline-settings").open = true;
  }
});

function renderWorkspaces(): void {
  if (!localMode || !workspaceList) return;
  node("#local-workspaces").hidden = false;
  const entry = workspaceList.workspaces.find(item => item.id === selectedWorkspace);
  node(".workspace").textContent = entry?.name ?? selectedWorkspace;
  node("#workspace-select").innerHTML = workspaceList.workspaces.map(item => `<option value="${escape(item.id)}" ${item.id === selectedWorkspace ? "selected" : ""}>${escape(item.name)}</option>`).join("");
  node("#local-storage").textContent = `Saved on this computer · ${workspaceList.directory}`;
  node("#local-identity").textContent = `Local owner · Author and admin · Workspace: ${selectedWorkspace}`;
}

async function boot(): Promise<void> {
  lock(true);
  try {
    if (localMode) {
      node(".identity").hidden = true;
      node(".demo-badge").textContent = "LOCAL WORKSPACE";
      // The card in the sidebar said "Demo workspace" whatever was open.
      node(".workspace small").textContent = "LOCAL · SAVED ON THIS COMPUTER";
      node("footer span:last-child").textContent = "Workspaces and runs are saved on this computer.";
      workspaceList = await api("/api/workspaces") as import("./workspace-directory.js").WorkspaceListing;
      selectedWorkspace = workspaceList.lastWorkspaceId;
      const open = workspaceList.workspaces.find((entry) => entry.id === selectedWorkspace);
      if (open) {
        node(".workspace div").firstChild!.textContent = open.name;
        node(".workspace-icon").textContent = open.name.trim().charAt(0).toUpperCase() || "W";
      }
    }
    await refresh();
    render();
    void loadChatModels();
  } catch (error) {
    notify((error as Error).message, true);
    node("#view").innerHTML = '<div class="inline-error" role="alert">The workspace could not be loaded. Refresh to retry, or reopen the application if the session expired.</div>';
    node("#records").textContent = "Workspace unavailable. Refresh to retry, or reopen the application if the session expired.";
  } finally { lock(false); }
}

async function openWorkspace(id: string): Promise<void> {
  await api("/api/workspaces/open", { workspaceId: id });
  const listing = await api("/api/workspaces") as import("./workspace-directory.js").WorkspaceListing;
  const next = await api("/api/workspace", undefined, id) as Snapshot;
  // Keep the old view and its request scope together until the next one is
  // ready. A failed open must not leave old forms targeting a new workspace.
  ++refreshVersion;
  chatController?.abort(); chatController = undefined; chatState = emptyChat();
  selectedWorkspace = id;
  selectedPhase = undefined; botRequestId = crypto.randomUUID();
  if (botPoll) clearTimeout(botPoll);
  selectedRun = undefined; pipelineDraft = undefined; runRequestId = crypto.randomUUID();
  editing = undefined; inspector = emptyInspector(); selectedMail = undefined;
  mailFolder = "inbox"; mailQuery = ""; filter = "all";
  draftMaterials = []; sessionFilter = "all"; sessionQuery = ""; sessionDraft = { title: "", brief: "" }; selectedPlaybook = undefined;
  node<HTMLInputElement>("#search").value = "";
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach(dialog => dialog.close());
  node("#local-mcp-settings").textContent = "";
  history.replaceState(null, "", location.pathname);
  workspaceList = listing; snapshot = next;
  studioUi = emptyStudioUi();
  navigate("#/workspace"); render(); void loadChatModels();
  notify("Workspace opened. Changes are saved on this computer.");
}

node<HTMLSelectElement>("#workspace-select").addEventListener("change", async event => {
  if (busy) return;
  lock(true);
  try { await openWorkspace((event.target as HTMLSelectElement).value); }
  catch (error) { notify((error as Error).message, true); renderWorkspaces(); }
  finally { lock(false); }
});
node<HTMLFormElement>("#create-workspace").addEventListener("submit", async event => {
  event.preventDefault(); if (busy) return;
  lock(true);
  try {
    const name = node<HTMLInputElement>("#workspace-name").value;
    const created = await api("/api/workspaces", { name, requestId: workspaceRequestId }) as { workspaceId: string };
    workspaceRequestId = crypto.randomUUID();
    node<HTMLInputElement>("#workspace-name").value = "";
    await openWorkspace(created.workspaceId);
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});
node("#local-mcp-access").addEventListener("click", async () => {
  if (busy) return;
  lock(true);
  try {
    const access = await api("/api/workspaces/mcp-access", {}) as { workspaceId: string; tokenFile: string };
    node("#local-mcp-settings").textContent = `Workspace: ${access.workspaceId}\nRegistry MCP: ${location.origin}/api/mcp\nPipeline MCP: ${location.origin}/api/pipeline-mcp\nAuthorization: Bearer <contents of ${access.tokenFile}>\nThis credential accesses only this workspace's MCP routes. Keep it private. The address changes on each launch.`;
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});

function scheduleBotPoll(): void {
  if (botPoll) clearTimeout(botPoll);
  if (!snapshot.bots?.busy) return;
  const workspace = selectedWorkspace;
  botPoll = setTimeout(async () => {
    try {
      const next = await api("/api/bots", undefined, workspace) as BotSnapshot;
      if (workspace !== selectedWorkspace) return;
      snapshot.bots = next;
      const run = snapshot.pipelines?.runs.find(item => item.id === selectedRun) ?? snapshot.pipelines?.runs[0];
      const panel = document.querySelector(".bot-workspace");
      if (view === "pipelines" && run && panel) panel.outerHTML = botTimeline(next, run, selectedPhase);
      if (view === "desk") {
        renderDeskSessions();
        const progress = document.querySelector("#work-progress");
        if (progress && run) progress.outerHTML = workProgress(run, next, snapshot.actor, snapshot.roles, selectedPhase);
      }
      if (!next.busy) notify("Bot attempt finished. Review the timeline before handing off.");
      scheduleBotPoll();
    } catch (error) { notify((error as Error).message, true); }
  }, 1500);
}

document.addEventListener("submit", async event => {
  const target = event.target as HTMLFormElement;
  if (target.id !== "bot-project-form") return;
  event.preventDefault(); if (busy) return;
  lock(true);
  try {
    const data = new FormData(target);
    await api("/api/bots", { action: "attach", project: { root: String(data.get("root")), checks: JSON.parse(String(data.get("checks"))) } });
    await refresh(); notify("Repository connected. Your existing editor and checkout remain available.");
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});

document.addEventListener("click", async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot?.bots) return;
  if (button.dataset.botPhase !== undefined) { selectedPhase = Number(button.dataset.botPhase); render(); return; }
  if (button.dataset.botCopy) {
    try { await navigator.clipboard.writeText(button.dataset.botCopy); notify("Checkout path copied. Open it in your editor."); }
    catch { notify("Copy the displayed checkout path into your editor."); }
    return;
  }
  if (button.hasAttribute("data-bot-template")) {
    pipelineDraft = developmentAgentConfig(readPipelineConfig());
    render();
    node<HTMLDetailsElement>(".pipeline-settings").open = true;
    node("#pipeline-config").scrollIntoView({ block: "start" });
    notify("Seven phase profiles prepared. Review the models, tools and approval gates, then save for future runs."); return;
  }
  const action = button.dataset.botAction;
  if (!action) return;
  const run = snapshot.pipelines?.runs.find(item => item.id === selectedRun) ?? snapshot.pipelines?.runs[0];
  if (!run) return;
  lock(true);
  try {
    await api("/api/bots", action === "start" ? { action, runId: run.id, expectedRevision: run.revision, requestId: botRequestId }
      : { action, attemptId: button.dataset.botAttempt, expectedHash: button.dataset.botHash ?? "" });
    if (action === "start") botRequestId = crypto.randomUUID();
    if (action === "accept") selectedPhase = undefined;
    await refresh();
    notify(action === "start" ? "Bot started. Its progress will appear in the timeline." : "Bot operation recorded.");
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});

function renderDeskSessions(): void {
  const list = document.querySelector("#desk-session-list");
  if (!list || !snapshot.pipelines) return;
  list.innerHTML = workList(snapshot.pipelines, selectedRun, sessionQuery);
  document.querySelectorAll<HTMLButtonElement>("[data-desk-filter]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.deskFilter === sessionFilter));
  });
}
document.addEventListener("input", event => {
  const input = event.target as HTMLInputElement;
  if (input.closest("#desk-start") && (input.name === "title" || input.name === "brief")) sessionDraft[input.name] = input.value;
  if (input.id === "desk-search") { sessionQuery = input.value; renderDeskSessions(); }
});
document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot) return;
  if (button.dataset.playbook) { selectedPlaybook = button.dataset.playbook; render(); }
  if (button.dataset.usePlaybook && (snapshot.roles.includes("admin") || snapshot.roles.includes("author"))) {
    const chosen = DEVELOPMENT_PLAYBOOKS.find(item => item.id === button.dataset.usePlaybook);
    if (chosen) {
      sessionDraft = { title: chosen.title, brief: playbookBrief(chosen) }; render();
      node<HTMLInputElement>("#desk-start input[name=title]").focus();
      notify("Starter loaded. Personalize the brief and stack before starting your session.");
    }
  }
  if (button.dataset.deskFilter) { sessionFilter = button.dataset.deskFilter as SessionFilter; renderDeskSessions(); }
  if (button.dataset.deskRun) { selectedRun = button.dataset.deskRun; selectedPhase = undefined; setView("desk"); }
  if (button.hasAttribute("data-desk-config")) {
    setView("pipelines");
    const config = document.querySelector<HTMLFormElement>("#pipeline-config");
    const section = config?.closest("details");
    if (section) { section.open = true; section.scrollIntoView({ block: "start" }); }
  }
});


const jiraDialog = node<HTMLDialogElement>("#jira-dialog");
let jiraDialogVersion = 0;
let jiraReview: { workspace: string; preview: JiraReview } | undefined;
jiraDialog.addEventListener("close", () => { jiraReview = undefined; jiraDialogVersion++; });

async function openJira(runId: string, eventId?: string, offset = 0): Promise<void> {
  const version = ++jiraDialogVersion;
  const workspace = selectedWorkspace;
  jiraReview = undefined;
  node("#jira-dialog-content").innerHTML = '<h2 id="jira-title">Loading Jira action…</h2><p class="muted">Reading the saved workflow event.</p><button class="secondary" data-close="jira-dialog">Close</button>';
  if (!jiraDialog.open) jiraDialog.showModal();
  lock(true);
  try {
    if (eventId) {
      const preview = await api("/api/jira", { action: "preview", runId, eventId }, workspace) as JiraReview;
      if (!jiraDialog.open || version !== jiraDialogVersion || workspace !== selectedWorkspace) return;
      jiraReview = { workspace, preview };
      node("#jira-dialog-content").innerHTML = jiraReviewView(preview);
    } else {
      const history = await api(`/api/jira?runId=${encodeURIComponent(runId)}&offset=${offset}`, undefined, workspace) as JiraHistory;
      if (!jiraDialog.open || version !== jiraDialogVersion || workspace !== selectedWorkspace) return;
      node("#jira-dialog-content").innerHTML = jiraHistoryView(history);
    }
  } catch (error) {
    if (version === jiraDialogVersion && jiraDialog.open) {
      node("#jira-dialog-content").innerHTML = `<h2 id="jira-title">Jira action unavailable</h2><p class="error-message" role="alert">${escape((error as Error).message)}</p><button class="secondary" data-close="jira-dialog">Close</button>`;
    }
  } finally { lock(false); }
}

document.addEventListener("change", event => {
  if ((event.target as HTMLElement).id === "jira-confirm-reviewed") {
    node<HTMLButtonElement>("#jira-confirm").disabled = busy || !node<HTMLInputElement>("#jira-confirm-reviewed").checked;
  }
});
document.addEventListener("click", async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot?.jira) return;
  if (button.dataset.jiraReview && button.dataset.jiraRun && snapshot.jira.canReview) {
    await openJira(button.dataset.jiraRun, button.dataset.jiraReview);
  } else if (button.dataset.jiraHistory) {
    await openJira(button.dataset.jiraHistory, undefined, Number(button.dataset.jiraOffset ?? 0));
  } else if (button.id === "jira-confirm" && jiraReview && snapshot.jira.canReview) {
    if (!node<HTMLInputElement>("#jira-confirm-reviewed").checked || jiraReview.workspace !== selectedWorkspace) return;
    const { workspace, preview } = jiraReview;
    const version = jiraDialogVersion;
    lock(true);
    try {
      await api("/api/jira", { action: "deliver", runId: preview.intent.runId, eventId: preview.intent.eventId,
        operation: preview.intent.operation, expectedIntentHash: preview.expectedIntentHash,
        ...(preview.intent.fields ? { fields: preview.intent.fields } : {}),
      }, workspace);
      jiraReview = undefined;
      if (version === jiraDialogVersion && jiraDialog.open && workspace === selectedWorkspace) {
        await openJira(preview.intent.runId);
        notify(preview.mode === "preview" ? "Jira preview saved locally. Nothing was sent." : "Jira attempt recorded. Check the evidence for its confirmed outcome.");
      }
    } catch (error) {
      const message = document.querySelector("#jira-error");
      if (version === jiraDialogVersion && message) message.textContent = (error as Error).message;
    } finally { lock(false); }
  }
});


document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || busy || !snapshot) return;
  if (button.hasAttribute("data-work-setup")) {
    const setup = node<HTMLDetailsElement>(".work-setup"); setup.open = true; setup.scrollIntoView({ block: "start", behavior: "smooth" });
    setup.querySelector<HTMLInputElement>("[name=root]")?.focus();
  }
  if (button.hasAttribute("data-work-new")) { selectedRun = undefined; selectedPhase = undefined; setView("desk"); }
  if (button.hasAttribute("data-work-federal")) {
    sessionDraft = { title: FEDERAL_SERVICE_STARTER.title, brief: FEDERAL_SERVICE_STARTER.brief };
    draftMaterials = [{ id: crypto.randomUUID(), title: "OpenFEMA disaster declarations · source to review", content: "", url: FEDERAL_SERVICE_STARTER.source }];
    render(); notify("Public-service brief loaded. Add source excerpts before asking an agent to rely on the data.");
  }
  if (button.dataset.materialRemove) { draftMaterials = draftMaterials.filter(item => item.id !== button.dataset.materialRemove); render(); }
  if (button.hasAttribute("data-work-enable") && snapshot.pipelines && snapshot.roles.includes("admin")) {
    void pipelineCommand({ action: "configure", expectedVersion: snapshot.pipelines.version, config: developmentAgentConfig(snapshot.pipelines.config) });
  }
});

document.addEventListener("change", async event => {
  const input = event.target as HTMLInputElement;
  if (busy || !snapshot) return;
  if (input.id === "work-reuse") {
    const material = snapshot.pipelines?.runs.flatMap(run => run.materials ?? []).find(item => item.id === input.value);
    if (!material || draftMaterials.some(item => item.id === material.id)) return;
    try { draftMaterials = materialsSchema.parse([...draftMaterials, structuredClone(material)]); render(); }
    catch (error) { notify((error as Error).message, true); }
  }
  if (input.id === "work-material-file" && input.files?.[0]) {
    const file = input.files[0];
    const form = input.closest("form")!;
    try {
      if (file.size > 24000 || !/\.(txt|md|csv|json)$/i.test(file.name)) throw new Error("Choose a text, Markdown, CSV or JSON file under 24 KB.");
      const text = await file.text();
      if (text.length > 6000 || text.includes("\0")) throw new Error("Use a text excerpt of at most 6000 characters.");
      if (!form.isConnected) return;
      form.querySelector<HTMLTextAreaElement>("[name=content]")!.value = text;
      const title = form.querySelector<HTMLInputElement>("[name=title]")!;
      if (!title.value) title.value = file.name.slice(0, 120);
      notify("Text imported into the reference form. Click Add reference to include it.");
    } catch (error) { notify((error as Error).message, true); }
  }
});

document.addEventListener("submit", async event => {
  const form = event.target as HTMLFormElement;
  if (!["work-material", "work-ontology", "work-project", "work-revision"].includes(form.id)) return;
  event.preventDefault(); if (busy) return;
  const data = new FormData(form);
  lock(true);
  try {
    if (form.id === "work-ontology") {
      const workspace = selectedWorkspace;
      const material = await api("/api/ontology/reference", { objectType: String(data.get("objectType")), primaryKey: String(data.get("primaryKey")) }, workspace);
      if (workspace !== selectedWorkspace || !form.isConnected) return;
      draftMaterials = materialsSchema.parse([...draftMaterials, material]);
      render(); notify("Ontology snapshot added. Review the reference before starting the work item.");
    } else if (form.id === "work-material") {
      draftMaterials = materialsSchema.parse([...draftMaterials, { id: crypto.randomUUID(), title: String(data.get("title")), content: String(data.get("content")), ...(data.get("url") ? { url: String(data.get("url")) } : {}) }]);
      render(); notify("Reference added to this draft.");
    } else if (form.id === "work-project") {
      const executable = String(data.get("executable")).trim();
      const args = String(data.get("args")).split(/\r?\n/).map(arg => arg.trim()).filter(Boolean);
      if (!executable && args.length) throw new Error("Provide a check executable for these arguments.");
      await api("/api/bots", { action: "attach", project: { root: String(data.get("root")), checks: executable ? [{ executable, args }] : [] } });
      await refresh(); notify("Repository connected. Start a work item when you are ready.");
    } else {
      const run = snapshot.pipelines?.runs.find(item => item.id === selectedRun);
      if (!run) throw new Error("Select a work item before requesting a revision.");
      await api("/api/bots", { action: "start", runId: run.id, expectedRevision: run.revision, requestId: botRequestId,
        revisionSource: { attemptId: form.dataset.attempt, expectedHash: form.dataset.hash, feedback: String(data.get("feedback")) } });
      botRequestId = crypto.randomUUID(); await refresh(); notify("Revision started with your feedback and the original reference material.");
    }
  } catch (error) { notify((error as Error).message, true); }
  finally { lock(false); }
});
