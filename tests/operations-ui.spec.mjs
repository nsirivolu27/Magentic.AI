import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function accessibility(page) {
  // The workbench has no frames. Audit its document directly without opening
  // another browser context (important on memory-constrained developer hosts).
  await page.evaluate(axe);
  return page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
}

test("queue search, status filters, and refresh use actual snapshot data", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/workspace");
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Helpdesk assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New work item", exact: true })).toHaveCSS("background-color", "rgb(100, 87, 224)");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".console-diamond")).toHaveCSS("color", "rgb(224, 122, 196)");
  await expect(page.locator("#environment-banner")).toContainText("Synthetic sample data");
  await page.getByRole("searchbox", { name: "Search work queue" }).fill("not an actual item");
  await expect(page.getByRole("heading", { name: "No work matches these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search work queue" }).fill("helpdesk");
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search work queue" })).toHaveValue("helpdesk");
  await expect(page.locator(".queue-table tbody tr")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search work queue" }).fill("");
  await page.locator('.queue-filters button').filter({ hasText: "Needs your review" }).click();
  await expect(page.locator('.queue-filters button[aria-pressed="true"]')).toContainText("Needs your review");
  await expect(page.locator(".queue-table tbody tr")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("new work, queue deep links, and legacy task URLs open the correct run", async ({ page }) => {
  await page.goto("/#/workspace");
  await page.getByRole("button", { name: "+ New work item", exact: true }).click();
  await page.locator('#desk-start input[name=title]').fill("Synthetic federal inquiry");
  await page.locator('#desk-start textarea[name=brief]').fill("Review synthetic intake guidance; do not connect a live service.");
  await page.getByRole("button", { name: "Start work item", exact: true }).click();
  await expect(page.locator(".work-title h2")).toHaveText("Synthetic federal inquiry");
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  await page.locator('a.nav[data-route=workspace]').click();
  const item = page.getByRole("link", { name: "Synthetic federal inquiry", exact: true });
  const href = await item.getAttribute("href");
  await item.click();
  await expect(page.locator(".work-title h2")).toHaveText("Synthetic federal inquiry");
  await page.reload();
  await expect(page.locator(".work-title h2")).toHaveText("Synthetic federal inquiry");
  await page.goto(`/${href.replace("#/desk/", "#/tasks/")}`);
  await expect(page.locator(".work-title h2")).toHaveText("Synthetic federal inquiry");
  await page.goto("/#/desk/not-a-workspace-record");
  await expect(page.getByRole("heading", { name: "Work item not found" })).toBeVisible();
  await expect(page.locator(".work-title")).toHaveCount(0);
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  await page.locator('a.nav[data-route=workspace]').click();
  await page.getByRole("button", { name: "+ New work item", exact: true }).click();
  await expect(page.locator("#desk-start")).toBeVisible();
});

test("operator shell keeps feature navigation and passes automated accessibility checks", async ({ page }) => {
  await page.goto("/#/workspace");
  await expect(page.locator(".operations-queue")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(/#\/workspace$/);
  const audit = await accessibility(page);
  expect(audit.violations).toEqual([]);
  for (const route of ["assistants", "workflows", "documents", "studio", "evaluations", "approvals", "activity", "workflow"]) {
    await page.getByRole("button", { name: "Open services", exact: true }).click();
    await page.locator(`a.nav[data-route=${route}]`).click();
    await expect(page).toHaveURL(new RegExp(`#/${route}$`));
    await expect(page.locator("#title")).not.toBeEmpty();
    await expect(page.locator("#title")).toBeFocused();
  }
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  await page.locator('a.nav[data-route=mcp]').click();
  await expect(page.locator("#title")).toHaveText("MCP inspector");
  await expect(page.locator("#other-panel")).toBeVisible();
});

test("mobile navigation contains keyboard focus and the queue does not overflow the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/workspace");
  await expect(page.locator(".operations-queue")).toBeVisible();
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Services", exact: true })).toBeVisible();
  await expect(page.locator("#service-search")).toBeFocused();
  await page.getByRole("searchbox", { name: "Find a service" }).fill("knowledge");
  await expect(page.locator('a.nav[data-route=documents]')).toBeVisible();
  await expect(page.locator('a.nav[data-route=workflows]')).toBeHidden();
  await page.getByRole("searchbox", { name: "Find a service" }).fill("no-such-service");
  await expect(page.locator("#service-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#nav-toggle")).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find a service" }).fill("");
  await page.locator('a.nav[data-route=workflows]').click();
  await expect(page.locator("#nav-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.goto("/#/workspace");
  await expect(page.locator(".operations-queue")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const audit = await accessibility(page);
  expect(audit.violations).toEqual([]);
});

test("local workspace preserves its identity and discloses remote model data handling", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/#/workspace");
  await expect(page.locator(".operations-queue")).toBeVisible();
  await expect(page.locator(".workspace-icon")).toBeVisible();
  await expect(page.locator(".workspace small")).toContainText("LOCAL");
  await expect(page.locator("#environment-banner")).toContainText("Remote models receive sent content");
  await expect(page.locator(".identity")).toBeHidden();
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.locator(".workspace-icon")).toBeVisible();
  await expect(page.locator(".workspace small")).toBeVisible();
});

test("workflow settings preserve unchecked drafts, save one stage, and freeze existing runs", async ({ page }) => {
  await page.goto("/#/workflows");
  await expect(page.locator("#workflow-stage")).toHaveCount(0);
  const initial = await page.request.get("/api/workspace", { headers: { authorization: "Bearer alex.writer" } });
  expect(initial.ok()).toBe(true);
  const before = await initial.json();
  const config = before.pipelines.config;
  const stage = config.stages.find(item => item.approval);
  expect(stage).toBeTruthy();
  const other = config.stages.find(item => item.id !== stage.id);
  const denied = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer alex.writer" },
    data: { action: "configure", expectedVersion: before.pipelines.version, config },
  });
  expect(denied.ok()).toBe(false);
  expect((await denied.json()).error).toMatch(/admin/i);
  const requestId = randomUUID();
  const started = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer alex.writer" },
    data: { action: "start", requestId, title: "Synthetic settings freeze check", brief: "Preserve this work item's saved review policy." },
  });
  expect(started.ok()).toBe(true);
  const startedRun = (await started.json()).runs.find(run => run.requestId === requestId);
  expect(startedRun).toBeTruthy();
  await page.locator(".console-account > summary").click();
  await page.getByRole("combobox", { name: "Acting as" }).selectOption("taylor.admin");
  await expect(page.locator("#operator-context")).toContainText("Administrator");
  await page.goto(`/#/workflows/${stage.id}`);
  const form = page.locator("#workflow-stage");
  await expect(form).toBeVisible();
  await form.getByRole("textbox", { name: "Stage instructions", exact: true }).fill("Check the synthetic intake against the saved evidence.");
  await form.getByRole("textbox", { name: "Requested context", exact: true }).fill("Frozen reference excerpts");
  await form.getByRole("checkbox").uncheck();
  const definition = page.getByRole("list", { name: "Workflow stages", exact: true });
  await definition.locator(`a[href="#/workflows/${other.id}"]`).click();
  await definition.locator(`a[href="#/workflows/${stage.id}"]`).click();
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(form.getByRole("checkbox")).not.toBeChecked();
  await expect(form.getByRole("textbox", { name: "Stage instructions", exact: true })).toHaveValue("Check the synthetic intake against the saved evidence.");
  await expect(form.getByRole("textbox", { name: "Requested context", exact: true })).toHaveValue("Frozen reference excerpts");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#notice")).toHaveText("Workflow updated.");
  const saved = await page.request.get("/api/workspace", { headers: { authorization: "Bearer taylor.admin" } });
  expect(saved.ok()).toBe(true);
  const after = await saved.json();
  expect(after.pipelines.config.stages.find(item => item.id === stage.id)).toEqual({
    ...stage, instructions: "Check the synthetic intake against the saved evidence.", context: "Frozen reference excerpts", approval: false,
  });
  expect(after.pipelines.config.stages.filter(item => item.id !== stage.id)).toEqual(config.stages.filter(item => item.id !== stage.id));
  expect(after.pipelines.runs.find(run => run.id === startedRun.id).config).toEqual(startedRun.config);
  await page.reload();
  await page.locator(".console-account > summary").click();
  await page.getByRole("combobox", { name: "Acting as" }).selectOption("taylor.admin");
  await expect(form.getByRole("checkbox")).not.toBeChecked();
  await expect(form.getByRole("textbox", { name: "Requested context", exact: true })).toHaveValue("Frozen reference excerpts");
});
