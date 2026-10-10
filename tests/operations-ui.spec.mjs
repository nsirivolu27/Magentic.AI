import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
    await page.locator(`a.nav[data-route=${route}]`).click();
    await expect(page).toHaveURL(new RegExp(`#/${route}$`));
    await expect(page.locator("#title")).not.toBeEmpty();
    await expect(page.locator("#title")).toBeFocused();
  }
  await page.locator(".advanced-nav summary").click();
  await page.locator('a.nav[data-route=mcp]').click();
  await expect(page.locator("#title")).toHaveText("MCP inspector");
  await expect(page.locator("#other-panel")).toBeVisible();
});

test("mobile navigation contains keyboard focus and the queue does not overflow the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/workspace");
  await expect(page.locator(".operations-queue")).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
  await expect(page.locator("#nav-close")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".brand")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("combobox", { name: "Acting as" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".brand")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#nav-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#nav-toggle")).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
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
  await expect(page.locator("#environment-banner")).toContainText("Model inputs may leave");
  await expect(page.locator(".identity")).toBeHidden();
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.locator(".workspace-icon")).toBeVisible();
  await expect(page.locator(".workspace small")).toBeVisible();
});
