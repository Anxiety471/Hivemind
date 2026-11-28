import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("large pasted text can stay inline or use the normal file upload", async ({
  page,
  context,
}, testInfo) => {
  await signup(page, `paste-${Date.now()}@rakazo.test`, "password12", "Paste Tester");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  const choice = page.getByRole("group", { name: "Large paste" });
  const log = Array.from(
    { length: 90 },
    (_, index) =>
      `[debug] Task ${index + 1}: reading configuration, validating input, preparing response.`,
  ).join("\n");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const paste = async (text: string) => {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await composer.focus();
    await composer.press("ControlOrMeta+V");
  };

  await paste("Review this log:\n");
  await expect(composer).toHaveValue("Review this log:\n");
  await expect(choice).toHaveCount(0);
  await paste(log);
  await expect(choice).toBeVisible();
  await expect(composer).toHaveValue(`Review this log:\n${log}`);
  await expect(composer).toBeFocused();
  await captureScreenshot(page, testInfo, "01-large-paste-choice");

  // Both actions are reachable from the field without moving focus on paste.
  await composer.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Attach as file", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(choice).toHaveCount(0);
  await expect(composer).toHaveValue("Review this log:\n");
  await expect(composer).toBeFocused();
  await expect(page.getByRole("button", { name: "Remove pasted-text.txt" })).toBeVisible();
  await captureScreenshot(page, testInfo, "02-pasted-text-attachment");

  // Pasted text goes up the same route as any other attachment: a multipart upload. The body is
  // a stream here, so assert the request shape rather than its bytes.
  const uploaded = page.waitForRequest("**/api/v1/files");
  await composer.press("Enter");
  const request = await uploaded;
  expect(request.method()).toBe("POST");
  expect(request.headers()["content-type"]).toContain("multipart/form-data");
  await expect(page.getByRole("button", { name: "Remove pasted-text.txt" })).toHaveCount(0);

  await paste(log);
  await expect(choice).toBeVisible();
  await composer.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Keep inline", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(choice).toHaveCount(0);
  await expect(composer).toHaveValue(log);
  await expect(composer).toBeFocused();
  await captureScreenshot(page, testInfo, "03-pasted-text-inline");
});
