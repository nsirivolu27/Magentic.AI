import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const artifact = process.env.MAGENTIC_UI_ARTIFACTS ?? fileURLToPath(new URL("../test-results/studio-screenshots/", import.meta.url));
mkdirSync(artifact, { recursive: true });

async function accessibility(page) {
  await page.evaluate(axe);
  return page.evaluate(() => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
  }));
}

async function setIdentity(page, identity) {
  const account = page.locator(".console-account");
  if (!(await account.locator(".account-popover").isVisible())) await account.locator("summary").click();
  await page.locator("#identity").selectOption(identity);
}

test("saved template through independently approved workflow handoff", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.goto("/#/agent-studio");
  await expect(page.getByRole("heading", { name: "Agent Studio", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("link", { name: /Internal documentation assistant/ }).click();
  await expect(page.locator("#agent-studio-editor")).toBeVisible();
  await expect(page.locator('#agent-studio-editor select[name="model"]')).toHaveValue("demo-scripted");
  await expect(page.locator('#agent-studio-editor input[name="tools"][value="read_project_file"]')).toBeChecked();
  await expect(page.locator('#agent-studio-editor input[name="requireSourceRead"]')).toBeChecked();
  await page.locator('#agent-studio-editor input[name="name"]').fill("SOP access guide");
  await page.screenshot({ path: `${artifact}/studio-desktop-setup.png`, fullPage: true });

  // Simulate a real network failure, not a successful fake API response. The
  // entered draft must remain editable so the retry can reach the real demo API.
  await page.route("**/api/pipeline", route =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect(page.locator("#notice")).not.toBeEmpty();
  await expect(page.locator('#agent-studio-editor input[name="name"]')).toHaveValue("SOP access guide");
  await page.unroute("**/api/pipeline");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();

  await expect(page).toHaveURL(/#\/agent-studio\/[^/]+\/test$/);
  const agentId = new URL(page.url()).hash.match(/^#\/agent-studio\/([^/]+)/)?.[1];
  expect(agentId).toBeTruthy();
  await expect(page.locator(".agent-test-cases li:first-child strong")).toHaveText("Routine access request");
  await expect(page.locator(".agent-test-cases li:first-child form button")).toHaveClass(/primary/);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const result = page.getByRole("article", { name: "Test result" });
  await expect(result).toContainText("Execution finished", { timeout: 30_000 });
  await expect(result).toContainText("Read SOP.md");
  await expect(result).toContainText("two business days");
  await expect(result.getByRole("heading", { name: "Quality review", exact: true })).toBeVisible();
  await expect(page.locator("#agent-test-review")).toBeVisible();
  await expect(page.locator("#agent-test-review")).toContainText("separate from the execution finishing");
  await page.screenshot({ path: `${artifact}/studio-desktop-test-answer.png`, fullPage: true });

  await page.locator('#agent-test-review input[value="pass"]').check();
  await page.locator('#agent-test-review textarea[name="note"]').fill("The answer cites the source and reflects the stated approval and response process.");
  await page.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(page.locator("#agent-test-review")).toHaveCount(0);
  await expect(result).toContainText("pass by demo.operator");

  await page.getByRole("link", { name: "Assignment", exact: true }).click();
  await expect(page.locator("#agent-studio-assign")).toBeVisible();
  await page.locator("#agent-studio-assign select[name=stage]").selectOption("answer");
  await page.getByRole("button", { name: "Assign saved agent", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Assigned for future runs");
  await expect(page.locator('.agent-studio-review[aria-label="Run readiness"]')).toBeVisible();
  await page.screenshot({ path: `${artifact}/studio-desktop-assignment.png`, fullPage: true });

  await page.locator("#agent-studio-start input[name=title]").fill("Studio browser journey");
  await page.locator("#agent-studio-start textarea[name=brief]").fill("Read SOP.md. Explain the access approval, response target and missing-approval handling. Cite the source.");
  await page.getByRole("button", { name: "Start workflow", exact: true }).click();
  await expect(page.locator(".work-title h2")).toHaveText("Studio browser journey");
  await expect(page.getByRole("button", { name: "Run this agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run this agent", exact: true }).click();
  const workProgress = page.locator("#work-progress");
  await expect(workProgress).toContainText("Read SOP.md", { timeout: 30_000 });
  await expect(workProgress).toContainText("two business days");
  await expect(workProgress).toContainText("Original agent output");
  await page.getByRole("button", { name: "Accept and continue", exact: true }).click();
  await expect(page.locator(".work-phases")).toContainText("Check the answer");
  await expect(page.getByRole("button", { name: "Run this agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run this agent", exact: true }).click();
  await expect(workProgress).toContainText("Read SOP.md", { timeout: 30_000 });
  await expect(workProgress).toContainText("two business days");
  await page.getByRole("button", { name: "Submit for independent review", exact: true }).click();
  await expect(workProgress).toContainText("0 of 2 approvals");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toHaveCount(0);

  const pending = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.operator" } });
  expect(pending.ok()).toBe(true);
  const pendingSnapshot = await pending.json();
  const run = pendingSnapshot.pipelines.runs.find(item => item.title === "Studio browser journey");
  expect(run).toBeTruthy();
  const selfApproval = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer demo.operator" },
    data: { action: "approve", runId: run.id, expectedRevision: run.revision },
  });
  expect(selfApproval.status()).toBe(403);

  await setIdentity(page, "demo.reviewer-one");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toBeVisible();
  await workProgress.getByRole("button", { name: "Approve this handoff", exact: true }).click();
  await expect(workProgress).toContainText("1 of 2 approvals");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toHaveCount(0);
  const firstReview = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.reviewer-one" } });
  const firstSnapshot = await firstReview.json();
  const oneApprovalRun = firstSnapshot.pipelines.runs.find(item => item.id === run.id);
  expect(oneApprovalRun.stages[1].approvals).toEqual(["demo.reviewer-one"]);
  const repeatApproval = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer demo.reviewer-one" },
    data: { action: "approve", runId: run.id, expectedRevision: oneApprovalRun.revision },
  });
  expect(repeatApproval.status()).toBe(409);

  await setIdentity(page, "demo.reviewer-two");
  await workProgress.getByRole("button", { name: "Approve this handoff", exact: true }).click();
  await expect(workProgress).toContainText("Approved");
  const complete = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.reviewer-two" } });
  expect(complete.ok()).toBe(true);
  const completeSnapshot = await complete.json();
  const completedRun = completeSnapshot.pipelines.runs.find(item => item.id === run.id);
  expect(completedRun.status).toBe("complete");
  expect(completedRun.stages[1].approvals).toEqual(["demo.reviewer-one", "demo.reviewer-two"]);
  expect(pageErrors).toEqual([]);
});

test("services, preferences, keyboard access, and responsive pages", async ({ page }) => {
  await page.goto("/#/agent-studio");
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  const services = page.getByRole("dialog", { name: "Services", exact: true });
  await expect(services).toBeVisible();
  await expect(page.locator("#service-search")).toBeFocused();
  await page.getByRole("searchbox", { name: "Find a service" }).fill("agents");
  await expect(page.locator('a.nav[data-route="agent-studio"]')).toBeVisible();
  await expect(page.locator('a.nav[data-route="workflows"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#nav-toggle")).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".sidebar")).toHaveCount(0);

  await page.locator(".console-account > summary").click();
  await page.locator("#theme-select").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("#theme-select")).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await expect(page.locator("#title")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `document overflows at ${width}px`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifact}/studio-mobile-390.png`, fullPage: true });
  const audit = await accessibility(page);
  expect(audit.violations).toEqual([]);
});
