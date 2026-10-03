import { expect, test } from "@playwright/test";

const art = "  +-----+\n  | API | --> [DB]\n  +-----+";
const frames = "o --> [API]\n---frame---\n  o -> [API]\n---frame---\n    o >[API]";
const reply = `Here is the flow:\n\n\`\`\`ascii\n${art}\n\`\`\`\n\n\`\`\`ascii-animation\n${frames}\n\`\`\`\n\n\`\`\`javascript\nalert('ordinary code');\n\`\`\``;

// Exercise the actual chat/agent-history renderer, with deterministic API output.
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => { throw error; });
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  await page.routeWebSocket("**/api/v1/ws", () => {});
  const room = { id: "solo-Engineer", kind: "solo", participants: [{ persona_id: "Engineer", role: "Backend" }], updated_at: null, message_count: 1 };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith("/messages") ? { messages: [{ id: "001", turn_id: "turn", speaker: "Engineer", content: reply, created_at: 0 }], next_before: null }
      : path.endsWith("/rooms") ? { rooms: [room] }
      : path.endsWith("/solo-Engineer") ? { room }
      : path.endsWith("/tasks") ? { tasks: [] }
      : path.endsWith("/threads") ? { threads: [] }
      : path.endsWith("/active") ? { agents: [] }
      : { name: "Hivemind", version: "test", skills: [], tools: [] };
    await route.fulfill({ json });
  });
});

test("agent ASCII output animates, pauses, replays and keeps source", async ({ page }) => {
  await page.goto("/#/rooms/solo-Engineer");
  const blocks = page.locator(".msg:not([data-user=true]) .ascii-diagram");
  await expect(blocks).toHaveCount(2);
  const staticArt = blocks.nth(0);
  const animated = blocks.nth(1);
  expect(await staticArt.locator("code").textContent()).toBe(art);
  await staticArt.getByRole("button", { name: "Animate", exact: true }).click();
  await expect(staticArt.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(() => staticArt.locator("pre").evaluate((el) => el.getAnimations()[0]?.playState)).toBe("running");
  await staticArt.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => staticArt.locator("pre").evaluate((el) => el.getAnimations()[0]?.playState)).toBe("paused");
  await animated.getByRole("button", { name: "Animate", exact: true }).click();
  await expect.poll(() => animated.locator("code").textContent()).not.toBe("o --> [API]");
  await animated.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await animated.locator("code").textContent();
  await page.waitForTimeout(600);
  expect(await animated.locator("code").textContent()).toBe(paused);
  await animated.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(animated.locator("code")).toHaveText("o --> [API]");
  await animated.getByRole("button", { name: "Source", exact: true }).click();
  expect(await animated.locator("code").textContent()).toBe(frames);
  await expect(animated.getByRole("button", { name: "Animate", exact: true })).toBeDisabled();
  await animated.getByRole("button", { name: "View Animation", exact: true }).click();
  await expect(animated.getByRole("button", { name: "Animate", exact: true })).toBeEnabled();
  await expect(page.locator("pre[data-lang=javascript]")).toHaveText("alert('ordinary code');");
});

test("reduced motion disables agent ASCII playback on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/rooms/solo-Engineer");
  const blocks = page.locator(".ascii-diagram");
  await expect(blocks).toHaveCount(2);
  for (const block of await blocks.all()) {
    await expect(block.getByRole("button", { name: "Animate", exact: true })).toBeDisabled();
    await expect(block.locator(".ascii-status")).toHaveText("Reduced motion enabled");
  }
});

test("incomplete agent animation stays as source while streaming", async ({ page }) => {
  await page.route("**/api/v1/rooms/solo-Engineer/messages?**", (route) => route.fulfill({
    json: { messages: [{ id: "001", turn_id: "turn", speaker: "Engineer", content: `\`\`\`ascii-animation\n${frames}`, created_at: 0 }], next_before: null },
  }));
  await page.goto("/#/rooms/solo-Engineer");
  const block = page.locator(".ascii-diagram");
  await expect(block).toHaveCount(1);
  expect(await block.locator("code").textContent()).toBe(frames);
  await expect(block.getByRole("button", { name: "Animate", exact: true })).toBeDisabled();
  await expect(block.locator(".ascii-status")).toHaveText("Animation available when reply finishes");
});
