// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

import { SubagentCard } from "./SubagentCard";

function mountCard(
  block: Parameters<typeof SubagentCard>[0]["block"],
  onStop?: () => Promise<unknown>,
  onOpen?: () => void,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<SubagentCard block={block} onStop={onStop} onOpen={onOpen} />));
  const get = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const click = () => flushSync(() => toggle()?.click());
  // The status is one icon whose accessible name is the word for it.
  const status = () =>
    container
      .querySelector('[data-testid="subagent-card"] [role="img"]')
      ?.getAttribute("aria-label");
  return {
    get,
    toggle,
    click,
    status,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

const finished = {
  kind: "subagent" as const,
  agentId: "agent-1",
  name: "writer",
  task: "A long brief",
  status: "completed" as const,
  result: "A long report",
};

describe("SubagentCard", () => {
  it.each(["running", "completed", "failed"] as const)(
    "names the %s status and animates only while running, and only for motion-safe",
    (status) => {
      const card = mountCard({ ...finished, agentId: `label-${status}`, status });
      const label =
        status === "running" ? "Running" : status === "completed" ? "Completed" : "Failed";
      expect(card.status()).toBe(label);
      const icon = card.get("subagent-card")?.querySelector("svg");
      expect(icon?.getAttribute("class")?.includes("motion-safe:animate-spin") ?? false).toBe(
        status === "running",
      );
      card.unmount();
    },
  );
  it("starts folded to one line of the task, without the result", () => {
    const card = mountCard({ ...finished, agentId: "agent-folded" });
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.textContent).toBe("A long brief");
    expect(card.get("subagent-task")?.className).toContain("line-clamp-2");
    expect(card.get("subagent-body")).toBeNull();
    expect(card.get("subagent-chevron")?.getAttribute("class")).not.toContain("rotate-180");
    card.unmount();
  });

  it("opens to the full task and result, and folds again", async () => {
    const card = mountCard({ ...finished, agentId: "agent-toggle" });
    card.click();
    expect(card.get("subagent-chevron")?.getAttribute("class")).toContain("rotate-180");
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-task")?.className).not.toContain("line-clamp-2");
    expect(card.get("subagent-task")?.className).toContain("wrap-anywhere");
    expect(card.get("subagent-body")?.textContent).toBe("A long report");

    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.className).toContain("line-clamp-2");
    await vi.waitFor(() => expect(card.get("subagent-body")).toBeNull());
    card.unmount();
  });

  it("shows progress when opened while the helper runs", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-progress",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    expect(card.status()).toBe("Running");
    expect(card.get("subagent-body")).toBeNull();
    card.click();
    expect(card.get("subagent-body")?.textContent).toBe("Reading files");
    card.unmount();
  });

  it("has no body before the helper reports anything", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-silent",
      status: "running",
      result: undefined,
    });
    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-body")).toBeNull();
    card.unmount();
  });

  it("stays open when the saved message replaces the live card", () => {
    const running = mountCard({
      ...finished,
      agentId: "agent-saved",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    running.click();
    running.unmount();

    const saved = mountCard({ ...finished, agentId: "agent-saved" });
    expect(saved.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(saved.get("subagent-body")?.textContent).toBe("A long report");
    saved.unmount();
  });

  it("offers Stop only while a background helper runs", () => {
    const onStop = vi.fn(async () => ({ ok: true }));
    const stopButton = () =>
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    const running = mountCard({ ...finished, agentId: "bg-1", status: "running" }, onStop);
    flushSync(() => stopButton()?.click());
    expect(onStop).toHaveBeenCalledOnce();
    expect(stopButton()?.disabled).toBe(true);
    running.unmount();
    for (const [block, stop] of [
      [{ ...finished, agentId: "bg-2", status: "running" as const }, undefined],
      [{ ...finished, agentId: "bg-3" }, onStop],
    ] as const) {
      const card = mountCard(block, stop);
      expect(stopButton()).toBeUndefined();
      card.unmount();
    }
  });

  it("offers Open only for a saved helper card and calls it", () => {
    const onOpen = vi.fn();
    const openButton = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === "Open helper thread",
      );
    const saved = mountCard({ ...finished, agentId: "open-1" }, undefined, onOpen);
    flushSync(() => (openButton() as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledOnce();
    saved.unmount();
    const live = mountCard({ ...finished, agentId: "open-2", status: "running" });
    expect(openButton()).toBeUndefined();
    live.unmount();
  });

  it("shows a stopped helper as stopped, not failed", () => {
    const card = mountCard({ ...finished, agentId: "bg-4", status: "failed", result: "stopped" });
    expect(card.status()).toBe("Stopped");
    expect(card.get("subagent-body")).toBeNull();
    card.unmount();
  });
});
