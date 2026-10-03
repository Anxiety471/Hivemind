import { expect, test, type Page } from "@playwright/test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const api = "http://127.0.0.1:17475/api/v1";
const dir = (name: string) => join(process.env.HIVEMIND_MANAGED_DIR!, name);

test.use({ baseURL: "http://127.0.0.1:15174" });
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hivemind.first_run_complete", "true"));
  page.on("pageerror", (error) => {
    throw error;
  });
});

const openRoom = async (page: Page, id: string) => {
  await page.goto(`/#/rooms/${id}`);
  await expect(page.locator(".room-header h2")).toBeVisible();
};

test("agent replies render as markdown whatever the runtime emitted", async ({ page }) => {
  await openRoom(page, "solo-Engineer");
  await expect(page.locator(".conn")).toHaveAttribute("data-status", "open");
  await page.getByPlaceholder("Message @Engineer").fill("MARKDOWN please");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.locator(".msg:not([data-user=true]) .markdown").last();
  await expect(reply.getByRole("heading", { name: "Plan" })).toBeVisible();
  await expect(reply.locator("li")).toHaveCount(2);
  await expect(reply.locator("li strong")).toHaveText("bold");
  await expect(reply.locator("li code")).toHaveText("code");
  await expect(reply.locator("pre code")).toHaveCount(2);
  await expect(reply.locator("pre code").first()).toHaveText("print('hi')");
  expect(await reply.locator("pre code").nth(1).textContent()).toBe("if ready:\n    run()");
  const codeBlock = reply.locator(".markdown-code-block").first();
  await expect(codeBlock.getByRole("button", { name: "Artifact" })).toBeVisible();
  await codeBlock.getByRole("button", { name: "Artifact" }).click();
  await expect(codeBlock.locator(".artifact-saved")).toHaveText("Artifacted ↗");
  await expect(reply.locator("p", { hasText: "first line" }).locator("br")).toHaveCount(1);
  // The CRLF endings and blank-line runs the runtime sent never reach the history.
  const history = await (await page.request.get(`${api}/rooms/solo-Engineer/messages`)).json();
  const stored = history.messages.filter((m: { speaker: string }) => m.speaker === "Engineer").at(-1).content;
  expect(stored).not.toContain("\r");
  expect(stored).not.toMatch(/\n\n\n/);

  await page.getByPlaceholder("Message @Engineer").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg:not([data-user=true]) .markdown p", { hasText: /^Engineer here\.$/ })).toBeVisible();
});

test("a slow group chat does not queue an independent one", async ({ page, request }) => {
  const submit = async (group: string) => {
    const response = await request.post(`${api}/turns`, {
      data: { target: { type: "group", id: group }, message: "SLOW work", wait: false },
    });
    expect(response.status()).toBe(202);
    return (await response.json()).turn_id as string;
  };
  const started = Date.now();
  const [alpha, beta] = [await submit("alpha"), await submit("beta")];
  const status = async (id: string) => (await (await request.get(`${api}/turns/${id}`)).json()).status as string;

  // Both are running at the same moment.
  await expect
    .poll(async () => [await status(alpha), await status(beta)].join(","), { timeout: 2500 })
    .toBe("running,running");
  await expect
    .poll(async () => [await status(alpha), await status(beta)].join(","), { timeout: 10_000 })
    .toBe("completed,completed");
  // Each takes three seconds; serial handling would need six.
  expect(Date.now() - started).toBeLessThan(5500);

  // Each room got its own agent's reply.
  for (const [group, persona] of [["alpha", "Engineer"], ["beta", "Reviewer"]]) {
    const history = await (await request.get(`${api}/rooms/group-${group}/messages`)).json();
    expect(history.messages.filter((m: { speaker: string }) => m.speaker === persona)).toHaveLength(1);
  }
  await openRoom(page, "group-beta");
  await expect(page.locator(".msg .markdown").filter({ hasText: "Reviewer here." })).toBeVisible();

  // Within one room messages keep their order: the second waits for the first.
  const first = await submit("alpha");
  const second = await request.post(`${api}/turns`, {
    data: { target: { type: "group", id: "alpha" }, message: "SLOW again", wait: false },
  });
  const secondId = (await second.json()).turn_id as string;
  await expect.poll(() => status(first), { timeout: 2500 }).toBe("running");
  expect(await status(secondId)).toBe("queued");
  await expect.poll(() => status(secondId), { timeout: 15_000 }).toBe("completed");
});

test("workspaces can be added next to the existing ones and picked independently", async ({ page }) => {
  await page.goto("/#/workspaces");
  const section = page.locator('[data-section="workspaces"]');
  await expect(section.getByText("No workspaces added yet.")).toBeVisible();

  const add = async (path: string) => {
    await section.getByLabel("New workspace path").fill(path);
    await section.getByRole("button", { name: "Add workspace" }).click();
  };
  await add(dir("ws-two"));
  await expect(section.getByText(dir("ws-two"))).toBeVisible();
  await add(dir("ws-three"));
  await expect(section.getByText(dir("ws-three"))).toBeVisible();
  await expect(section.getByText(dir("ws-two"))).toBeVisible();

  // Mistakes are explained and keep what was typed.
  await add("relative/path");
  await expect(section.locator(".error-note")).toContainText("absolute");
  await expect(section.getByLabel("New workspace path")).toHaveValue("relative/path");
  await section.getByLabel("New workspace path").fill(dir("ws-two"));
  await section.getByRole("button", { name: "Add workspace" }).click();
  await expect(section.locator(".error-note")).toContainText("already exists");

  // Use the second workspace for Reviewer only.
  const personas = page.locator('[data-section="persona-workspaces"]');
  const reviewerRow = personas.locator("tr", { hasText: "Reviewer" });
  await reviewerRow.getByRole("button", { name: "Change" }).click();
  await reviewerRow.getByLabel("Choose a workspace").selectOption(dir("ws-two"));
  await reviewerRow.getByRole("button", { name: "Save" }).click();
  await expect(reviewerRow.locator(".mono")).toHaveText(dir("ws-two"));
  await expect(personas.locator("tr", { hasText: "Engineer" }).locator(".mono")).toHaveText(dir("ws-one"));
  await expect(section.getByText(`used by Reviewer`)).toBeVisible();
  await expect(section.locator("tr", { hasText: dir("ws-two") }).getByRole("button", { name: "Remove" })).toBeDisabled();

  // Everything survives a reload; an unused workspace can be removed again.
  await page.reload();
  await expect(section.getByText(dir("ws-three"))).toBeVisible();
  await expect(personas.locator("tr", { hasText: "Reviewer" }).locator(".mono")).toHaveText(dir("ws-two"));
  await section.locator("tr", { hasText: dir("ws-three") }).getByRole("button", { name: "Remove" }).click();
  await expect(section.getByText(dir("ws-three"))).toHaveCount(0);
  await expect(section.getByText(dir("ws-two"))).toBeVisible();
});

test("agents are created, edited and deleted from the web UI", async ({ page, request }) => {
  await page.goto("/#/agents");
  await expect(page.locator('[data-agent="Engineer"]')).toBeVisible();

  await page.getByRole("button", { name: "New agent" }).click();
  const form = page.locator('[data-form="create"]');
  await form.getByLabel("Agent id").fill("Engineer");
  await expect(form.getByText("already exists")).toBeVisible();
  await expect(form.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await form.getByLabel("Agent id").fill("Designer");
  await form.getByRole("radio", { name: /^Pi/ }).check();
  await form.getByLabel("Agent workspace").fill("/definitely/not/here");
  await form.getByLabel("System prompt").fill("You are the Designer. Keep it clear.");
  await form.getByRole("group", { name: "Capabilities" }).getByText("design", { exact: true }).click();
  await form.getByLabel("Add capability").fill("ux");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await form.getByRole("combobox", { name: "Model" }).click();
  await form.getByRole("option", { name: /E2E Model/ }).click();
  await form.getByRole("radio", { name: "High" }).check();
  await form.getByRole("button", { name: "Create agent" }).click();

  // The failure is shown and nothing typed is lost.
  await expect(form.locator(".error-note")).toContainText("does not exist");
  await expect(form.getByLabel("System prompt")).toHaveValue("You are the Designer. Keep it clear.");
  await expect(form.getByLabel("Agent workspace")).toHaveValue("/definitely/not/here");

  await form.getByLabel("Agent workspace").fill(dir("ws-two"));
  await form.getByRole("button", { name: "Create agent" }).click();
  const card = page.locator('[data-agent="Designer"]');
  await expect(card).toBeVisible();
  await expect(card.getByText(dir("ws-two"))).toBeVisible();
  await expect(card.getByText("design", { exact: true })).toBeVisible();
  // Agent creation must not undo the workspace selected in the preceding flow.
  const designer = await (await request.get(`${api}/agents/Designer`)).json();
  expect([designer.config.model, designer.config.reasoning, designer.config.capabilities]).toEqual(["acme/e2e-model", "high", ["design", "ux"]]);
  const reviewer = await (await request.get(`${api}/agents/Reviewer`)).json();
  expect(reviewer.config.workspace).toBe(dir("ws-two"));
  const workspaces = await (await request.get(`${api}/workspaces`)).json();
  expect(workspaces.personas.find((p: { id: string }) => p.id === "Reviewer").workspace).toBe(dir("ws-two"));
  // The new agent is immediately a conversation target.
  await expect(page.locator('a[href="#/rooms/solo-Designer"]')).toBeVisible();

  // Edit: the saved values are there when the agent is revisited.
  await card.getByRole("button", { name: "Edit" }).click();
  const edit = page.locator('[data-form="edit"]');
  await expect(page.locator('[data-agent="Reviewer"]')).toHaveCount(0);
  await expect(edit.getByLabel("System prompt")).toHaveValue("You are the Designer. Keep it clear.");
  await edit.getByLabel("System prompt").fill("You are the Designer. Be brief.");
  await edit.getByRole("combobox", { name: "Model" }).fill("acme/model-1");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator('[data-form="edit"]')).toHaveCount(0);
  await expect(page.locator('[data-agent="Reviewer"]')).toBeVisible();
  await page.reload();
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Edit" }).click();
  await expect(page.locator('[data-form="edit"]').getByLabel("System prompt")).toHaveValue("You are the Designer. Be brief.");
  await expect(page.locator('[data-form="edit"]').getByRole("combobox", { name: "Model" })).toHaveValue("acme/model-1");
  await page.locator('[data-form="edit"]').getByRole("button", { name: "Cancel" }).click();

  // An edit made elsewhere while the form is open is flagged and the typed text survives.
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Edit" }).click();
  const open = page.locator('[data-form="edit"]');
  await open.getByLabel("System prompt").fill("unsaved local text");
  const elsewhere = await request.put(`${api}/agents/Designer`, {
    data: { runtime: "pi", workspace: dir("ws-two"), system_prompt: "changed by the CLI" },
  });
  expect(elsewhere.status()).toBe(200);
  await expect(open.getByText("changed elsewhere")).toBeVisible();
  await expect(open.getByLabel("System prompt")).toHaveValue("unsaved local text");
  await open.getByRole("button", { name: "Cancel" }).click();

  // The agent flows into groups; one that a group uses cannot be deleted.
  const group = await request.patch(`${api}/chat-groups/beta`, { data: { members: ["Reviewer", "Designer"] } });
  expect(group.status()).toBe(200);
  await page.reload();
  const target = page.locator('[data-agent="Designer"]');
  await target.getByRole("button", { name: "Delete" }).click();
  await expect(target.getByRole("alertdialog")).toContainText("still in beta");
  await target.getByRole("button", { name: "Confirm delete" }).click();
  await expect(target.locator(".error-note")).toContainText("still a member of group beta");
  await expect(target).toBeVisible();
  await request.patch(`${api}/chat-groups/beta`, { data: { members: ["Reviewer"] } });
  await page.reload();
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Delete" }).click();
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('[data-agent="Designer"]')).toBeVisible();
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Delete" }).click();
  await page.locator('[data-agent="Designer"]').getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.locator('[data-agent="Designer"]')).toHaveCount(0);
  const agents = await (await request.get(`${api}/agents`)).json();
  expect(agents.agents.map((a: { name: string }) => a.name)).toEqual(["Engineer", "Reviewer"]);
});

test("the settings panel keeps details and sessions and adds per-conversation settings", async ({ page }) => {
  await openRoom(page, "group-alpha");
  // The header offers Details and Settings only; runtime sessions live in the panel's
  // Sessions tab and the tool/skill exposure lives in the panel's Tools & Skills tab.
  await expect(page.getByRole("button", { name: "Runtime sessions" })).toHaveCount(0);
  await expect(page.locator(".room-header").getByRole("button", { name: "Tools & Skills" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByLabel("Conversation panel");
  await expect(panel.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "Details" }).click();
  await expect(panel.getByRole("heading", { name: "Goal" })).toBeVisible();
  // Four tabs fit without a horizontal scrollbar in the 360px panel.
  const tabsOverflow = await panel
    .locator(".tabs")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(tabsOverflow).toBeLessThanOrEqual(0);
  await panel.getByRole("tab", { name: "Tools & Skills" }).click();
  await expect(panel.getByRole("tab", { name: /Runtime tools/ })).toBeVisible();
  await expect(panel.locator(".skills-exposure")).toContainText("Configured Skills");
  await panel.getByRole("tab", { name: "Sessions" }).click();
  await expect(panel.getByRole("link", { name: "Open full session view" })).toBeVisible();

  await panel.getByRole("tab", { name: "Settings" }).click();
  const save = panel.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();
  await panel.getByLabel("Nickname").fill("Alpha squad");
  await panel.getByLabel("Pin to the top").check();
  await panel.getByLabel("Mute").check();
  await panel.getByLabel("Mode").selectOption("discussion");
  await panel.getByLabel("Workspace", { exact: true }).selectOption(dir("ws-two"));
  await save.click();
  await expect(panel.getByRole("status")).toHaveText("Settings saved.");
  // Saved values show up in the room list and header.
  await expect(page.locator(".room-list .room", { hasText: "Alpha squad" })).toBeVisible();
  await expect(page.locator(".room-list .room", { hasText: "Alpha squad" }).getByLabel("Pinned")).toBeVisible();
  await expect(page.locator(".room-list .room", { hasText: "Alpha squad" }).locator(".count")).toHaveCount(0);
  await expect(page.locator(".room-header h2")).toContainText("Alpha squad");

  // They persist across a reload and match the server.
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Nickname")).toHaveValue("Alpha squad");
  await expect(page.getByLabel("Mode")).toHaveValue("discussion");
  const settings = await (await page.request.get(`${api}/rooms/group-alpha/settings`)).json();
  expect(settings.settings).toMatchObject({ nickname: "Alpha squad", pinned: true, muted: true, mode: "discussion", workspace: dir("ws-two") });

  // Pinned rooms sort first in their section.
  const groupRooms = page.locator(".room-group", { hasText: "Groups" }).locator(".room-name");
  await expect(groupRooms.first()).toHaveText("Alpha squad");

  // The main conversation and direct messages hide nothing silently: unavailable controls say why.
  await openRoom(page, "main");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Mode")).toBeDisabled();
  await expect(page.getByText("always broadcasts to every agent")).toBeVisible();
  await expect(page.getByText("no single workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Reviewer up" })).toBeVisible();
  await page.getByRole("button", { name: "Move Reviewer up" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved.");
  const main = await (await page.request.get(`${api}/rooms/main/settings`)).json();
  expect(main.settings.reply_order).toEqual(["Reviewer", "Engineer"]);

  await openRoom(page, "solo-Engineer");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("single agent, so there is no reply order")).toBeVisible();
  await expect(page.getByLabel("Mode")).toBeDisabled();

  // A rejected change keeps the typed value and explains itself.
  await page.getByLabel("Workspace path").fill("relative/nope");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".room-settings .error-note")).toContainText("absolute");
  await expect(page.getByLabel("Workspace path")).toHaveValue("relative/nope");
});

test("typing @ in a group chat autocompletes agent mentions", async ({ page }) => {
  await openRoom(page, "main");
  const textarea = page.getByPlaceholder("Message Main");
  await textarea.fill("@");
  const menu = page.locator(".mention-menu");
  await expect(menu).toBeVisible();
  const items = menu.locator(".mention-item");
  await expect(items).toHaveCount(2);
  await page.screenshot({ path: join(repositoryRoot, "docs", "pr33-verification", "05-mention-autocomplete.png") });

  // Keyboard navigation
  await textarea.press("ArrowDown");
  await expect(items.nth(1)).toHaveClass(/active/);
  // Filter by query
  await textarea.fill("@Rev");
  await expect(items).toHaveCount(1);
  await expect(items.first().locator(".mention-item-name")).toHaveText("Reviewer");

  // Press Enter to complete mention
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("@Reviewer ");
  await expect(menu).not.toBeVisible();

  // Mouse click selection
  await textarea.fill("Ask ");
  await textarea.pressSequentially("@");
  await expect(menu).toBeVisible();
  await items.filter({ hasText: "Engineer" }).click();
  await expect(textarea).toHaveValue("Ask @Engineer ");
  await expect(menu).not.toBeVisible();

  // Pressing Escape closes menu
  await textarea.fill("@");
  await expect(menu).toBeVisible();
  await textarea.press("Escape");
  await expect(menu).not.toBeVisible();
});

test("the command menu, G shortcuts and C reach every part of the app", async ({ page }) => {
  await openRoom(page, "main");
  // ⌘K / Ctrl+K opens the command menu; searching and Enter run the match.
  await page.keyboard.press("Control+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  await menu.getByLabel("Search commands").fill("go to agents");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(page.locator('[data-agent="Engineer"]')).toBeVisible();

  // Agents show up as message targets.
  await page.getByRole("button", { name: "Search and commands" }).click();
  await menu.getByLabel("Search commands").fill("message reviewer");
  await menu.getByRole("option", { name: /Message Reviewer/ }).click();
  await expect(page).toHaveURL(/#\/rooms\/solo-Reviewer$/);

  // G then a key navigates; C opens the new-issue composer from anywhere.
  await page.locator("body").click();
  await page.keyboard.press("g");
  await page.keyboard.press("w");
  await expect(page).toHaveURL(/#\/workspaces$/);
  // Agents' self-scheduled wakeups have their own page (none are pending in this hive).
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/#\/schedules$/);
  await expect(page.getByText("No pending wakeups.")).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New issue" })).toBeVisible();
  await expect(page).toHaveURL(/#\/issues$/);
  await page.keyboard.press("Escape");

  // The theme can be forced from settings and survives a reload.
  await page.goto("/#/settings");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});
