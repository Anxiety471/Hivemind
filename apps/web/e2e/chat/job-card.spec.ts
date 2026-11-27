import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

test("chat shows a finished coding job as one card with its details", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/job-card.html");
    const card = page.getByTestId("job-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("job-status")).toContainText("Finished");
    await expect(card.getByTestId("job-meta-branch")).toContainText("example-org/billing-worker");
    await expect(card.getByTestId("job-pr-link")).toHaveAttribute(
      "href",
      "https://github.com/example-org/example-repo/pull/1",
    );
    await expect(card.getByTestId("job-output")).toContainText("retry test for the invoice path");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `finished-${viewport.name}`);
  }
});
