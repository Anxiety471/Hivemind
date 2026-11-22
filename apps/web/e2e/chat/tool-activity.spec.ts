import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

const fixture = "/e2e/fixtures/tool-activity.html";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const NOTE_TEXT = "Anna is free all Tuesday afternoon.";
const STORAGE_KEY = "rakazo.showToolActivity";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

async function openThread(page: Page, phase: "live" | "done" | "approval" | "rewound") {
  await page.goto(`${fixture}?view=thread&phase=${phase}`);
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
}

async function setToggle(page: Page, on: boolean) {
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const toggle = settings.getByTestId("tool-activity-toggle");
  await expect(toggle).toBeVisible();
  if (on) await expect(toggle).not.toBeChecked();
  else await expect(toggle).toBeChecked();
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBe(on ? "on" : "off");
  await toggle.scrollIntoViewIfNeeded();
}

test("monitor and checkpoints work across live, settled, approval, and rewound runs", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    await openThread(page, "live");
    const liveLine = page.getByTestId("tool-activity-line");
    await expect(liveLine).toHaveCount(1);
    await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
    const liveTrigger = page.getByTestId("activity-trigger");
    await expect(liveTrigger).toHaveAttribute("aria-expanded", "true");
    const livePanel = page.getByTestId("tool-activity");
    await expect(livePanel).toContainText("Claude Opus 5.5");
    await expect(livePanel).toContainText("$0.039");
    await expect(livePanel).toContainText("Running");
    await expect(livePanel).toContainText("Check conflicts");
    await expect(page.getByTestId("thinking-row")).toHaveCount(1);
    await expect(page.getByTestId("thinking-trigger")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("tool-rows")).toContainText("Open calendar");
    await expect(page.getByTestId("tool-rows")).toContainText("Check conflicts");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-live-${viewport.name}`);

    await liveTrigger.click();
    await expect(liveTrigger).toHaveAttribute("aria-expanded", "false");

    await openThread(page, "done");
    await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
    // The monitor stands above the reply rather than inside its bubble.
    await expect(page.getByTestId("message-bot-bubble")).not.toContainText(
      "The person needs a free slot",
    );
    const donePanel = page.getByTestId("tool-activity");
    const doneTrigger = page.getByTestId("activity-trigger");
    await expect(doneTrigger).toHaveCount(1);
    await expect(doneTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(donePanel).toContainText("Claude Opus 5.5");
    await expect(donePanel).toContainText("+3");
    await expect(donePanel).toContainText("$0.055");
    await captureScreenshot(page, testInfo, `default-done-collapsed-${viewport.name}`);

    await doneTrigger.click();
    await expect(doneTrigger).toHaveAttribute("aria-expanded", "true");
    const thinkingTrigger = page.getByTestId("thinking-trigger");
    await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "false");
    await thinkingTrigger.click();
    await expect(page.getByTestId("thinking-detail")).toContainText(
      "Checking Tuesday afternoon first.",
    );
    await page
      .locator("[data-step-inspector-trigger]")
      .filter({ hasText: "Check conflicts" })
      .first()
      .click();
    await expect(donePanel.getByRole("dialog")).toContainText(NOTE_TEXT);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-done-expanded-${viewport.name}`);

    await donePanel.getByRole("button", { name: "Open execution log" }).click();
    await expect(page.getByText("Execution trace")).toBeVisible();
    await page.keyboard.press("Escape");

    await openThread(page, "approval");
    const approvalPanel = page.getByTestId("tool-activity");
    await expect(approvalPanel).toContainText("Needs you");
    await expect(approvalPanel).toContainText("Ready to ship");
    await expect(approvalPanel.locator("code")).toContainText("gh release create v3.2.0");
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-approval-${viewport.name}`);

    await openThread(page, "rewound");
    const rewoundTrigger = page.getByTestId("activity-trigger");
    await expect(rewoundTrigger).toHaveAttribute("aria-expanded", "false");
    await rewoundTrigger.click();
    const rewoundPanel = page.getByTestId("tool-activity");
    await expect(rewoundPanel.getByTestId("tool-rows").locator("svg")).toHaveCount(1);
    await expect(rewoundPanel).toContainText("Attempt 2");
    await expect(rewoundPanel).toContainText("Stopped");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-rewound-${viewport.name}`);
  }
});

test("the settings toggle hides and restores tool activity", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const initialToggle = settings.getByTestId("tool-activity-toggle");
  await expect(initialToggle).toBeVisible();
  await expect(initialToggle).toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBeNull();
  await initialToggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-tool-activity-on");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toHaveText(REPLY_TEXT);
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(page.getByTestId("tool-activity")).toContainText("Claude Opus 5.5");
  await captureScreenshot(page, testInfo, "on-done");

  await openThread(page, "live");
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "on-live");

  await setToggle(page, false);
  await captureScreenshot(page, testInfo, "settings-tool-activity-off");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toHaveText(REPLY_TEXT);
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByTestId("activity-trigger")).toHaveCount(0);
  await expect(page.getByText("Checking Tuesday afternoon first.")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-done");

  await openThread(page, "live");
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-live");

  await setToggle(page, true);
  await captureScreenshot(page, testInfo, "settings-tool-activity-on-again");

  await openThread(page, "done");
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(page.getByTestId("tool-activity")).toContainText("Claude Opus 5.5");
  await captureScreenshot(page, testInfo, "on-again-done");
});
