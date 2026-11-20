// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/query/rpc";
import { MessageView } from "./message-view";

vi.mock("../../../lib/query/rpc", () => ({ rpc: { skills: {}, artifacts: { get: vi.fn() } } }));

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

const thinking = (line: string): ThreadMessage["blocks"][number] => ({
  kind: "thinking",
  durationMs: 1_000,
  lines: [line],
});
const steps = (label: string): ThreadMessage["blocks"][number] => ({
  kind: "steps",
  steps: [{ label, count: 1 }],
});
const text = (value: string): ThreadMessage["blocks"][number] => ({ kind: "text", text: value });

function renderView(blocks: ThreadMessage["blocks"], showToolActivity = true) {
  const message: ThreadMessage = {
    id: "message",
    threadId: "thread",
    seq: 1,
    role: "bot",
    createdAt: new Date().toISOString(),
    blocks,
  };
  const props: Partial<ComponentProps<typeof MessageView>> = { showToolActivity };
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
        peerBot={() => undefined}
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

const panels = () => container.querySelectorAll('[data-testid="tool-activity"]');
const trigger = () =>
  container.querySelector('[data-testid="activity-trigger"]')?.textContent ?? "";

it("mounts one panel for reasoning and steps wherever they appear between text", () => {
  renderView([text("First."), thinking("Mid reasoning."), text("Second."), steps("Open calendar")]);
  expect(panels()).toHaveLength(1);
  expect(trigger()).toContain("Open calendar");
  // Every text block keeps its place; the one panel stands above the reply, not between them.
  const order = container.textContent ?? "";
  expect(order.indexOf("First.")).toBeLessThan(order.indexOf("Second."));
});

it("mounts one panel when steps come before the reasoning", () => {
  renderView([steps("Open calendar"), text("Answer."), thinking("Later reasoning.")]);
  expect(panels()).toHaveLength(1);
  expect(trigger()).toContain("Later reasoning.");
});

it("mounts one panel when reasoning and steps wrap the text", () => {
  renderView([thinking("Before."), text("Answer."), steps("Check conflicts")]);
  expect(panels()).toHaveLength(1);
  expect(trigger()).toContain("Check conflicts");
  expect(container.querySelector('[data-testid="thinking-row"]')?.textContent).toContain("Before.");
});

it("hides reasoning with the activity preference and keeps the answer", () => {
  renderView([thinking("Private reasoning."), steps("Shell"), text("Answer.")], false);
  expect(panels()).toHaveLength(0);
  expect(container.textContent).not.toContain("Private reasoning.");
  expect(container.textContent).toContain("Answer.");
});

it("keeps one panel for two steps blocks instead of one per block", () => {
  renderView([steps("First step"), text("Answer."), steps("Second step")]);
  expect(panels()).toHaveLength(1);
  expect(trigger()).toContain("Second step");
});
