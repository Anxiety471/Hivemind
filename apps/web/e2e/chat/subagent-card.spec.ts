import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  expectCardWidth,
  rpc,
  signup,
} from "../helpers/helpers";

test("a completed subagent card folds, opens from its header, and fills its width", async ({
  page,
}, testInfo) => {
  await signup(page, `subagent-card-${Date.now()}@rakazo.test`, "password12", "Subagent Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    `delegate to a helper: list three venue ideas, then run python3 -c "import hashlib,pathlib;p=pathlib.Path('notes/venues.md');print(p.name,hashlib.sha256(p.read_bytes()).hexdigest())"`,
  );
  await page.keyboard.press("Enter");

  const card = page.getByTestId("subagent-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("img", { name: "Completed", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const header = card.locator("button[aria-expanded]");
  const body = card.getByTestId("subagent-body");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-card");
  await expectCardWidth(card, 420);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(body).toContainText("helper result:");
  // The folded line stays one row however long the brief is.
  const summary = card.getByTestId("subagent-summary");
  expect(await summary.evaluate((el) => el.getBoundingClientRect().height < 30)).toBe(true);
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-card-open");
  await header.click();
  await expect(body).toBeHidden();

  await card.getByRole("button", { name: "Open helper thread" }).click();
  const helperThread = page.getByTestId("helper-thread-view");
  await expect(helperThread).toBeVisible();
  await expect(helperThread).toContainText("Completed");
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-thread");
  await helperThread.getByRole("button", { name: "Close", exact: true }).click();
  await expect(helperThread).toBeHidden();
  await expect(card).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card).toBeVisible();
  await expectCardWidth(card, 420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("a background helper's card can be stopped while the chat stays free", async ({
  page,
}, testInfo) => {
  await signup(page, `background-card-${Date.now()}@rakazo.test`, "password12", "Background Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("keep working on the venue list in the background");
  await page.keyboard.press("Enter");

  // The bot answers and its turn ends while the helper keeps working.
  // The sidebar previews the same reply, so read it from the chat.
  await expect(
    page.getByTestId("message-bot-bubble").getByText("a background helper is on it"),
  ).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("subagent-card");
  await expect(card.getByRole("img", { name: "Running", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const stop = card.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "background-helper-running");

  await stop.click();
  await expect(card.getByRole("img", { name: "Stopped", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(stop).toBeHidden();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "background-helper-stopped");
});

test("a subagent approval survives refresh while the parent keeps answering", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `subagent-approval-${Date.now()}@rakazo.test`,
    "password12",
    "Subagent Approval",
  );
  await completeOnboarding(page);
  await rpc(page, "autoReview/set", { mode: "ask" });
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "web_fetch",
  });
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("delegate to a helper: fetch https://helper-approval.rakazo.test/notes");
  await page.keyboard.press("Enter");
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(allow).toBeVisible();
  await composer.fill("this is a safe test");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("message-bot-bubble").getByText("Running the taught skill", { exact: false }),
  ).toBeVisible();
  await expect(allow).toBeVisible();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-approval-chat-free");
  await allow.click();
  await expect(
    page.getByTestId("subagent-card").getByRole("img", { name: "Completed", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(allow).toBeHidden();
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-approved");
});
