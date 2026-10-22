// This page is a scripted presentation. It never calls a workspace or a model API.
const steps = [
  { name: "Workspace", title: "Start with the team and its boundaries.", state: "Sample company",
    description: "An author prepares an internal documentation task. Reviewers hold the approval gate.",
    artifact: '<div class="artifact-label">Sample workspace / Delivery operations</div><div class="sample-roles"><span>Author<br><b>Prepare + request</b></span><span>Agent<br><b>Read + draft</b></span><span>Reviewers<br><b>Check + approve</b></span></div>',
    backend: "Company mode verifies Clerk organization membership and maps roles to this workspace. An email address alone does not grant access.",
    notes: "This is a synthetic company illustration. The real local workspace uses a local session; the company service is a separate authenticated entry point." },
  { name: "Request", title: "Give the workflow a concrete deliverable.", state: "Draft request",
    description: "An employee asks how to request repository access. The expected result is a cited answer, not a permission change.",
    artifact: '<div class="artifact-label">Work item / DOC-001 · synthetic</div><blockquote>How do I request repository access, who approves it, and how long should it take?</blockquote><p><b>Acceptance:</b> name the approver, timing and missing-approval path; cite the SOP; claim no access was granted.</p>',
    backend: "The pipeline stores a run with its workflow configuration and references. Later template edits do not silently change an existing run.",
    notes: "Tie the automation to a business outcome: reduce repeated policy lookups while retaining a human review record." },
  { name: "Grounding", title: "Give the agent evidence and limited tools.", state: "Read-only task",
    description: "The documentation agent receives the SOP and a source-read requirement. It has no permission to grant access.",
    artifact: '<div class="artifact-label">SOP.md / §2 Repository access · synthetic source</div><blockquote>Requests require team owner approval. Once approved, the response target is two business days. Requests missing approval are returned to the requester.</blockquote><div class="sample-tools"><code>read_project_file</code><span>Local repository demo tool</span></div><p class="small">Company assistant stages use workspace document tools instead of unrestricted host repository access.</p>',
    backend: "Tool grants, step limits and source requirements are enforced by the execution path. Retrieved documents are treated as data, not authority to change policy.",
    notes: "Local repository agents and company document assistants use different execution paths. The same review discipline applies without claiming they have identical tools." },
  { name: "Draft", title: "Inspect the answer beside its evidence.", state: "Scripted answer",
    description: "Execution finished. A person still needs to check whether the answer is supported.",
    artifact: '<div class="artifact-label">Illustrative agent output</div><ol><li>Obtain team owner approval. [SOP.md §2]</li><li>The response target is two business days after approval. [SOP.md §2]</li><li>Requests without approval are returned. [SOP.md §2]</li></ol><p>No access has been granted.</p><div class="sample-tools"><span>Evidence: SOP.md §2</span><span>Tokens: unavailable in this illustration</span></div>',
    backend: "The execution record separates model completion, tool evidence, automated checks and human quality review. A source read does not prove correctness.",
    notes: "Do not present the scripted answer or absent token count as a model benchmark. Run the real demo with a configured provider to assess model output." },
  { name: "Review", title: "The author cannot sign their own handoff.", state: "Approval gate",
    description: "This scenario requires two distinct independent reviewers. Use the simulated controls to demonstrate the boundary.",
    artifact: "",
    backend: "Real gated handoffs check current roles, run owner, output author, revision and output hash on the server. Duplicate approvals cannot count twice.",
    notes: "These buttons simulate reviewer identities; they do not sign real records. In a single-owner company workspace, stop here until eligible reviewers join." },
  { name: "Handoff", title: "Advance only with the required evidence.", state: "Gate checked",
    description: "The next stage receives the reviewed output and the existing run context.",
    artifact: "",
    backend: "The workflow engine advances the stage after its completion and approval conditions are satisfied. UI navigation cannot bypass those conditions.",
    notes: "Show the locked state before signing, then return after the simulated reviews. Handoff here is not deployment to a cloud environment." },
  { name: "Audit", title: "Leave a record the company can inspect.", state: "Audit summary",
    description: "Keep the output and review history in Magentic. Company messaging is a separate, human-controlled action.",
    artifact: '<div class="artifact-label">Illustrative audit summary / DOC-001</div><p>Request → source → draft → independent review → handoff.</p><p><b>Slack:</b> an administrator previews a company audit summary or team update before sending. Delivery receipts distinguish accepted from unconfirmed delivery.</p><p class="small">No Slack message is sent here. Slack cannot approve or execute work.</p>',
    backend: "Audit and delivery records remain workspace scoped. The Slack endpoint checks company-session authority and persists a receipt before a network request.",
    notes: "Finish with accountability: what was used, what was produced, who reviewed it and what happened next. Separate audit evidence from a claim of regulatory compliance." },
];
let current = 0;
let revision = 1;
const signatures = new Set();
let feedback = "";
const byId = id => document.getElementById(id);
const complete = () => signatures.size === 2;
function renderDemo() {
  const step = steps[current];
  byId("demo-steps").innerHTML = steps.map((item, index) => '<button data-step="' + index + '"' + (index === current ? ' aria-current="step"' : '') + '><span>' + String(index + 1).padStart(2, "0") + '</span>' + item.name + '</button>').join("");
  byId("demo-position").textContent = "Step " + (current + 1) + " / " + steps.length;
  byId("demo-state").textContent = current === 4 ? signatures.size + " / 2 simulated approvals" : current === 5 ? complete() ? "Illustrative handoff ready" : "Blocked by review" : step.state;
  byId("demo-title").textContent = step.title;
  byId("demo-description").textContent = step.description;
  byId("demo-backend").textContent = step.backend;
  byId("demo-notes").textContent = step.notes;
  let artifact = step.artifact;
  if (current === 4) {
    artifact = '<div class="artifact-label">Sample draft / revision ' + revision + '</div><p>Approvals below apply only to this sample revision. Two reviewers is this scenario’s policy, not a fixed rule for every workspace.</p><div class="review-actions"><button class="btn" data-review="owner">Try owner approval</button>' +
      ["a", "b"].map(reviewer => '<button class="btn" data-review="' + reviewer + '"' + (signatures.has(reviewer) ? " disabled" : "") + '>Simulate reviewer ' + reviewer.toUpperCase() + (signatures.has(reviewer) ? " ✓" : "") + '</button>').join("") +
      '</div><button class="text-button" data-revise>Revise sample draft → require fresh review</button>';
  }
  if (current === 5) artifact = complete()
    ? '<div class="artifact-label">Sample handoff / revision ' + revision + '</div><p class="gate-ready">Two distinct simulated reviews recorded for the current draft.</p><p>The next stage may continue with the reviewed answer and source reference.</p>'
    : '<div class="artifact-label">Handoff withheld</div><p>Return to Review and collect two independent simulated approvals for this draft.</p><button class="btn" data-step="4">Return to review</button>';
  byId("demo-artifact").innerHTML = artifact;
  byId("demo-feedback").textContent = feedback;
  byId("demo-back").disabled = current === 0;
  byId("demo-next").disabled = current === steps.length - 1 || ((current === 4 || current === 5) && !complete());
  byId("demo-next").textContent = current === steps.length - 1 ? "Walkthrough complete" : "Next: " + steps[current + 1].name;
}
function navigate(index) { current = index; feedback = ""; renderDemo(); }
byId("demo").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.step !== undefined) navigate(Number(button.dataset.step));
  else if (button.dataset.review) {
    if (button.dataset.review === "owner") feedback = "Blocked: the run owner cannot approve their own gated handoff.";
    else { signatures.add(button.dataset.review); feedback = complete() ? "Two independent simulated reviews. Handoff is ready." : "One review recorded. A second independent review is still required."; }
    renderDemo();
  } else if (button.hasAttribute("data-revise")) {
    revision++; signatures.clear(); feedback = "Draft revised. Earlier reviews no longer cover this version."; renderDemo();
  } else if (button.id === "demo-next") navigate(current + 1);
  else if (button.id === "demo-back") navigate(current - 1);
  else if (button.id === "demo-reset") { revision = 1; signatures.clear(); navigate(0); }
});
const source = "https://github.com/nsirivolu27/Magentic.AI/blob/codex/published-main-preview/";
const layers = {
  frontend: { title: "A workspace UI over typed state", stack: "HTML · CSS tokens · TypeScript · React 19",
    detail: "Hash-based navigation opens workspace views, evidence and review controls. Most pages render HTML from a typed snapshot; React powers the interactive work queue. esbuild bundles the browser.",
    boundary: "The page can explain a permission or hide a button. Only the server can authorize the action.",
    files: ["workbench/browser.ts", "workbench/snapshot.ts", "workbench/operations-queue.tsx", "workbench/agency.css"] },
  backend: { title: "Explicit commands, validated boundaries", stack: "Node.js 22 · ESM · Zod · file-backed JSON",
    detail: "HTTP handlers authenticate requests and validate payloads. Workflow engines check revisions, roles and approvals. Atomic file writes persist workspace records; current company storage assumes one writer per data directory.",
    boundary: "A hosted rollout still needs operational design for durable shared storage, backups, isolation and recovery.",
    files: ["workbench/server.ts", "workbench/pipeline.ts", "workbench/storage.ts", "registry/record.ts"] },
  execution: { title: "Models draft; granted tools supply context", stack: "MCP SDK · Ollama / configured providers · bounded execution",
    detail: "Approved assistant stages resolve their release before running. The scheduler connects stage agents to their granted workspace MCP tools. Local repository agents use a separate worker path with explicit policies.",
    boundary: "An agent has no blanket company role. Missing model connectivity or invalid release evidence blocks execution.",
    files: ["workbench/scheduler.ts", "workbench/stage-agent.ts", "workbench/pipeline-mcp.ts", "workbench/bot-worker.ts"] },
  company: { title: "Membership before access", stack: "Clerk Organizations · workspace roles · configured integrations",
    detail: "Company sign-in resolves organization membership, then workspace roles. Stripe entitlement is separate from membership. Documents, workflow state and receipts are scoped to the authenticated workspace.",
    boundary: "Slack supports company audit messages and updates only. Reviewed Lambda invocation and evidence connectors need separate configuration.",
    files: ["workbench/company-server.ts", "workbench/company-access.ts", "workbench/automation-runtime.ts", "workbench/slack.ts"] },
};
function renderLayer(key) {
  const layer = layers[key];
  document.querySelectorAll("[data-layer]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.layer === key)));
  byId("architecture-detail").innerHTML = '<div><span class="eyebrow">' + layer.stack + '</span><h3>' + layer.title + '</h3><p>' + layer.detail + '</p><p class="architecture-boundary">' + layer.boundary + '</p></div><nav aria-label="Source files">' +
    layer.files.map(file => '<a href="' + source + file + '" target="_blank" rel="noopener"><code>' + file + '</code><span aria-hidden="true">↗</span></a>').join("") + '</nav>';
}
document.querySelectorAll("[data-layer]").forEach(button => button.addEventListener("click", () => renderLayer(button.dataset.layer)));
byId("print-presentation").addEventListener("click", () => window.print());
renderDemo();
renderLayer("frontend");
