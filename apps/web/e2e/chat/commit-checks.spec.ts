import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

// The scripted runtime echoes the first 180 characters of the prompt back as its reply, so the
// pull request link shows in the bot's reply. The API's answers are stood in for here: the
// browser never contacts the linked site, and the check list comes from the stubbed read.
const REPO = "ci.example.test/acme/app";
const REPLY = "Review https://ci.example.test/acme/app/pull/7 when the build is in.";

const RUN_START = "2026-03-01T10:00:00.000Z";

const runningChecks = [
  {
    name: "unit",
    state: "passed",
    url: `https://ci.example.test/acme/app/runs/1`,
    startedAt: RUN_START,
    completedAt: "2026-03-01T10:01:05.000Z",
  },
  {
    name: "e2e",
    state: "running",
    url: `https://ci.example.test/acme/app/runs/2`,
    startedAt: RUN_START,
    completedAt: null,
  },
];

const failedChecks = [
  {
    name: "unit",
    state: "failed",
    url: `https://ci.example.test/acme/app/runs/1`,
    startedAt: RUN_START,
    completedAt: "2026-03-01T10:00:42.000Z",
  },
];

async function openBotReply(page: Page, checks: unknown[], name: string) {
  await page.route("**/rpc/links/favicon", (route) =>
    route.fulfill({ json: { json: { icon: null } } }),
  );
  await page.route("**/rpc/commitChecks/list", (route) =>
    route.fulfill({
      json: {
        json: {
          commits: [],
          pullRequests: [{ repository: REPO, number: 7, sha: "abcdef0123456789", checks }],
        },
      },
    }),
  );
  await signup(
    page,
    `commit-checks-${name}-${Date.now()}@rakazo.test`,
    "password12",
    "Commit Checks",
  );
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(REPLY);
  await composer.press("Enter");
  const bubble = page.getByTestId("message-bot-bubble").last();
  await expect(bubble.getByRole("link", { name: /pull\/7/ })).toBeVisible({ timeout: 20_000 });
  return bubble;
}

test("a pull request link shows its checks while they run, and lists each one", async ({
  page,
}, testInfo) => {
  const bubble = await openBotReply(page, runningChecks, "running");

  const status = bubble.getByRole("button", { name: "Checks: 1 of 2 passed" });
  await expect(status).toBeVisible();
  await expect(status.locator(".rk-check-ring")).toBeVisible();

  await status.click();
  const list = page.getByTestId("commit-checks");
  await expect(list.getByRole("link", { name: "unit" })).toHaveAttribute(
    "href",
    "https://ci.example.test/acme/app/runs/1",
  );
  await expect(list.getByText("1m 5s")).toBeVisible();
  await captureScreenshot(page, testInfo, "commit-checks-running");
});

test("a pull request link shows a cross when one of its checks failed", async ({
  page,
}, testInfo) => {
  const bubble = await openBotReply(page, failedChecks, "failed");

  const status = bubble.getByRole("button", { name: "Checks failed" });
  await expect(status).toBeVisible();
  await expect(status.locator("svg")).toBeVisible();
  await captureScreenshot(page, testInfo, "commit-checks-failed");
});
