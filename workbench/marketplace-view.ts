import type { WorkbenchSnapshot } from "./snapshot.js";
import type { Page, StudioUi } from "./studio-view.js";
import type { Recipe } from "./studio/recipes.js";
import { empty, escape, more, panel, status } from "./ui.js";
import { phaseReport } from "./studio-model.js";

const CATEGORIES: Record<string, string> = {
  "internal-knowledge": "Knowledge", "it-support": "Support", "incident-summarization": "Support",
  "coding-assistant": "Engineering", "jira-issue-assistant": "Engineering", "salesforce-delivery": "Delivery",
};

// The server's recipes are the catalog. A marketplace listing must not
// promise a capability or a model setup that this deployment cannot create.
export function marketplaceRecipes(snapshot: WorkbenchSnapshot, search = "", category = ""): Recipe[] {
  const query = search.trim().toLowerCase();
  return (snapshot.studio?.recipes ?? []).filter((recipe) => (!category || CATEGORIES[recipe.id] === category)
    && `${recipe.title} ${recipe.purpose}`.toLowerCase().includes(query));
}

export function marketplacePage(snapshot: WorkbenchSnapshot, id: string | undefined, query: URLSearchParams, ui: StudioUi): Page {
  const studio = snapshot.studio;
  const crumbs: [string, string][] = [["Marketplace", "#/marketplace"]];
  if (!studio) return { title: "Configurable marketplace", body: empty(snapshot.studioError ? "The configurable catalog could not be loaded. Refresh to try again." : "Model Studio must be enabled before configurables are available.") };
  if (!id) {
    const search = query.get("q") ?? "";
    const category = query.get("category") ?? "";
    const recipes = marketplaceRecipes(snapshot, search, category);
    const filters = `<form id="marketplace-search" class="marketplace-search" role="search"><label><span class="visually-hidden">Find a configurable</span><input type="search" name="q" placeholder="Find a configurable" value="${escape(search)}"></label><label><span class="visually-hidden">Use case</span><select name="category"><option value="">All use cases</option>${[...new Set(Object.values(CATEGORIES))].map((item) => `<option value="${item}" ${category === item ? "selected" : ""}>${item}</option>`).join("")}</select></label><button type="submit">Search</button>${search || category ? '<a class="btn" href="#/marketplace">Clear</a>' : ""}</form>`;
    const cards = recipes.length ? `<div class="employee-shortcuts">${recipes.map((recipe) => {
      const projects = studio.projects.filter((project) => project.recipeId === recipe.id && project.status === "active");
      return `<article class="employee-card"><div class="employee-card-heading"><span class="marketplace-category">${escape(CATEGORIES[recipe.id] ?? "General")}</span>${projects.length ? status("neutral", `${projects.length} in workspace`) : '<small class="text-3">Included</small>'}</div><h2>${escape(recipe.title)}</h2><p>${escape(recipe.purpose)}</p><a class="employee-card-link" href="#/marketplace/${recipe.id}">View configurable →</a></article>`;
    }).join("")}</div>` : empty("No matching configurables.", { label: "Clear filters", href: "#/marketplace" });
    return { title: "Configurable marketplace", context: "Ready-made assistant behavior for your team's work.", body: `${filters}${cards}<p class="text-3">Included with Magentic · Workspace approval rules still apply.</p>` };
  }
  const recipe = studio.recipes.find((item) => item.id === id);
  if (!recipe) return { title: "Configurable not found", crumbs, body: empty("This configurable is not available here.", { label: "Browse configurables", href: "#/marketplace" }) };
  const projects = studio.projects.filter((project) => project.recipeId === recipe.id && project.status === "active");
  const existing = projects.map((project) => {
    const report = phaseReport(studio, project);
    const profiles = studio.profiles.filter((profile) => profile.status === "active" && studio.releases.some((release) => release.id === profile.releaseId && release.projectId === project.id && release.status === "approved"));
    return `<li><div><strong>${escape(project.name)}</strong><small>${escape(project.owner)} · ${profiles.length ? "Available to use" : "Setup in progress"}</small></div><div class="employee-actions">${profiles.map((profile) => `<a class="btn small" href="#/assistants/${profile.id}">Open ${escape(profile.name)}</a>`).join("")}<a class="btn small" href="#/studio/${project.id}/${report.current}">${profiles.length ? "Manage" : "Continue setup"}</a></div></li>`;
  }).join("");
  const key = `marketplace:${recipe.id}`;
  const draft = ui.drafts[key] ?? {};
  const setup = snapshot.canAuthor ? `<form id="marketplace-add" data-draft="${key}" data-recipe="${recipe.id}" class="panel-body employee-form"><label>Name in your workspace<input name="name" required maxlength="120" value="${escape(draft.name ?? recipe.title)}"></label><label>What should it help your team do?<textarea name="purpose" rows="3" maxlength="1000">${escape(draft.purpose ?? recipe.purpose)}</textarea></label><p class="text-2">Add examples → Test → Review → Use</p><div class="employee-actions"><button class="primary" type="submit">Add to workspace</button></div><small class="text-3">Creates a setup. Your current assistants stay unchanged.</small></form>` : '<p class="panel-body">A workspace author can add this configurable. You can use an approved assistant below.</p>';
  const details = `<div class="panel-body"><h3>Assistant behavior</h3><p class="employee-output">${escape(recipe.profileInstructions)}</p><h3>Starting model</h3><p>${escape(recipe.baseModel)}</p><h3>What you provide</h3><p>Relevant examples and reference material. No company data source is connected automatically.</p><h3>Checks before use</h3><p>Example format, distinct examples, credential scan, and coverage. These data checks do not measure answer quality.</p><p>${snapshot.workflow.requiredApprovals} distinct approvals are required by the workspace policy.</p><h3>Access</h3><p>Chat uses the existing read-only workspace tools. Instructions cannot grant permissions. Training and API connections are configured separately.</p></div>`;
  return { title: recipe.title, crumbs, context: recipe.purpose, actions: status("neutral", "Included template"), body: `<div class="employee-focus">${projects.length ? panel("In your workspace", `<ul class="marketplace-installed">${existing}</ul>`) : ""}${projects.length ? more("Add another setup", setup) : panel("Make it yours", setup)}${more("Behavior and requirements", details)}${projects.length ? '<p class="marketplace-workflow-link"><a href="#/workflows">Assign an approved assistant to a workflow →</a></p>' : ""}</div>` };
}
