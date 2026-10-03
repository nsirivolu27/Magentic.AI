import type { WorkbenchSnapshot } from "./snapshot.js";
import type { PipelineRun } from "./pipeline.js";
import type { Page, StudioUi } from "./studio-view.js";
import { empty, escape, more, panel, status } from "./ui.js";

// The server still checks permissions and output hashes. These checks keep
// employees from being offered actions that the server would refuse.
export function canReviewTask(snapshot: WorkbenchSnapshot, run: PipelineRun): boolean {
  const stage = run.stages[run.current];
  return run.status === "running" && stage?.status === "awaiting_review"
    && (snapshot.roles.includes("approver") || snapshot.roles.includes("admin"))
    && snapshot.actor !== run.owner && snapshot.actor !== stage.outputBy
    && !stage.approvals.includes(snapshot.actor);
}

function taskStatus(run: PipelineRun): string {
  if (run.status === "complete") return status("ok", "Finished");
  if (run.status === "cancelled") return status("neutral", "Cancelled");
  if (run.status === "blocked") return status("bad", "Needs help");
  if (run.status === "paused") return status("neutral", "Paused");
  return run.stages[run.current]?.status === "awaiting_review" ? status("warn", "Waiting for review") : status("progress", "In progress");
}

export function taskList(snapshot: WorkbenchSnapshot, limit?: number): string {
  const runs = [...(snapshot.pipelines?.runs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!runs.length) return empty("No tasks yet.", snapshot.canAuthor && snapshot.pipelines ? { label: "Start a task", href: "#/tasks/new" } : undefined);
  return `<ul class="employee-task-list">${runs.slice(0, limit ?? runs.length).map((run) => `<li><a href="#/tasks/${escape(run.id)}"><div><strong>${escape(run.title)}</strong><small>${escape(run.owner)} · ${run.status === "complete" ? "All steps complete" : escape(run.config.stages[run.current]?.name)}</small></div><span>${canReviewTask(snapshot, run) ? status("warn", "Your review needed") : taskStatus(run)}</span><span aria-hidden="true">→</span></a></li>`).join("")}</ul>`;
}

export function tasksPage(snapshot: WorkbenchSnapshot, id: string | undefined, ui: StudioUi): Page {
  const crumbs: [string, string][] = [["Tasks", "#/tasks"]];
  if (!snapshot.pipelines) return { title: "Tasks", body: empty("Tasks are not available in this workspace yet.") };
  if (!id) return { title: "Tasks", context: "Follow your work, one step at a time.", actions: snapshot.canAuthor ? '<a class="btn primary" href="#/tasks/new">Start a task</a>' : "", body: panel("Workspace tasks", taskList(snapshot)) };
  if (id === "new") {
    if (!snapshot.canAuthor) return { title: "Start a task", crumbs, body: empty("Ask a workspace author to start this task.") };
    const draft = ui.drafts["employee-task"] ?? {};
    return { title: "Start a task", crumbs, context: snapshot.pipelines.config.name, body: `<div class="employee-focus">${panel("What do you need done?", `<form id="employee-task" data-draft="employee-task" class="panel-body employee-form">
      <label>Task name<input name="title" required minlength="3" maxlength="160" placeholder="Prepare an onboarding guide" value="${escape(draft.title)}"></label>
      <label>Desired outcome<textarea name="brief" required maxlength="4000" rows="3" placeholder="Who is this for, and what should they receive?">${escape(draft.brief)}</textarea></label>
      <label>Reference notes <span class="text-3">(optional)</span><textarea name="notes" maxlength="6000" rows="3" placeholder="Paste relevant guidance for the team and assistants.">${escape(draft.notes)}</textarea></label>
      <div class="employee-actions"><a class="btn" href="#/tasks">Cancel</a><button class="primary" type="submit">Start task</button></div>
    </form>`)}${more("Steps in this task", `<ol class="employee-outline">${snapshot.pipelines.config.stages.map((stage) => `<li>${escape(stage.name)}${stage.approval ? " · review required" : ""}</li>`).join("")}</ol>`)}</div>` };
  }
  const run = snapshot.pipelines.runs.find((item) => item.id === id);
  if (!run) return { title: "Task not found", crumbs, body: empty("This task is not in the current workspace.", { label: "Back to tasks", href: "#/tasks" }) };
  const stage = run.stages[run.current]!;
  const definition = run.config.stages[run.current]!;
  const owner = snapshot.roles.includes("admin") || (run.owner === snapshot.actor && snapshot.roles.includes("author"));
  const draftKey = `employee-output:${run.id}:${run.current}:${run.revision}`;
  const field = `<input type="hidden" name="runId" value="${escape(run.id)}"><input type="hidden" name="revision" value="${run.revision}">`;
  let action = "";
  if (run.status === "running" && stage.status === "active") {
    const job = snapshot.schedule?.jobs.find((item) => item.runId === run.id && item.stageId === definition.id && (item.status === "queued" || item.status === "running"));
    action = `${job ? '<p role="status">An assistant is preparing a draft. You can also write the result below.</p>' : ""}${owner
      ? `<form id="employee-complete" data-draft="${draftKey}" class="employee-form">${field}<label>${stage.draft ? "Review the assistant’s draft" : "Your result"}<textarea name="note" required maxlength="4000" rows="8" placeholder="Add the completed work or supporting evidence.">${escape(ui.drafts[draftKey]?.note ?? stage.draft?.text ?? "")}</textarea></label><div class="employee-actions"><button class="primary" type="submit">${definition.approval ? "Send for review" : "Complete step"}</button></div></form>`
      : `<p>${escape(run.owner)} is responsible for this step.</p>${stage.draft ? more("Assistant draft", `<pre class="employee-output">${escape(stage.draft.text)}</pre>`) : ""}`}`;
  } else if (run.status === "running" && stage.status === "awaiting_review") {
    action = `<pre class="employee-output">${escape(stage.output)}</pre><p>${stage.approvals.length} of ${run.requiredApprovals} approvals</p>${canReviewTask(snapshot, run)
      ? `<form id="employee-approve">${field}<button class="primary" type="submit">Approve this step</button></form>`
      : `<p class="text-2">${stage.approvals.includes(snapshot.actor) ? "Your approval is recorded." : run.owner === snapshot.actor || stage.outputBy === snapshot.actor ? "A different reviewer must approve this work." : "Waiting for an authorized reviewer."}</p>`}`;
  } else if (run.status === "complete") {
    action = `<p>All steps are complete.</p><pre class="employee-output">${escape(stage.output)}</pre>`;
  } else {
    action = `<p>${run.status === "blocked" ? escape(run.events.at(-1)?.detail ?? "This task needs help.") : run.status === "paused" ? "Work on this task is paused." : "This task was cancelled."}</p>${owner && (run.status === "paused" || run.status === "blocked") ? `<form id="employee-resume">${field}<input type="hidden" name="action" value="${run.status === "paused" ? "resume" : "retry"}"><button class="primary" type="submit">Resume task</button></form>` : ""}`;
  }
  const steps = `<ol class="employee-steps" aria-label="Task progress">${run.config.stages.map((item, index) => `<li${index === run.current ? ' aria-current="step"' : ""}><span class="employee-step-number">${run.stages[index]?.status === "complete" ? "✓" : index + 1}</span><div>${escape(item.name)}<small>${run.stages[index]?.status === "complete" ? "Complete" : index === run.current ? "Current step" : "Up next"}</small></div></li>`).join("")}</ol>`;
  const history = run.stages.map((item, index) => item.status === "complete" ? more(run.config.stages[index]!.name, `<pre class="employee-output">${escape(item.output)}</pre>`) : "").join("");
  return { title: run.title, crumbs, context: `${run.owner} · ${run.config.name}`, actions: taskStatus(run), body: `<div class="employee-task-layout"><aside>${steps}</aside><div>${panel(run.status === "complete" ? "Finished" : definition.name, `<div class="panel-body">${run.status === "complete" ? "" : `<p class="employee-instructions">${escape(definition.instructions)}</p>`}${action}</div>`)}${more("Task brief and references", `<p class="employee-output">${escape(run.brief)}</p>${(run.materials ?? []).map((item) => `<h3>${escape(item.title)}</h3><pre class="employee-output">${escape(item.content)}</pre>`).join("")}`)}${history ? more("Completed steps", history) : ""}</div></div>` };
}
