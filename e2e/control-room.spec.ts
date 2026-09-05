import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
}

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function navigate(page: Page, name: string) {
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name: name === "Overview" ? "Control Room" : name, level: 1 })).toBeVisible();
}

async function confirmRun(page: Page) {
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Run Through Gateway" }).click();
}

test("desktop Control Room completes the primary flow and exercises every view", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await expect(page.getByText("PENDING_EXTERNAL_REPLAY", { exact: true })).toBeVisible();
  await expect(page.getByText("PENDING EXTERNAL REPLAY", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await navigate(page, "Agent");
  await page.getByRole("button", { name: /Allowed ₹199 order/u }).click();
  await confirmRun(page);
  await expect(page.getByRole("heading", { name: "Action May Proceed" })).toBeVisible();
  await expect(page.getByText("Gateway Calls")).toBeVisible();
  await expect(page.getByText("Upstream Calls")).toBeVisible();

  await page.getByRole("button", { name: "Capture before delivery" }).click();
  await confirmRun(page);
  await expect(page.getByRole("heading", { name: "Action Blocked" })).toBeVisible();
  await expect(page.getByText("Do not capture a payment until delivery is confirmed.")).toBeVisible();
  await page.locator(".verdict-panel .rule-link").click();
  await expect(page.getByRole("heading", { name: "Mandate", level: 1 })).toBeVisible();
  await expect(page.locator("tr.highlighted-rule")).toBeVisible();

  await navigate(page, "Audit");
  const firstAudit = page.locator(".audit-expand").first();
  await expect(firstAudit).toBeVisible();
  await firstAudit.click();
  await expect(page.getByText("Previous Hash")).toBeVisible();

  await navigate(page, "Counterfactual Lab");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByText("Counterfactual Event Sequence")).toBeVisible();
  await page.getByLabel("Selected Event").fill("2");
  await expect(page.getByText(/EVENT 3/u)).toBeVisible();

  await navigate(page, "Evidence");
  await page.getByRole("button", { name: /Pending External Replay/u }).click();
  await expect(page.getByText("1 of 10 artifacts shown")).toBeVisible();

  await navigate(page, "Overview");
  await expect(page.getByText("Latest Deterministic Verdict")).toBeVisible();
  await expect(page.getByText("Audit Hash-Chain Continuity")).toBeVisible();
  await expect(page.locator(".toast")).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/refined-control-room-desktop-1440x900.png" });
  expect(consoleErrors).toEqual([]);
});

test("wide desktop overview remains dense and bounded", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await expect(page.locator("aside")).toBeVisible();
  await expect(page.locator(".command-bar")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/refined-control-room-desktop-1920x1080.png" });
  expect(consoleErrors).toEqual([]);
});

test("mobile navigation, confirmation, and overview remain usable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent", level: 1 })).toBeVisible();
  const objective = page.getByLabel("Agent Objective");
  const run = page.getByRole("button", { name: "Run Objective" });
  const objectiveBox = await objective.boundingBox();
  const runBox = await run.boundingBox();
  expect(objectiveBox).not.toBeNull();
  expect(runBox).not.toBeNull();
  expect(objectiveBox!.y + objectiveBox!.height).toBeLessThanOrEqual(runBox!.y);

  await page.getByRole("button", { name: /Allowed ₹199 order/u }).click();
  await confirmRun(page);
  await expect(page.getByRole("heading", { name: "Action May Proceed" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Latest Deterministic Verdict")).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();
  await expect(page.locator(".toast")).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/refined-control-room-mobile-390x844.png" });
  expect(consoleErrors).toEqual([]);
});
