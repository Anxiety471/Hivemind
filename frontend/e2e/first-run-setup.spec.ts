import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const apiUrl = "http://127.0.0.1:17474";

test("sets up the first persona through the browser", async ({ page }) => {
  const browserIssues: string[] = [];
  let expectedSaveFailure = false;
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      // Chromium logs the intentionally simulated HTTP 500 as a resource error.
      if (
        expectedSaveFailure &&
        /Failed to load resource.*500/.test(message.text())
      )
        return;
      browserIssues.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserIssues.push(error.message));

  // An old browser completion flag must not conceal a new server.
  await page.addInitScript(() => {
    localStorage.setItem("hivemind.first_run_complete", "true");
    localStorage.setItem(
      "hivemind.settings",
      JSON.stringify({ baseUrl: "http://127.0.0.1:17474", token: "" }),
    );
  });
  await page.goto("/");
  await expect(page).toHaveURL("http://127.0.0.1:15173/");
  await expect(page).toHaveTitle(/Hivemind/);
  await expect(
    page.getByRole("heading", { name: "Get your hive online." }),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay, nextjs-portal")).toHaveCount(
    0,
  );

  const screenshotDirectory = join(
    process.cwd(),
    "test-results",
    "screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(screenshotDirectory, "first-run-desktop.png"),
    await page.screenshot({ fullPage: true }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Get your hive online." }),
  ).toBeVisible();
  await writeFile(
    join(screenshotDirectory, "first-run-mobile.png"),
    await page.screenshot({ fullPage: true }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole("button", { name: "Set up later" }).click();
  await expect(page.getByRole("link", { name: /Rooms/ })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Get your hive online." }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Solo assistant/ }).click();
  await expect(
    page.getByRole("button", { name: /Solo assistant/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Engineer \+ reviewer/ }).click();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Server URL").fill("file:///bad-server");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("http:// or https://");
  await page.getByLabel("Server URL").fill(apiUrl);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Configure your personas" }),
  ).toBeVisible();

  await page.getByLabel("Persona ID").nth(1).fill("engineer");
  await expect(
    page.getByRole("button", { name: "Review setup" }),
  ).toBeDisabled();
  await expect(page.getByText("Each persona needs a unique ID.")).toBeVisible();
  await page.getByLabel("Persona ID").nth(1).fill("Reviewer");
  await page.getByRole("button", { name: "Remove Reviewer" }).click();
  await page.getByLabel(/Workspace/).fill(" ");
  await expect(
    page.getByRole("button", { name: "Review setup" }),
  ).toBeDisabled();
  await page.getByLabel(/Workspace/).fill(".");
  await page.getByLabel("Persona ID").first().fill("E2E Engineer");
  await page.getByLabel("Role description").first().fill("Browser setup test");
  await page.getByLabel("Runtime").first().selectOption("omp");
  await page.getByText("Model and behavior (optional)").click();
  await page.getByPlaceholder("provider/model-id").fill("provider/e2e-model");
  await page
    .getByLabel("System prompt")
    .first()
    .fill("Created by the first-run browser E2E test.");
  await writeFile(
    join(screenshotDirectory, "persona-configuration.png"),
    await page.screenshot({ fullPage: true }),
  );
  // A refresh keeps the team draft, but rechecks the connection.
  await page.reload();
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByLabel("Persona ID")).toHaveValue("E2E Engineer");
  await page.getByRole("button", { name: "Review setup" }).click();
  await expect(
    page.getByRole("heading", { name: "Review your hive" }),
  ).toBeVisible();
  await expect(
    page.getByText("provider/e2e-model", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit team" }).click();
  await expect(page.getByLabel("Persona ID")).toHaveValue("E2E Engineer");
  await page.getByRole("button", { name: "Review setup" }).click();
  await page.screenshot({
    path: join(screenshotDirectory, "setup-review.png"),
    fullPage: true,
  });
  // A failed save stays on review and keeps the draft for retry.
  expectedSaveFailure = true;
  await page.route("**/api/v1/setup", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Setup could not be saved" },
        }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Setup could not be saved",
  );
  await expect(
    page.getByRole("heading", { name: "Review your hive" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/setup");
  expectedSaveFailure = false;
  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(
    page.getByRole("heading", { name: "Your hive is ready." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("hivemind.setup-draft.v1:http://127.0.0.1:17474"),
    ),
  ).toBeNull();
  await page.screenshot({
    path: join(screenshotDirectory, "setup-ready.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start chatting" }).click();

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

  await writeFile(
    join(screenshotDirectory, "setup-complete.png"),
    await page.screenshot({ fullPage: true }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Get your hive online." }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/#\/rooms$/);
  expect(browserIssues).toEqual([]);
});

test("configured server opens the dashboard in a new browser", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:15174/");
  await expect(page.getByRole("link", { name: /Rooms/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Get your hive online." }),
  ).toHaveCount(0);
});
