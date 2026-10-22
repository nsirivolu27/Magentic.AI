import { workforceCatalogue, workforceTemplates } from "./workforce-marketplace.js";
import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page } from "./studio-view.js";
import { escape, empty, more } from "./ui.js";

type Template = typeof workforceTemplates[number];

function groupName(item: Template): string {
  return workforceCatalogue.groups.find(group => group.id === item.group)?.name ?? item.group;
}

function preview(item: Template): string {
  // These are template steps, not a claim that a run or a connector has succeeded.
  return `<div class="market-preview" data-tone="${escape(item.definition.bot.kind)}">
    <div class="market-preview-label"><span>WORKFLOW DESIGN</span><span>◇</span></div>
    <div class="market-source"><span class="market-port">↳</span><span>${escape(item.inputs[0] ?? "Source material")}</span></div>
    <div class="market-wire" aria-hidden="true"></div>
    <div class="market-agent"><span class="market-glyph" aria-hidden="true">◇</span><div><small>${escape(item.definition.bot.kind)}</small><strong>${escape(item.definition.name)}</strong></div></div>
    <div class="market-wire" aria-hidden="true"></div>
    <div class="market-review"><span aria-hidden="true">◎</span><span>Human review</span><span aria-hidden="true">→</span></div>
  </div>`;
}

export function workforceMarketplacePage(snapshot: WorkbenchSnapshot, workspaceName: string, slug?: string,
  group?: string, query = "", library = false): Page {
  const page = { title: "Agent marketplace", context: `Designs for your workflows · ${workspaceName}` };
  const pipeline = snapshot.pipelines;
  if (!pipeline) return { ...page, body: empty("Workflow storage is unavailable.") };
  const installed = new Set(pipeline.config.configurables?.map(agent => agent.id));
  const admin = snapshot.roles.includes("admin");
  const remaining = workforceTemplates.filter(item => !installed.has(item.definition.id));
  const freeSlots = 30 - (pipeline.config.configurables?.length ?? 0);
  const install = (label: string, template: string, count: number) => `<form class="workforce-install" data-template="${escape(template)}" data-version="${pipeline.version}"><button class="primary" ${admin && count <= freeSlots && count > 0 ? "" : "disabled"}>${escape(label)}</button></form>`;
  const selected = workforceTemplates.find(item => item.slug === slug);
  if (slug && !selected) return { ...page, body: empty("Agent template not found.", { label: "Marketplace", attrs: 'href="#/marketplace"' }) };
  if (selected) {
    const agent = selected.definition;
    const saved = installed.has(agent.id);
    const paths = workforceCatalogue.pipelines.filter(path => path.steps.includes(selected.slug));
    return { ...page, title: agent.name, crumbs: [["Marketplace", "#/marketplace"]], body: `<div class="marketplace market-detail">
      <div><div class="market-detail-preview">${preview(selected)}</div>
        <section class="market-section"><h2>What it delivers</h2><p>${escape(selected.output)}</p></section>
        <section class="market-section"><h2>Where it fits</h2>${paths.length ? paths.map(path => `<article class="market-path"><h3>${escape(path.name)}</h3><ol>${path.steps.map(step => {
          const template = workforceTemplates.find(item => item.slug === step)!;
          return `<li><a href="#/marketplace/${step}" ${step === selected.slug ? 'aria-current="page"' : ""}>${escape(template.definition.name)}</a></li>`;
        }).join("")}</ol><p class="text-3">${escape(path.review)}</p></article>`).join("") : '<p>Add this agent to a stage in your workflow.</p>'}<p class="text-3">Suggested sequence. Adding an agent does not change your workflow.</p></section>
      </div>
      <aside class="market-inspector" aria-label="Template details"><span class="market-badge">Draft template · Checks not run</span><h2>${escape(agent.name)}</h2><p>${escape(agent.purpose)}</p>
        ${saved ? `<a class="primary" href="#/agent-studio/${agent.id}">Configure workspace copy</a>` : install("Add to workspace", selected.slug, 1)}
        <p class="text-3">${!admin && !saved ? "An admin installs agents. " : ""}Choose a model, review access, then assign a stage.</p>
        <h3>Inputs</h3><ul>${selected.inputs.map(input => `<li>${escape(input)}</li>`).join("")}</ul>
        <h3>Review owner</h3><p>${escape(selected.humanReviewer)}</p>
        ${more("Instructions and access", `<p class="workforce-instructions">${escape(agent.instructions)}</p><p>${agent.bot.allowedTools!.map(escape).join(" · ")}</p><p>A successful source read is required. External connectors are not connected.</p>`)}
        ${more(`Planned checks (${selected.testCases.length})`, selected.testCases.map(item => `<article><h3>${escape(item.id)}</h3><p>${escape(item.prompt)}</p><ul>${item.expected.map(expectation => `<li>${escape(expectation)}</li>`).join("")}</ul></article>`).join(""))}
      </aside></div>` };
  }
  const search = query.trim().toLowerCase();
  const visible = workforceTemplates.filter(item => (!group || item.group === group)
    && (!library || installed.has(item.definition.id))
    && (!search || [item.definition.name, item.definition.purpose, groupName(item), ...item.inputs, item.output].join(" ").toLowerCase().includes(search)));
  const cards = visible.map(item => {
    const saved = installed.has(item.definition.id);
    return `<article class="market-card">
      <a class="market-shot" href="#/marketplace/${item.slug}" aria-label="Preview ${escape(item.definition.name)}">${preview(item)}</a>
      <div class="market-card-title"><h2><a href="#/marketplace/${item.slug}">${escape(item.definition.name)}</a></h2><span class="market-badge">${saved ? "In workspace" : "Template"}</span></div>
      <p>${escape(item.definition.purpose)}</p><div class="market-card-meta"><span>${escape(groupName(item))}</span><a href="${saved ? `#/agent-studio/${item.definition.id}` : `#/marketplace/${item.slug}`}">${saved ? "Configure" : "Explore"} <span aria-hidden="true">↗</span></a></div>
    </article>`;
  }).join("");
  const filterUrl = (inWorkspace: boolean) => `#/marketplace?${new URLSearchParams({ ...(group ? { group } : {}), ...(query ? { q: query } : {}), ...(inWorkspace ? { library: "1" } : {}) })}`;
  return { ...page, actions: admin ? '<a class="secondary" href="#/canvas">Workflow canvas</a> <a class="secondary" href="#/agent-studio">Open studio</a> <a class="primary" href="#/agent-studio/new">Create agent</a>' : '<a class="secondary" href="#/agent-studio">Workspace agents</a>', body: `<div class="marketplace">
    <div class="market-toolbar"><nav class="market-tabs" aria-label="Marketplace collection"><a href="${escape(filterUrl(false))}" ${!library ? 'aria-current="page"' : ""}>Explore</a><a href="${escape(filterUrl(true))}" ${library ? 'aria-current="page"' : ""}>In workspace <span>${workforceTemplates.length - remaining.length}</span></a></nav>
      <form id="workforce-filter"><label class="market-search"><span class="visually-hidden">Search agents</span><input type="search" name="q" value="${escape(query)}" placeholder="Search a task or outcome…" maxlength="200"></label>
        <label><span class="visually-hidden">Function</span><select name="group"><option value="">All functions</option>${workforceCatalogue.groups.map(item => `<option value="${escape(item.id)}" ${group === item.id ? "selected" : ""}>${escape(item.name)}</option>`).join("")}</select></label>
        ${library ? '<input type="hidden" name="library" value="1">' : ""}<button class="secondary">Search</button></form></div>
    <div class="market-results"><span>${visible.length} ${visible.length === 1 ? "design" : "designs"}</span><span>Templates · Human review required</span></div>
    <div class="market-grid">${cards || `<div class="market-empty"><h2>${library && !search && !group ? "Your collection starts here" : "No matching designs"}</h2><p>${library ? "Add a template from Explore, then configure it in your studio." : "Try another task or clear the filters."}</p><a class="secondary" href="#/marketplace">Explore all designs</a></div>`}</div>
    <footer class="market-footer"><p>Accenture-inspired examples. Independently proposed; not endorsed or evaluated.</p>${more("Workspace setup", `<p>${freeSlots} spaces available. Copies stay in ${escape(workspaceName)}. External connectors are not connected.</p>${!admin ? '<p>An admin installs agents.</p>' : ""}${remaining.length > freeSlots ? '<p>Add individual agents; the full pack exceeds this workspace’s 30-agent limit.</p>' : ""}${install(remaining.length ? `Add remaining ${remaining.length}` : "Pack added", "all", remaining.length)}`)}</footer>
  </div>` };
}
