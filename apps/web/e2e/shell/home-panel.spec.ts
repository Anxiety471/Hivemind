import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("the header pill opens the bot's Home panel, and its gear leads to settings", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await signup(page, `home-panel-${Date.now()}@rakazo.test`, "password12", "Home Panel");
  await completeOnboarding(page);
  const pill = page.getByTestId("bot-settings-trigger");
  if ((await pill.getAttribute("aria-expanded")) !== "true") await pill.click();
  const home = page.getByTestId("home-panel");
  await expect(home).toBeVisible();
  await captureScreenshot(page, testInfo, "home-panel");
  await page.getByTestId("home-panel-settings").click();
  await expect(page.getByTestId("bot-profile-header")).toBeVisible();
});
