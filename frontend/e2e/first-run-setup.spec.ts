import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const apiUrl = "http://127.0.0.1:17474";

test("sets up the first persona through the browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Get your hive online." })).toBeVisible();

  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Configure your personas" })).toBeVisible();

  await page.getByRole("button", { name: "Remove Reviewer" }).click();
  await page.getByLabel("Persona ID").first().fill("E2E Engineer");
  await page.getByLabel("Role description").first().fill("Browser setup test");
  await page.getByLabel("Runtime").first().selectOption("omp");
  await page.getByPlaceholder("provider/model-id").fill("provider/e2e-model");
  await page.getByLabel("System prompt").first().fill("Created by the first-run browser E2E test.");
  await page.getByRole("button", { name: "Save setup" }).click();

  await expect(page).toHaveURL(/#\/rooms$/);
  await expect(page.getByRole("link", { name: /Rooms/ })).toBeVisible();

  const setupStatus = await page.request.get(apiUrl + "/api/v1/setup");
  expect(setupStatus.ok()).toBeTruthy();
  expect((await setupStatus.json()).setup_required).toBe(false);

  const agents = await page.request.get(apiUrl + "/api/v1/agents");
  expect(agents.ok()).toBeTruthy();
  expect(await agents.json()).toEqual({
    agents: [{ name: "E2E Engineer", runtime: "omp" }],
  });

  const configPath = process.env.HIVEMIND_E2E_CONFIG;
  expect(configPath).toBeTruthy();
  const savedConfig = await readFile(configPath!, "utf8");
  expect(savedConfig).toContain('id = "E2E Engineer"');
  expect(savedConfig).toContain('runtime = "omp"');
  expect(savedConfig).toContain('model = "provider/e2e-model"');

  await page.reload();
  await expect(page.getByRole("heading", { name: "Get your hive online." })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/rooms$/);
});
