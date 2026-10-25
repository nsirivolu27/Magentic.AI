import type { Role } from "../registry/roles.js";
import type { BotAttempt } from "./bot-schema.js";
import type { PipelineRun } from "./pipeline.js";
import type { ScheduledJob } from "./scheduler.js";
import type { StudioUi } from "./studio-view.js";
import { ago, escape, more, status, type Tone } from "./ui.js";
import { jobFor } from "./units.js";

/**
 * What an attempt recorded about its sources and tools, read back from the
 * attempt's event log. Only recorded facts appear; an attempt that recorded
 * nothing says so instead of implying it read nothing.
 */
export interface EvidenceTrail {
  reads: { path: string; outcome: "read" | "empty" | "missing"; detail: string }[];
  tools: { name: string; blocked: boolean }[];
}

export function evidenceTrail(attempt: Pick<BotAttempt, "events"> | undefined): EvidenceTrail {
  const trail: EvidenceTrail = { reads: [], tools: [] };
  for (const event of attempt?.events ?? []) {
    const read = /^Source (read|empty|missing): (.+?)(?: \((\d+) characters\))?$/.exec(event.message);
    if (read) { trail.reads.push({ path: read[2]!, outcome: read[1] as "read" | "empty" | "missing", detail: read[3] ? `${Number(read[3]).toLocaleString("en-US")} characters` : read[1] === "empty" ? "empty" : "missing" }); continue; }
    const tool = /^(Blocked )?MCP tool: (.+)$/.exec(event.message);
    if (tool) trail.tools.push({ name: tool[2]!, blocked: Boolean(tool[1]) });
  }
  return trail;
}

function evidenceTrailHtml(trail: EvidenceTrail): string {
  const reads = trail.reads.length
    ? `<ul class="plain evidence-trail">${trail.reads.map(read => `<li>${status(read.outcome === "read" ? "ok" : read.outcome === "empty" ? "warn" : "bad", read.outcome === "read" ? "Read" : read.outcome === "empty" ? "Empty" : "Missing")} <code>${escape(read.path)}</code><small class="text-3"> · ${escape(read.detail)}</small></li>`).join("")}</ul>`
    : `<p class="fine">No source reads recorded.</p>`;
  const tools = trail.tools.length
    ? `<ul class="plain evidence-trail">${trail.tools.map(tool => `<li>${status(tool.blocked ? "bad" : "neutral", tool.blocked ? "Blocked" : "Tool")} <code>${escape(tool.name)}</code></li>`).join("")}</ul>`
    : `<p class="fine">No tool calls recorded.</p>`;
  return reads + tools;
}

/**
 * Output review: everything a person needs to accept a stage's output, in
 * one place, in the same order on every page: the evidence the agent had,
 * what the agent produced, the handoff the owner is about to record, and
 * who still has to approve it. The vocabulary of states is fixed here so a
 * stage reads the same on the work item, the workflow and the queue.
 */

export interface StageState { tone: Tone; label: string }

/** Who is responsible for the current stage right now and what they do next. Derived, never stored. */
export interface RunNow { stageName: string; who: string; state: StageState; action: string; href: string }

export function runNow(run: PipelineRun, options: { jobs?: ScheduledJob[]; attempt?: BotAttempt; actor: string; roles: readonly Role[]; assistantUsable?: boolean }): RunNow {
  const stage = run.config.stages[run.current]!;
  const progress = run.stages[run.current]!;
  const href = `#/desk/${run.id}`;
  const owner = run.owner === options.actor ? "You" : run.owner;
  const job = jobFor(options.jobs, run, stage.id);
  const reviewer = (options.roles.includes("approver") || options.roles.includes("admin")) && options.actor !== run.owner && options.actor !== progress.outputBy && !progress.approvals.includes(options.actor);
  const base = { stageName: stage.name, href };
  if (run.status === "complete") return { ...base, who: "Nobody", state: { tone: "ok", label: "Done" }, action: "All stages complete" };
  if (run.status === "cancelled") return { ...base, who: "Nobody", state: { tone: "neutral", label: "Cancelled" }, action: "Nothing to do" };
  if (run.status === "blocked") return { ...base, who: owner, state: { tone: "bad", label: "Blocked" }, action: owner === "You" ? "Resolve the block" : `Waiting on ${run.owner}` };
  if (run.status === "paused") return { ...base, who: owner, state: { tone: "neutral", label: "Paused" }, action: owner === "You" ? "Resume the run" : `Waiting on ${run.owner}` };
  if (progress.status === "awaiting_review") {
    const count = `${progress.approvals.length} of ${run.requiredApprovals}`;
    return { ...base, who: `Independent reviewers · ${count}`, state: { tone: "warn", label: "Awaiting approval" }, action: reviewer ? "Review and approve" : `Waiting for approvals · ${count}` };
  }
  if (stage.assistantId && options.assistantUsable === false) return { ...base, who: owner, state: { tone: "bad", label: "Not connected" }, action: owner === "You" ? "Record the output by hand or fix the assistant" : `Waiting on ${run.owner}` };
  if (progress.draft) return { ...base, who: owner, state: { tone: "info", label: "Draft ready" }, action: owner === "You" ? "Review the draft" : `Waiting on ${run.owner}` };
  if (job?.status === "failed" || job?.status === "cancelled") return { ...base, who: owner, state: { tone: "bad", label: "Draft failed" }, action: owner === "You" ? "Retry or write the output" : `Waiting on ${run.owner}` };
  if (job?.status === "queued" || job?.status === "running") return { ...base, who: job.assistant || "Assistant", state: { tone: "progress", label: "Drafting" }, action: "Assistant is drafting" };
  if (options.attempt?.status === "running") return { ...base, who: options.attempt.assistant?.name ?? `${stage.bot?.kind ?? "agent"} agent`, state: { tone: "progress", label: "Agent working" }, action: "Agent is working" };
  if (options.attempt && ["ready", "applied"].includes(options.attempt.status)) return { ...base, who: owner, state: { tone: "info", label: "Result ready" }, action: owner === "You" ? "Review the result" : `Waiting on ${run.owner}` };
  if (options.attempt && ["failed", "cancelled", "interrupted"].includes(options.attempt.status)) return { ...base, who: owner, state: { tone: "bad", label: "Agent failed" }, action: owner === "You" ? "Retry or write the output" : `Waiting on ${run.owner}` };
  if (!stage.assistantId && (!stage.bot || stage.bot.kind === "manual")) return { ...base, who: `${owner} · ${stage.agent}`, state: { tone: "neutral", label: "By hand" }, action: owner === "You" ? "Record the output" : `Waiting on ${run.owner}` };
  return { ...base, who: owner, state: { tone: "progress", label: "In progress" }, action: owner === "You" ? "Run the agent" : `Waiting on ${run.owner}` };
}

export interface ReviewOptions {
  run: PipelineRun; phase: number; actor: string; roles: readonly Role[];
  attempt?: BotAttempt; jobs?: ScheduledJob[]; ui?: StudioUi;
  /** The work item page can run commands against the selected run; the workflow page links to it instead. */
  where: "desk" | "workflows";
  /** Whether the work item is free to take a command right now. */
  busy?: boolean;
  /** True when the attempt belongs to the run's current revision, so its result can still be accepted. */
  attemptCurrent?: boolean;
}

const pill = (state: StageState) => status(state.tone, state.label);

/** The four blocks: evidence, original output, handoff, approval. Owners edit; everyone else reads. */
export function outputReview(options: ReviewOptions): string {
  const { run, phase, actor, roles, attempt, ui } = options;
  const stage = run.config.stages[phase]!;
  const progress = run.stages[phase]!;
  const owner = roles.includes("admin") || (run.owner === actor && roles.includes("author"));
  const current = phase === run.current && run.status === "running";
  const active = current && progress.status === "active";
  const job = jobFor(options.jobs, run, stage.id);

  // Evidence: what the agent could see, and what it did with it. Nothing here is a claim of correctness.
  const materials = run.materials ?? [];
  const trail = evidenceTrail(attempt);
  const reads = trail.tools.filter(tool => !tool.blocked).length;
  const checks = attempt?.checks ?? [];
  const evidence = `<div class="review-block" aria-label="Evidence"><h4>Evidence</h4>
    ${materials.length ? `<ul class="plain">${materials.map(item => `<li>${item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.title)} ↗</a>` : escape(item.title)}<small class="text-3"> · ${item.content ? `${item.content.length.toLocaleString("en-US")} characters` : "link only, not fetched"}</small></li>`).join("")}</ul>` : '<p class="text-3">No reference material attached.</p>'}
    ${attempt ? `<p class="fine">${trail.reads.length} source ${trail.reads.length === 1 ? "read" : "reads"} · ${reads} tool ${reads === 1 ? "call" : "calls"} · ${checks.length ? checks.every(check => check.passed) ? status("ok", `${checks.length} ${checks.length === 1 ? "check" : "checks"} passed`) : status("bad", `${checks.filter(check => !check.passed).length} of ${checks.length} checks failed`) : "No validation checks recorded"}</p>` : job?.usage ? `<p class="fine">Drafted by ${escape(job.assistant)} on ${escape(job.model)}</p>` : ""}
    ${attempt ? evidenceTrailHtml(trail) : ""}
    ${phase ? `<p class="fine">Earlier stages: ${run.stages.slice(0, phase).map((item, index) => `${escape(run.config.stages[index]!.name)} ${item.status === "complete" ? "✓" : "○"}`).join(" · ")}</p>` : ""}</div>`;

  // Original output: the agent's words, untouched, so an edited handoff can always be compared against them.
  const original = progress.draft ? more("Original agent draft", `<pre class="pre">${escape(progress.draft.text)}</pre>`, true)
    : attempt?.summary ? more(`Original agent output · ${escape(attempt.status)}`, `<pre class="pre">${escape(attempt.summary)}</pre>`, true)
    : attempt?.error ? `<p class="callout bad" role="status"><strong>No output.</strong>${escape(attempt.error)}</p>`
    : job && (job.status === "failed" || job.status === "cancelled") ? `<p class="callout bad" role="status"><strong>No draft.</strong>${escape(job.error)}</p>`
    : `<p class="text-3">${stage.assistantId || (stage.bot && stage.bot.kind !== "manual") ? "The agent has not produced output for this stage yet." : "This stage is done by hand; there is no agent output."}</p>`;
  const originalBlock = `<div class="review-block" aria-label="Original output"><h4>Original output</h4>${progress.draft ? `<p class="fine">${escape(progress.draft.by)} · ${escape(ago(progress.draft.at))}</p>` : attempt ? `<p class="fine">${escape(attempt.model)} · ${escape(ago(attempt.startedAt))}</p>` : ""}${original}</div>`;

  // Handoff: what gets recorded. Editable by the owner while the stage is open; read only once recorded.
  let handoff: string;
  if (progress.output) {
    handoff = `<p class="fine">Recorded by ${escape(progress.outputBy)}${progress.completedAt ? ` · ${escape(ago(progress.completedAt))}` : ""}</p><pre class="pre">${escape(progress.output)}</pre>`;
  } else if (active && owner && progress.draft) {
    const key = `output:${run.id}:${progress.draft.hash}`;
    const edited = ui?.drafts[key];
    const stale = edited?.expectedRevision && edited.expectedRevision !== String(run.revision);
    handoff = `<form data-output-review data-draft="${key}" data-run="${run.id}" data-revision="${escape(edited?.expectedRevision ?? String(run.revision))}"><label class="field"><span>Review output</span><textarea name="note" rows="6" required maxlength="4000">${escape(edited?.note ?? progress.draft.text)}</textarea></label><p class="fine">Edit freely; the original draft stays above. Check sources and open questions before handing off.</p>${stale ? `<p class="callout warn" role="alert"><strong>This workflow changed.</strong>Copy any edits you need, then reload the saved draft and review the current context. <button type="button" class="secondary small" data-output-reset="${key}">Reload saved draft</button></p>` : ""}<div class="actions mt8"><button class="primary small" type="submit" ${options.busy ? "disabled" : ""}>${stage.approval ? "Submit for review" : "Complete stage & hand off"}</button>${options.where === "workflows" ? `<a class="quiet small" href="#/desk/${run.id}">Open work item</a>` : ""}</div></form>`;
  } else if (active && owner && options.where === "desk" && !options.busy && attempt && options.attemptCurrent && ["ready", "applied"].includes(attempt.status)) {
    handoff = `<p class="text-2">Accept the agent result above to record it as the handoff, or request changes. The accepted output carries its evidence trail.</p>`;
  } else if (active && owner && options.where === "desk" && !options.busy) {
    handoff = `<form id="pipeline-output"><label class="field"><span>Work completed and supporting evidence</span><textarea name="note" required maxlength="4000" rows="5"></textarea></label><p class="fine">Nothing is recorded until you submit.</p><button class="secondary small">${stage.approval ? "Record and submit for review" : "Record handoff"}</button></form>`;
  } else if (active && owner) {
    handoff = `<p class="text-2">Record the handoff from the <a href="#/desk/${run.id}">work item</a>.</p>`;
  } else if (active) {
    handoff = `<p class="text-2">${escape(run.owner)} records the handoff for this stage.</p>`;
  } else {
    handoff = `<p class="text-3">Not reached yet.</p>`;
  }
  const handoffBlock = `<div class="review-block review-handoff" aria-label="Handoff"><h4>Handoff</h4>${handoff}</div>`;

  // Approval: who still has to agree, and why this person can or cannot.
  let approval: string;
  if (!stage.approval) approval = `${pill({ tone: "neutral", label: "No review gate" })}<p class="fine">The owner's handoff completes this stage.</p>`;
  else if (progress.status === "complete") approval = `${pill({ tone: "ok", label: "Approved" })}<p class="fine">${progress.approvals.length ? `Approved by ${progress.approvals.map(escape).join(", ")}` : "Completed"}.</p>`;
  else if (progress.status === "awaiting_review" && current) {
    const eligible = (roles.includes("admin") || roles.includes("approver")) && actor !== run.owner && actor !== progress.outputBy && !progress.approvals.includes(actor);
    const reason = progress.approvals.includes(actor) ? "Your approval is recorded." : actor === run.owner || actor === progress.outputBy ? "The owner and the author of the output cannot approve it." : "An approver or admin approves handoffs.";
    approval = `${pill({ tone: "warn", label: "Awaiting approval" })}<p class="fine">${progress.approvals.length} of ${run.requiredApprovals} approvals${progress.approvals.length ? ` · ${progress.approvals.map(escape).join(", ")}` : ""}</p>
      ${eligible ? options.where === "desk" ? `<button class="primary" data-pipeline-action="approve" ${options.busy ? "disabled" : ""}>Approve this handoff</button>` : `<a class="primary small" href="#/desk/${run.id}">Review on the work item</a>` : `<p class="text-2">${reason}</p>`}`;
  } else approval = `${pill({ tone: "neutral", label: "Review gate" })}<p class="fine">${run.requiredApprovals} independent approvals after the handoff is submitted.</p>`;
  // The audit package is the same facts as this grid, as a file an auditor can keep and verify offline.
  const auditLinks = `<p class="fine audit-links">Audit package: <a href="/api/audit-package?run=${encodeURIComponent(run.id)}&amp;format=markdown" download>Markdown</a> · <a href="/api/audit-package?run=${encodeURIComponent(run.id)}&amp;format=json" download>JSON</a></p>`;
  const approvalBlock = `<div class="review-block" aria-label="Approval"><h4>Approval</h4>${approval}${auditLinks}</div>`;

  return `<div class="review-grid">${evidence}${originalBlock}${handoffBlock}${approvalBlock}</div>`;
}
