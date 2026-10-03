import { expect, test } from "@playwright/test";

test("shows exact-commit host evidence and restores a selected recovery", async ({ page }) => {
  let recovery: unknown;
  const task = {
    id: "task",
    root_id: "task",
    objective: "Recover interrupted work",
    status: "blocked",
    status_reason: "interrupted",
    owner: "Engineer",
    coordinator: "Lead",
    reviewer: "Reviewer",
    acceptance: [],
    feedback: [],
    created_at: 1,
    updated_at: 1,
  };
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path.endsWith("/tasks")) data = { tasks: [task] };
    else if (path.endsWith("/tasks/task"))
      data = {
        task: {
          task,
          children: [],
          usage: null,
          evidence: [],
          artifacts: [
            {
              id: "recovery",
              task_id: "task",
              attempt_id: "attempt",
              kind: "recovery",
              reference: "branch@abc",
              description: "Saved interrupted changes",
            },
            { id: "unsafe", kind: "file", reference: "javascript:alert(1)", description: "Unsafe URL is text" },
          ],
        },
      };
    else if (path.endsWith("/attempts")) data = { attempts: [] };
    else if (path.endsWith("/evidence"))
      data = {
        decisions: [{ id: "decision", state: "accepted", text: "Keep old column", proposer: "Lead" }],
        events: [
          {
            seq: 1,
            event_type: "task.question",
            actor: "Engineer",
            created_at: 1,
            payload: { question: "Keep column?" },
          },
        ],
        checks: [
          {
            name: "unit tests",
            passed: false,
            command: ["cargo", "test"],
            commit_sha: "exact-sha",
            exit_code: 1,
            stdout: "Failure details",
          },
        ],
      };
    else if (path.endsWith("/recovery")) {
      recovery = route.request().postDataJSON();
      data = { workspace: "/restored/checkout" };
    } else if (path.endsWith("/usage"))
      data = {
        measured_tokens: 0,
        unknown_prompts: 0,
        by_persona: [],
        by_project: [],
        records: [],
        task_token_limit: 0,
        scope_budget_state: "disabled",
      };
    await route.fulfill({ json: data });
  });
  await page.goto("/#/tasks/task");
  await expect(page.getByText("exact-sha")).toBeVisible();
  await page.getByText("exact-sha").click();
  await expect(page.getByText("Failure details")).toBeVisible();
  await expect(page.getByText("Keep old column")).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Restore checkout" }).click();
  await expect(page.getByRole("status")).toHaveText("Restored checkout: /restored/checkout");
  expect(recovery).toEqual({ artifact_id: "recovery", action: "restore" });
});
