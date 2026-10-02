import { expect, test } from "@playwright/test";

test("creates a schedule and links its run to a task", async ({ page }) => {
  let created: Record<string, unknown> | undefined;
  let ran = false;
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path.endsWith("/goals")) data = { goals: [] };
    else if (path.endsWith("/routines") && route.request().method() === "POST")
      created = route.request().postDataJSON();
    else if (path.endsWith("/routines"))
      data = {
        routines: created
          ? [
              {
                ...created,
                id: "routine",
                enabled: true,
                revision: 1,
                next_at: 100,
                runs: ran ? [{ id: "run", status: "submitted", task_id: "root", created_at: 100 }] : [],
              },
            ]
          : [],
      };
    else if (path.endsWith("/run")) {
      ran = true;
      data = { run: { status: "submitted", task_id: "root" } };
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/#/routines");
  await page.getByLabel("Name", { exact: true }).fill("Check CI");
  await page.getByLabel("Objective", { exact: true }).fill("Investigate failed builds");
  await page.getByLabel("Every (minutes)").fill("30");
  await page.getByRole("button", { name: "Create routine" }).click();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
  expect(created?.interval_secs).toBe(1800);
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "#/tasks/root");
});
