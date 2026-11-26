// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

import { JobCard } from "./JobCard";

type JobBlock = Extract<MessageBlock, { kind: "job" }>;

const job: JobBlock = {
  kind: "job",
  jobId: "job-1",
  title: "mcp-job-card",
  agent: "pi",
  branch: "Anxiety471/mcp-job-card",
  state: "working",
  startedAt: 0,
  url: "https://code.example.test",
};

function mountCard(block: JobBlock) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<JobCard block={block} />));
  const card = () => container.querySelector<HTMLElement>('[data-testid="job-card"]');
  const text = () => card()?.textContent ?? "";
  return {
    text,
    link: () => card()?.querySelector<HTMLAnchorElement>("a")?.href,
    button: () => card()?.querySelector<HTMLButtonElement>("button"),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe("JobCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("counts a working job's elapsed time up while it runs", () => {
    const card = mountCard({ ...job, startedAt: 1_000_000 - 65_000, url: undefined });
    expect(card.text()).toContain("Working");
    expect(card.text()).toContain("1:05");
    act(() => vi.advanceTimersByTime(1_000));
    expect(card.text()).toContain("1:06");
    card.unmount();
  });

  it("labels every state the contract names", () => {
    const labels = {
      starting: "Starting",
      working: "Working",
      finished: "Finished",
      needs_input: "Needs input",
      exited: "Exited",
      timed_out: "Timed out",
    } as const;
    for (const [state, label] of Object.entries(labels)) {
      const card = mountCard({ ...job, state: state as JobBlock["state"] });
      expect(card.text()).toContain(label);
      card.unmount();
    }
  });

  it("shows a finished job's reply folded, and opens it on request", () => {
    const reply = "R".repeat(400);
    const card = mountCard({ ...job, state: "finished", reply, startedAt: undefined });
    expect(card.text()).toContain("Finished");
    expect(card.text()).not.toContain("0:00");
    expect(card.button()?.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => card.button()?.click());
    expect(card.button()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.button()?.textContent).toBe("Show less");
    card.unmount();
  });

  it("keeps a short reply without a control, and links only an https job", () => {
    const short = mountCard({ ...job, state: "finished", reply: "Done", startedAt: undefined });
    expect(short.text()).toContain("Done");
    expect(short.button()).toBeNull();
    expect(short.link()).toBe("https://code.example.test/");
    short.unmount();

    const plain = mountCard({ ...job, url: "http://127.0.0.1:3422" });
    expect(plain.link()).toBeUndefined();
    plain.unmount();
  });
});
