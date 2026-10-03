import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import { memoryModelStudio } from "../workbench/studio/engine.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";
import { emptyStudioUi } from "../workbench/studio-view.js";
import { marketplacePage, marketplaceRecipes } from "../workbench/marketplace-view.js";

function fixture() {
  const engine = memoryModelStudio();
  const snapshot: WorkbenchSnapshot = { workspaceId: "team", actor: "alex", roles: ["author"], canAuthor: true,
    workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: true, studio: engine.snapshot("team"),
    mcp: { agents: [], withheld: [] }, chat: { configured: false } };
  return { snapshot, engine };
}

test("marketplace uses the deployment's recipes and filters by use case", () => {
  const { snapshot } = fixture();
  assert.equal(marketplaceRecipes(snapshot).length, snapshot.studio!.recipes.length);
  assert.deepEqual(marketplaceRecipes(snapshot, "documentation").map((item) => item.id), ["internal-knowledge"]);
  assert.deepEqual(marketplaceRecipes(snapshot, "", "Engineering").map((item) => item.id), ["coding-assistant", "jira-issue-assistant"]);
  assert.equal(marketplaceRecipes(snapshot, "nonexistent").length, 0);
  const body = marketplacePage(snapshot, undefined, new URLSearchParams({ q: '<script>alert(1)</script>' }), emptyStudioUi()).body;
  assert.match(body, /No matching configurables/);
  assert.doesNotMatch(body, /<script>/);
  snapshot.studio!.recipes = [];
  assert.equal(marketplaceRecipes(snapshot).length, 0, "the client must not invent listings");
});

test("using a configurable creates a setup with no training, releases, or assistant access", () => {
  const { snapshot, engine } = fixture();
  const recipe = marketplaceRecipes(snapshot, "documentation")[0]!;
  snapshot.studio = engine.execute("team", "alex", ["author"], { action: "create_project", name: "Employee handbook", recipeId: recipe.id, purpose: recipe.purpose }, 2);
  assert.equal(snapshot.studio.projects[0]?.recipeId, recipe.id);
  assert.equal(snapshot.studio.jobs.length, 0);
  assert.equal(snapshot.studio.releases.length, 0);
  assert.equal(snapshot.studio.profiles.length, 0);
  const body = marketplacePage(snapshot, recipe.id, new URLSearchParams(), emptyStudioUi()).body;
  assert.match(body, /Employee handbook/);
  assert.match(body, /Continue setup/);
  assert.doesNotMatch(body, /href="#\/assistants\//);
  assert.throws(() => engine.execute("team", "sam", ["approver"], { action: "create_project", name: "No permission", recipeId: recipe.id }, 2), /author|admin/i);
  snapshot.canAuthor = false;
  assert.doesNotMatch(marketplacePage(snapshot, recipe.id, new URLSearchParams(), emptyStudioUi()).body, /id="marketplace-add"/);
  assert.equal(engine.snapshot("other-workspace").projects.length, 0);
});

test("marketplace handles unavailable catalogs and unknown templates without offering setup", () => {
  const { snapshot } = fixture();
  assert.match(marketplacePage(snapshot, "unknown", new URLSearchParams(), emptyStudioUi()).body, /not available/);
  delete snapshot.studio;
  assert.doesNotMatch(marketplacePage(snapshot, undefined, new URLSearchParams(), emptyStudioUi()).body, /marketplace-add/);
});
