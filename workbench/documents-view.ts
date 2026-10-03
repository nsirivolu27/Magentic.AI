import type { WorkbenchSnapshot } from "./snapshot.js";
import type { DocumentRecord } from "./documents.js";
import { viewerOf } from "./studio-model.js";
import type { Page, StudioUi } from "./studio-view.js";
import { ago, callout, detail, empty, escape, more, panel, plural, status, table } from "./ui.js";

/**
 * The Documents page: the documentation portal.
 *
 * A list of what the workspace has been given, and for the selected
 * document the two things it can connect to: a running workflow (as the
 * reference material its stage prompts carry) and an assistant's project
 * (as a dataset in the recipe's shape). Both are forms that post the
 * ordinary document commands; the page decides nothing on its own.
 * Browser code: no Node imports.
 */

function secretNote(doc: DocumentRecord): string {
  return doc.secretFindings
    ? callout("warn", "Contains something that looks like a credential", ` ${plural(doc.secretFindings, "line")} matched a secret pattern. The document is kept so you can see it here, but it cannot be attached to a run or added to a project. Remove the secret from the source and add it again.`)
    : "";
}

export function documentsPage(snapshot: WorkbenchSnapshot, selectedId: string | undefined, ui?: StudioUi): Page {
  const state = snapshot.documents;
  const viewer = viewerOf(snapshot.actor, snapshot.roles);
  if (!state) return { title: "Documents", body: empty("The documentation portal is not configured for this deployment.") };
  const docs = [...state.documents].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const selected = docs.find((doc) => doc.id === selectedId) ?? docs[0];
  const runs = (snapshot.pipelines?.runs ?? []).filter((run) => run.status !== "complete" && run.status !== "cancelled" && (viewer.admin || run.owner === snapshot.actor));
  const projects = (snapshot.studio?.projects ?? []).filter((project) => project.status === "active");

  const addForm = viewer.author ? `<form id="document-add" class="mt8">
    <label class="field"><span>Title</span><input name="title" required maxlength="120" placeholder="Grant Inquiry Routing SOP"></label>
    <label class="field"><span>Text</span><textarea name="text" rows="8" required maxlength="200000" placeholder="Paste the documentation here. It is stored once, by content hash, and never leaves this machine."></textarea></label>
    <div class="actions"><button type="submit" class="primary">Add document</button></div>
    <p class="fine">Lines that look like a credential are counted and never shown. Adding a document trains nothing and changes no run.</p></form>` : `<p class="fine">An author adds documents.</p>`;

  const rows = docs.map((doc) => ({ href: `#/documents/${doc.id}`, cells: [
    `<a href="#/documents/${doc.id}"><strong>${escape(doc.title)}</strong></a><br><small class="text-3">${escape(doc.excerpt.slice(0, 90))}${doc.excerpt.length > 90 ? "…" : ""}</small>`,
    `${Math.max(1, Math.round(doc.bytes / 1024))} KB`,
    doc.secretFindings ? status("warn", "Credential found") : doc.runs.length || doc.datasets.length ? status("ok", `${doc.runs.length ? plural(doc.runs.length, "run") : ""}${doc.runs.length && doc.datasets.length ? " · " : ""}${doc.datasets.length ? plural(doc.datasets.length, "dataset") : ""}`) : status("neutral", "Not connected"),
    `<small class="text-3">${escape(doc.addedBy)} · ${ago(doc.addedAt)}</small>`,
  ] }));
  const list = table([{ label: "Document" }, { label: "Size", nowrap: true }, { label: "Connected to", nowrap: true }, { label: "Added", nowrap: true }], rows,
    { empty: empty("No documents yet. Paste the first one below."), compact: true, label: "Documents" });

  let selectedHtml = "";
  if (selected) {
    const usable = selected.secretFindings === 0;
    const runOptions = runs.filter((run) => !selected.runs.includes(run.id));
    const projectOptions = projects.filter((project) => !(snapshot.studio?.datasets ?? []).some((dataset) => dataset.projectId === project.id && selected.datasets.includes(dataset.id)));
    const attachForm = viewer.author && usable ? (runOptions.length
      ? `<form id="document-attach" data-document="${selected.id}" class="inline-form"><label class="field"><span>Attach to a running workflow</span><select name="runId">${runOptions.map((run) => `<option value="${run.id}">${escape(run.title)}</option>`).join("")}</select></label><button type="submit" class="secondary">Attach as reference material</button></form>`
      : `<p class="fine">No open run of yours to attach to. Start one from Workflows.</p>`) : "";
    const projectForm = viewer.author && usable ? (projectOptions.length
      ? `<form id="document-project" data-document="${selected.id}" class="inline-form"><label class="field"><span>Add to an assistant's project</span><select name="projectId">${projectOptions.map((project) => `<option value="${project.id}">${escape(project.name)}</option>`).join("")}</select></label><button type="submit" class="secondary">Add as a dataset</button></form><p class="fine">The document becomes one record per paragraph, in its own wording, validated on the way in. Training is a separate step on the project.</p>`
      : `<p class="fine">Every active project already has this document.</p>`) : "";
    const connections = [
      ...selected.runs.map((runId) => { const run = snapshot.pipelines?.runs.find((item) => item.id === runId); return run ? `<li>Reference material on <a href="#/workflows">${escape(run.title)}</a></li>` : `<li>Reference material on a run that is no longer listed</li>`; }),
      ...selected.datasets.map((datasetId) => { const dataset = snapshot.studio?.datasets.find((item) => item.id === datasetId); const project = snapshot.studio?.projects.find((item) => item.id === dataset?.projectId); return dataset && project ? `<li>Dataset <a href="#/studio/${project.id}/data">${escape(dataset.name)}</a> on ${escape(project.name)}</li>` : `<li>A dataset that is no longer listed</li>`; }),
    ];
    const remove = viewer.admin || selected.addedBy === snapshot.actor
      ? (ui?.confirm === `remove_document:${selected.id}`
        ? `<span class="callout warn m0"><strong>Remove "${escape(selected.title)}" from the portal?</strong> Runs and datasets keep the copies they already have. <button type="button" class="danger small" data-document-remove="${selected.id}">Remove</button> <button type="button" class="quiet small" data-cancel-confirm>Cancel</button></span>`
        : `<button type="button" class="danger small" data-confirm="remove_document:${selected.id}">Remove from portal</button>`)
      : "";
    selectedHtml = panel(selected.title, `<div class="panel-body">${secretNote(selected)}
      ${detail([["Added", `${escape(selected.addedBy)} · ${ago(selected.addedAt)}`], ["Size", `${selected.bytes.toLocaleString()} bytes`], ["Content hash", `<code>${selected.contentHash.slice(0, 12)}</code>`], ["Excerpt", escape(selected.excerpt)]])}
      ${connections.length ? `<h3 class="mt14">Connected to</h3><ul class="plain">${connections.join("")}</ul>` : `<p class="fine mt14">Not connected to anything yet.</p>`}
      ${attachForm}${projectForm}
      <div class="actions mt14">${remove}</div></div>`, { id: "document-detail" });
  }

  const body = `${ui?.error ? callout("bad", "That did not work", ` ${escape(ui.error)}`) : ""}
    <div class="split-2">${panel("Documents", list, { count: docs.length ? String(docs.length) : "" })}${selectedHtml}</div>
    ${more("Add a document", addForm, docs.length === 0)}`;
  return { title: "Documents", context: "Documentation given to this workspace, and what it is connected to", body };
}
