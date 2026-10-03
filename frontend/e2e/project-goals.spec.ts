import { expect, test } from "@playwright/test";

test("selecting a project goal submits its workspace with the task", async ({ page }) => {
  let submitted: unknown;
  const goal = {
    id: "goal",
    title: "Reliable orders",
    description: "Durable API",
    workspace: "/repo",
    constraints: ["Keep data"],
    success_criteria: ["Survive restart"],
    status: "active",
    revision: 1,
  };
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path.endsWith("/goals")) data = { goals: [goal] };
    else if (path.endsWith("/tasks") && route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      data = { id: "root" };
    } else if (path.endsWith("/tasks")) data = { tasks: [] };
    await route.fulfill({ json: data });
  });
  await page.goto("/#/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Project goal").selectOption("goal");
  await page.getByLabel("Objective", { exact: true }).fill("Implement orders");
  await page.getByRole("button", { name: "Submit task" }).click();
  await expect(page).toHaveURL(/#\/tasks\/root$/);
  expect(submitted).toMatchObject({ objective: "Implement orders", goal_id: "goal", workspace: "/repo" });
});
