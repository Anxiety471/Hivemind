import { expect, test } from "@playwright/test";

test("answers running questions and reports undelivered steering honestly", async ({ page }) => {
  let answered = false;
  let received = "";
  const task = {
    id: "child",
    root_id: "root",
    objective: "Choose database",
    status: "running",
    owner: "Engineer",
    coordinator: "Lead",
    feedback: [],
    acceptance: [],
  };
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (path.endsWith("/operator-inbox"))
      data = {
        items: answered
          ? []
          : [{ task, questions: [{ attempt_id: "attempt", persona: "Engineer", question: "sqlite or postgres?" }] }],
        next_after: null,
      };
    else if (path.endsWith("/input")) {
      received = route.request().postDataJSON().answer;
      answered = true;
    } else if (path.endsWith("/steer")) data = { steer: { delivered_to: [] } };
    else if (path.endsWith("/info")) data = { version: "test" };
    await route.fulfill({ json: data });
  });
  await page.goto("/#/inbox");
  await expect(page.locator(".conn")).toHaveAttribute("data-status", "open");
  await expect(page.getByText("sqlite or postgres?")).toBeVisible();
  await page.getByLabel("Guidance").fill("Preserve data");
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved as feedback; no live session accepted delivery.");
  await page.getByLabel("Answer", { exact: true }).fill("sqlite");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Nothing needs your attention.")).toBeVisible();
  expect(received).toBe("sqlite");
});
