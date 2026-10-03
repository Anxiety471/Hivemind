import { expect, test } from "@playwright/test";

test("shows warnings and unknown usage without inventing cost", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: path.endsWith("/usage")
        ? {
            measured_tokens: 85,
            unknown_prompts: 1,
            require_usage: true,
            usage_blocked: true,
            task_token_limit: 100,
            scope_budget_state: "warning",
            by_persona: [{ persona: "Engineer", measured_tokens: 85, unknown_prompts: 1 }],
            by_project: [
              {
                project: "/repo",
                measured_tokens: 90,
                unknown_prompts: 1,
                limit: 100,
                budget_state: "warning",
                usage_blocked: true,
              },
            ],
            records: [
              { turn_id: "turn", epoch: "epoch", persona: "Engineer", scope: "root", created_at: 1, usage: null },
            ],
          }
        : {},
    });
  });
  await page.goto("/#/usage");
  await page.getByLabel("Task or room scope").fill("root");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("This scope has used at least 80% of its measured token limit.")).toBeVisible();
  await expect(page.getByText("Some prompts have unknown usage. The measured total excludes them.")).toBeVisible();
  await expect(page.getByText("Project dispatch is blocked: required usage is unavailable.")).toBeVisible();
  await page.getByText("Latest 200 prompt records").click();
  await expect(page.getByRole("cell", { name: "Unknown", exact: true })).toBeVisible();
});
