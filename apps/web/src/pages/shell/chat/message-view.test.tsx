// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/query/rpc";
import { MessageView } from "./message-view";

const skills = vi.hoisted(() => ({
  updateDraft: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
  testRun: vi.fn(async () => ({ runId: "run" })),
}));
vi.mock("../../../lib/query/rpc", () => ({ rpc: { skills, artifacts: { get: vi.fn() } } }));

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type PeerBot = ComponentProps<typeof MessageView>["peerBot"];
const missingBot: PeerBot = () => undefined;
const existingBot: PeerBot = () => ({ color: "orange" });

const planner = (status: "created" | "archived" | "deleted" = "created") => ({
  kind: "child_bot" as const,
  botId: "child",
  name: "Planner",
  status,
});

function renderView(
  role: ThreadMessage["role"],
  blocks: ThreadMessage["blocks"],
  props: Partial<ComponentProps<typeof MessageView>> = {},
) {
  const message: ThreadMessage = {
    id: "message",
    threadId: "thread",
    seq: 1,
    role,
    createdAt: new Date().toISOString(),
    blocks,
  };
  act(() =>
    root.render(
      <MessageView
        rpc={rpc}
        artifactTarget={{ botId: "parent" }}
        canAnswer={false}
        canDismiss={false}
        message={message}
        onAnswer={vi.fn()}
        onOpenBot={vi.fn()}
        onOpenPeerMessages={vi.fn()}
        peerBot={existingBot}
        onRefresh={vi.fn()}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        callHoldsSpeaker={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        onReleaseComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn()}
        {...props}
      />,
    ),
  );
}

function renderMessage(
  blocks: ThreadMessage["blocks"],
  peerBot: PeerBot,
  mentions?: ReturnType<typeof planner>[],
) {
  const onOpenBot = vi.fn();
  renderView("bot", blocks, { mentions, onOpenBot, peerBot });
  const mention = container.querySelector<HTMLElement>('[data-testid="bot-mention"]')!;
  act(() => mention.click());
  return { mention, onOpenBot };
}

it("keeps a received peer marker off the user's side while user replies align to the end", () => {
  renderView("user", [
    { kind: "bot_message_received", fromBotId: "peer", fromBotName: "Atlas", text: "Done." },
  ]);
  const chip = container.querySelector('[data-testid="peer-receipt-chip"]');
  expect(chip?.textContent).toBe("Message from Atlas");
  expect(chip?.closest(".items-end")).toBeNull();

  renderView("user", [{ kind: "text", text: "Thanks." }]);
  expect(container.querySelector(".items-end")?.textContent).toContain("Thanks.");
});

it("names a new bot inline in the reply, in its color", () => {
  const { mention, onOpenBot } = renderMessage(
    [{ kind: "text", text: "Planner is ready." }],
    existingBot,
    [planner()],
  );
  const bubble = container.querySelector('[data-testid="message-bot-bubble"]');
  expect(bubble?.contains(mention)).toBe(true);
  expect(bubble?.textContent).toBe("Planner is ready.");
  expect(mention.tagName).toBe("BUTTON");
  expect(mention.querySelector("span[dir]")?.getAttribute("style")).toContain("color");
  expect(onOpenBot).toHaveBeenCalledWith("child");
});

it("sets a bot's reply as plain text on the page, without a bubble", () => {
  renderMessage([{ kind: "text", text: "Ready when you are." }], existingBot, [planner()]);
  const reply = container.querySelector<HTMLElement>('[data-testid="message-bot-bubble"]');
  expect(reply?.className).not.toContain("bg-muted");
  expect(reply?.className).not.toContain("rounded");
});

it("puts the bot first when the reply does not name it", () => {
  renderMessage([{ kind: "text", text: "Ready when you are." }], existingBot, [planner()]);
  expect(container.querySelector('[data-testid="message-bot-bubble"]')?.textContent).toBe(
    "Planner Ready when you are.",
  );
});

it.each([
  ["no longer exists", "created", missingBot],
  ["was deleted", "deleted", existingBot],
] as const)("keeps the name without color or link when the bot %s", (_, status, peerBot) => {
  const { mention, onOpenBot } = renderMessage(
    [{ kind: "text", text: "Planner is gone." }],
    peerBot,
    [planner(status)],
  );
  expect(mention.textContent).toBe("Planner");
  expect(mention.tagName).toBe("SPAN");
  expect(mention.querySelector("span[dir]")?.getAttribute("style")).toBeNull();
  expect(onOpenBot).not.toHaveBeenCalled();
});

it("shows an announcement with no reply yet on its own", () => {
  const { mention, onOpenBot } = renderMessage([planner()], existingBot);
  expect(mention.textContent).toBe("Planner");
  expect(onOpenBot).toHaveBeenCalledWith("child");
});

it("names the bot once across a reply's text blocks", () => {
  renderMessage(
    [
      { kind: "text", text: "Setting up." },
      { kind: "text", text: "Planner is ready." },
    ],
    existingBot,
    [planner()],
  );
  expect(container.querySelectorAll('[data-testid="bot-mention"]')).toHaveLength(1);
  expect(container.textContent).toContain("Setting up.");
  expect(container.textContent).toContain("Planner is ready.");
});

it("keeps an edit made after a save when the saved status arrives late", async () => {
  const draft = {
    kind: "skill_draft" as const,
    skillId: "skill",
    name: "Weekly report",
    goal: "Send the weekly report",
    playbook: {
      whenToUse: "Fridays",
      inputs: [],
      steps: ["Collect"],
      howToCheck: "",
      whatToReturn: "",
      approvalBoundaries: "",
      failureHandling: "",
    },
    status: "draft" as const,
  };
  const render = (block: typeof draft | (Omit<typeof draft, "status"> & { status: "saved" })) =>
    root.render(
      <MessageView
        rpc={rpc}
        artifactTarget={{ botId: "parent" }}
        canAnswer={false}
        canDismiss={false}
        message={{
          id: "message",
          threadId: "thread",
          seq: 1,
          role: "bot",
          createdAt: new Date().toISOString(),
          blocks: [block],
        }}
        onAnswer={vi.fn()}
        onOpenBot={vi.fn()}
        onOpenPeerMessages={vi.fn()}
        peerBot={existingBot}
        onRefresh={() => Promise.reject(new Error("offline"))}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        callHoldsSpeaker={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        onReleaseComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn()}
      />,
    );
  act(() => render(draft));
  const card = container.querySelector('[data-testid="skill-draft-card"]')!;
  const button = () => card.querySelector("button")!;
  await act(async () => button().click());
  expect(button().textContent).toBe("Saved");

  const input = card.querySelector("input")!;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  type("Edited");
  act(() => render({ ...draft, status: "saved" }));

  expect(input.value).toBe("Edited");
  expect(button().textContent).toBe("Save");

  // A different skill always loads its own fields.
  act(() => render({ ...draft, skillId: "other", name: "Other" }));
  expect(card.querySelector("input")!.value).toBe("Other");

  // A second save is not undone when the first save's status arrives after it.
  await act(async () => button().click());
  type("Newer");
  await act(async () => button().click());
  act(() => render({ ...draft, skillId: "other", name: "Other", status: "saved" }));
  expect(input.value).toBe("Newer");
  expect(button().textContent).toBe("Saved");
});

const ana = { id: "user-a", name: "Ana" };
const authored: ThreadMessage = {
  id: "message",
  threadId: "thread",
  seq: 1,
  role: "user",
  author: ana,
  blocks: [{ kind: "text", text: "Book the table" }],
  createdAt: new Date().toISOString(),
};

function renderAuthored(message: ThreadMessage, meId = "user-b") {
  renderView(message.role, message.blocks, { message, meId });
  const bubble = container.querySelector<HTMLElement>('[data-testid="message-user-bubble"]');
  if (!bubble?.parentElement) throw new Error("user bubble missing");
  return { bubble, row: bubble.parentElement };
}

it("names someone else's message and keeps it on the people side", () => {
  const { bubble, row } = renderAuthored(authored);

  expect(container.textContent).toBe("AnaBook the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-muted");
  expect(bubble.className).not.toContain("bg-chat-user");
});

it("keeps my own message unnamed on the right", () => {
  const { bubble, row } = renderAuthored(authored, ana.id);

  expect(container.textContent).toBe("Book the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-chat-user");
});

it("names the person a reply quotes instead of saying You", () => {
  renderAuthored({
    ...authored,
    author: undefined,
    replyToMessageId: "parent",
    replyPreview: { role: "user", author: ana, text: "Find us a restaurant" },
  });

  expect(container.querySelector('[data-testid="reply-parent-preview"]')?.textContent).toContain(
    "Ana: Find us a restaurant",
  );
});

it("speaks the message it renders", () => {
  const onSpeak = vi.fn();
  renderView("bot", [{ kind: "text", text: "Hello" }], { onSpeak, voiceReady: true });
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Speak",
  );
  act(() => button?.click());
  expect(onSpeak).toHaveBeenCalledTimes(1);
  expect(onSpeak.mock.calls[0]?.[0]).toMatchObject({ id: "message" });
});

it("disables starting a read while a call holds the speaker, keeping stop available", () => {
  renderView("bot", [{ kind: "text", text: "Hello" }], {
    voiceReady: true,
    callHoldsSpeaker: true,
  });
  const startButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Speak this reply"]'),
  ];
  expect(startButtons().length).toBeGreaterThan(0);
  for (const button of startButtons()) expect(button.disabled).toBe(true);

  renderView("bot", [{ kind: "text", text: "Hello" }], {
    voiceReady: true,
    callHoldsSpeaker: true,
    speaking: true,
  });
  const stopButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop speaking"]'),
  ];
  expect(stopButtons().length).toBeGreaterThan(0);
  for (const button of stopButtons()) expect(button.disabled).toBe(false);
});

it("opens one counted peer line without an inline reply toggle", () => {
  const open = vi.fn();
  renderView(
    "bot",
    [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text: "Request" }],
    {
      peerExchange: {
        peerBotId: "peer",
        peerBotName: "Researcher",
        count: 3,
        direction: "sent",
      },
      onOpenPeerMessages: open,
    },
  );
  const line = container.querySelector<HTMLButtonElement>('[data-testid="peer-receipt-chip"]');
  expect(line?.getAttribute("aria-label")).toBe("3 messages with Researcher");
  expect(container.querySelector('[data-testid="peer-replies-toggle"]')).toBeNull();
  act(() => line?.click());
  expect(open).toHaveBeenCalledWith({ peerBotId: "peer", peerBotName: "Researcher" });
});

it("sends a settings Undo through the chat's space client", async () => {
  const spaceRpc = { bots: { update: vi.fn(async () => ({})) } };
  renderView(
    "bot",
    [
      {
        kind: "ask",
        text: "Settings updated",
        status: "answered",
        settingsUpdate: {
          botId: "bot-1",
          before: { modelProvider: null, modelId: null, thinkingLevel: null },
          after: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
        },
      },
    ],
    { rpc: spaceRpc as never },
  );
  const undo = [...container.querySelectorAll("button")].find((b) => b.textContent === "Undo");
  await act(async () => undo?.click());
  expect(spaceRpc.bots.update).toHaveBeenCalledTimes(1);
});

it("stops a background helper from its saved running card, never a turn's live one", () => {
  const spaceRpc = { threads: { stopHelper: vi.fn(async () => ({ ok: true })) } };
  const helper = (id: string): ThreadMessage => ({
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    botId: "bot-1",
    createdAt: new Date().toISOString(),
    blocks: [{ kind: "subagent", agentId: id, name: "scout", task: "venues", status: "running" }],
  });
  const stopButton = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
  renderView("bot", [], { message: helper("subagent:live"), rpc: spaceRpc as never });
  expect(stopButton()).toBeUndefined();
  renderView("bot", [], { message: helper("card-1"), rpc: spaceRpc as never });
  act(() => stopButton()?.click());
  expect(spaceRpc.threads.stopHelper).toHaveBeenCalledExactlyOnceWith({
    botId: "bot-1",
    messageId: "card-1",
  });
});

it("opens a saved helper's thread from its card, never a turn's live one", () => {
  const onOpenSubagent = vi.fn();
  const helper = (id: string): ThreadMessage => ({
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    botId: "bot-1",
    createdAt: new Date().toISOString(),
    blocks: [{ kind: "subagent", agentId: id, name: "scout", task: "venues", status: "completed" }],
  });
  const openButton = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Open helper thread",
    );
  renderView("bot", [], { message: helper("subagent:live"), onOpenSubagent });
  expect(openButton()).toBeUndefined();
  renderView("bot", [], { message: helper("card-1"), onOpenSubagent });
  act(() => openButton()?.click());
  expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith({
    messageId: "card-1",
    name: "scout",
    task: "venues",
    status: "completed",
    stopped: false,
  });
});

it("puts its activity panel above the reply as its own block, never inside the bubble", () => {
  renderView(
    "bot",
    [
      { kind: "thinking", durationMs: 2_000, lines: ["Checking the calendar."] },
      { kind: "steps", steps: [{ label: "Open calendar", count: 1 }], durationMs: 4_000 },
      { kind: "text", text: "Tuesday at 2 pm is free." },
    ],
    { showToolActivity: true },
  );
  const panel = container.querySelector<HTMLElement>('[data-testid="tool-activity"]');
  const bubble = container.querySelector<HTMLElement>('[data-testid="message-bot-bubble"]');
  act(() =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-trigger"]')?.click(),
  );
  expect(container.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(1);
  expect(panel).not.toBeNull();
  expect(bubble).not.toBeNull();
  // The panel stands on the page above the bubble, both in the message column.
  expect(bubble?.contains(panel!)).toBe(false);
  expect(panel?.contains(bubble!)).toBe(false);
  expect(panel?.parentElement?.contains(bubble!)).toBe(true);
  expect(container.textContent?.indexOf("Checking the calendar.")).toBeLessThan(
    container.textContent?.indexOf("Tuesday at 2 pm is free.") ?? -1,
  );
  // The bubble holds the answer alone; the reasoning is never repeated in it.
  expect(bubble?.textContent).toBe("Tuesday at 2 pm is free.");
  expect(container.querySelectorAll('[data-testid="thinking-row"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="activity-trigger"]')?.textContent).toContain(
    "Open calendar · 1 tool · 4s",
  );
});

it("draws no empty bubble under a panel when the reply has no words", () => {
  renderView(
    "bot",
    [
      { kind: "thinking", durationMs: 2_000, lines: ["Checking the calendar."] },
      { kind: "steps", steps: [{ label: "Open calendar", count: 1 }] },
      { kind: "progress", text: "   " },
    ],
    { showToolActivity: true },
  );
  expect(container.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="message-bot-bubble"]')).toHaveLength(0);
});

it("shows a reasoning-only live message as one slim activity line, not a bubble", () => {
  renderView("bot", [{ kind: "thinking", durationMs: 800, lines: ["Checking the calendar."] }], {
    showToolActivity: true,
    message: {
      id: "progress:run-1",
      threadId: "thread",
      seq: 2,
      role: "bot",
      createdAt: new Date().toISOString(),
      blocks: [{ kind: "thinking", durationMs: 800, lines: ["Checking the calendar."] }],
    },
  });
  expect(container.querySelectorAll('[data-testid="tool-activity-line"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="message-bot-bubble"]')).toHaveLength(0);
  expect(container.querySelector('[data-testid="activity-trigger"]')?.textContent).toContain(
    "Checking the calendar.",
  );
});

it("hides the activity panel when the preference is off", () => {
  renderView(
    "bot",
    [
      { kind: "thinking", durationMs: 2_000, lines: ["Checking the calendar."] },
      { kind: "steps", steps: [{ label: "Open calendar", count: 1 }] },
      { kind: "text", text: "Tuesday at 2 pm is free." },
    ],
    { showToolActivity: false },
  );
  expect(container.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(0);
  expect(container.textContent).toContain("Tuesday at 2 pm is free.");
  expect(container.textContent).not.toContain("Checking the calendar.");
});

it("puts one standalone activity panel beside a message's cards, before them", () => {
  renderView(
    "bot",
    [
      { kind: "thinking", durationMs: 1_000, lines: ["Checking the calendar."] },
      { kind: "steps", steps: [{ label: "Open calendar", count: 1 }], durationMs: 3_000 },
      { kind: "card", lines: [{ k: "When", v: "Tuesday at 2 pm" }] },
    ],
    { showToolActivity: true },
  );
  expect(container.querySelectorAll('[data-testid="tool-activity-line"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(1);
  expect(container.textContent).toContain("Tuesday at 2 pm");
  expect(container.textContent?.indexOf("Open calendar")).toBeLessThan(
    container.textContent?.indexOf("Tuesday at 2 pm") ?? -1,
  );
});
