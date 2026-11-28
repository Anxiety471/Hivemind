// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ComposerMention } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const references = vi.hoisted(() => ({ tickets: [] as unknown[] }));
vi.mock("../chat/chat-references", () => ({
  useChatReferences: () => ({ referenceContext: { tickets: references.tickets } }),
}));

import { Composer } from "./composer";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let composerProps: ComponentProps<typeof Composer>;

const tickets = [
  {
    id: "t-418",
    ref: "TASK-418",
    title: "OAuth login fails on refresh",
    status: "doing",
    priority: "high",
    repository: null,
    decision: { question: "Which provider should sign in?" },
    pullRequests: [{ url: "https://example.com/owner/repo/pull/249", state: "open" }],
  },
  { id: "t-421", ref: "TASK-421", title: "Tune rate limits", status: "todo", priority: "low" },
  {
    id: "t-402",
    ref: "TASK-402",
    title: "Tidy sidebar spacing",
    status: "review",
    priority: "low",
  },
  { id: "t-390", ref: "TASK-390", title: "Old export job", status: "done", priority: "low" },
];

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  references.tickets = tickets;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };

function renderComposer(
  onSend: ComponentProps<typeof Composer>["onSend"] = async () => true,
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the chip-row resize animation, which jsdom cannot run.
  window.matchMedia ??= () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  composerProps = {
    activeName: "Ada",
    running: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    onOpenModels: () => {},
    onOpenConnections: () => {},
    onOpenBilling: () => {},
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => true,
    onDriveFilePick: () => true,
    onRemoveAttachment: () => {},
    onSend,
    onStop: async () => {},
    draftKey: "bot:bot-1",
    enterToSend: true,
    mentionTargets: [bob],
    ...overrides,
  };
  rerenderComposer({});
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

function rerenderComposer(overrides: Partial<ComponentProps<typeof Composer>>) {
  composerProps = { ...composerProps, ...overrides };
  act(() => root?.render(<Composer {...composerProps} />));
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(textarea: HTMLTextAreaElement, key: string) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function picker() {
  return container?.querySelector<HTMLElement>('[data-testid="reference-picker"]') ?? null;
}

function optionTexts() {
  return [...(picker()?.querySelectorAll('[role="option"]') ?? [])].map(
    (option) => option.textContent ?? "",
  );
}

describe("composer # references", () => {
  it("opens the picker with pending-decision tasks first, then open tasks, then linked pull requests", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#");
    expect(picker()).not.toBeNull();
    const options = optionTexts();
    expect(options).toHaveLength(4);
    expect(options[0]).toContain("TASK-418");
    expect(options[1]).toContain("TASK-421");
    expect(options[2]).toContain("TASK-402");
    expect(options[3]).toContain("owner/repo#249");
    expect(options.join("\n")).not.toContain("TASK-390");
    expect(options[0]).toContain("In progress");
  });

  it("filters tasks by number or words and inserts the pick on Enter", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    act(() => textarea.focus());
    type(textarea, "Fix #418");
    expect(optionTexts()[0]).toContain("TASK-418");
    pressKey(textarea, "Enter");
    expect(textarea.value).toBe("Fix TASK-418 ");
    expect(picker()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("filters by title words and inserts the pick on Tab", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#oauth");
    expect(optionTexts()[0]).toContain("TASK-418");
    pressKey(textarea, "Tab");
    expect(textarea.value).toBe("TASK-418 ");
    expect(picker()).toBeNull();
  });

  it("inserts the pick on click without taking focus from the field", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#421");
    const option = picker()?.querySelector<HTMLButtonElement>('[role="option"]');
    act(() => option?.click());
    expect(textarea.value).toBe("TASK-421 ");
    expect(picker()).toBeNull();
  });

  it("finds a linked pull request by number and inserts its repository reference", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#249");
    expect(optionTexts()).toEqual([expect.stringContaining("owner/repo#249")]);
    pressKey(textarea, "Enter");
    expect(textarea.value).toBe("owner/repo#249 ");
    expect(picker()).toBeNull();
  });

  it("dismisses the picker on Escape and keeps the typed text", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#418");
    expect(picker()).not.toBeNull();
    pressKey(textarea, "Escape");
    expect(picker()).toBeNull();
    expect(textarea.value).toBe("#418");
  });

  it("does not open for a markdown heading", () => {
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "## ");
    expect(picker()).toBeNull();
  });

  it("stays closed when the Space has no tickets", () => {
    references.tickets = [];
    const textarea = renderComposer();
    act(() => textarea.focus());
    type(textarea, "#");
    expect(picker()).toBeNull();
  });
});
