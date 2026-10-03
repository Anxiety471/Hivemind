import { expect, test } from "@playwright/test";

test("uploads are saved privately, previewed, published and revoked", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "Artifact library" })).toBeVisible();
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  await page.getByLabel("Upload file (up to 8 MiB)").setInputFiles({ name: "library-browser-test.txt", mimeType: "text/plain", buffer: Buffer.from("A saved artifact survives its source file.") });
  await page.getByRole("button", { name: "Save artifact", exact: true }).click();
  const card = page.locator("article.library-artifact").filter({ hasText: "library-browser-test.txt" }).first();
  await expect(card.getByText("private", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(card.locator("pre")).toHaveText("A saved artifact survives its source file.");
  await card.getByRole("button", { name: "Publish link", exact: true }).click();
  const link = card.getByRole("link", { name: "Open published artifact" });
  await expect(link).toBeVisible();
  const url = (await link.getAttribute("href"))!;
  const shared = await request.get(url);
  expect(shared.status()).toBe(200);
  expect(await shared.text()).toBe("A saved artifact survives its source file.");
  await card.getByRole("button", { name: "Revoke link", exact: true }).click();
  await expect(card.getByText("private", { exact: true })).toBeVisible();
  expect((await request.get(url)).status()).toBe(404);
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await card.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(card).toHaveCount(0);
});

test("mermaid and ascii diagrams can be created and previewed rendered", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.goto("/#/library");
  await expect(page.getByRole("heading", { name: "Artifact library" })).toBeVisible();

  // Create Mermaid diagram artifact using template
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  await page.getByRole("button", { name: "Mermaid", exact: true }).click();
  await page.getByRole("button", { name: "Save artifact", exact: true }).click();

  const mermaidCard = page.locator("article.library-artifact").filter({ hasText: "diagram.mermaid" }).first();
  await expect(mermaidCard).toBeVisible();
  await mermaidCard.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(mermaidCard.locator(".mermaid-wrap")).toBeVisible();

  // Toggle to Source
  await mermaidCard.locator(".preview-toolbar button", { hasText: "Source" }).click();
  await expect(mermaidCard.locator("pre")).toContainText("graph TD");

  // Create ASCII diagram artifact using template
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  await page.getByRole("button", { name: "ASCII", exact: true }).click();
  await page.getByRole("button", { name: "Save artifact", exact: true }).click();

  const asciiCard = page.locator("article.library-artifact").filter({ hasText: "diagram.ascii" }).first();
  await expect(asciiCard).toBeVisible();
  await asciiCard.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(asciiCard.locator(".ascii-diagram")).toBeVisible();
});
