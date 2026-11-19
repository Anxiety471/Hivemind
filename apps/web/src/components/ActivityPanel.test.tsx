// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The macros compile away in the app build; tests run the source, so expand the
// plural by hand to assert the singular vs plural English forms.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replaceAll("#", String(value)),
}));

/** The words a reader sees, with each element's text as its own word. */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

import {
  ActivityOnlyNarration,
  ActivityPanel,
  LIVE_TOOL_STEP_WINDOW,
  StandaloneActivity,
} from "./ActivityPanel";

const steps = (
  labels: string[],
  durationMs?: number,
  notes: Record<number, string> = {},
): MessageBlock => ({
  kind: "steps",
  steps: labels.map((label, index) => ({
    label,
    count: 1,
    ...(notes[index] === undefined ? {} : { note: notes[index] }),
  })),
  ...(durationMs === undefined ? {} : { durationMs }),
});

const thinking = (lines: string[], durationMs = 2_000): MessageBlock => ({
  kind: "thinking",
  durationMs,
  lines,
});

const OPEN_TRIGGER = /aria-expanded="true"/;

function markup(blocks: MessageBlock[], live = false) {
  return renderToStaticMarkup(<ActivityPanel blocks={blocks} live={live} />);
}

function mountPanel() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (blocks: MessageBlock[], live: boolean) =>
    flushSync(() => root.render(<ActivityPanel blocks={blocks} live={live} />));
  const trigger = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { container, render, trigger, byTestId, unmount: () => root.unmount() };
}

describe("ActivityPanel", () => {
  it("summarizes a finished run by the actions it took, with its duration", () => {
    const html = markup([steps(["Web fetch", "Web fetch", "Web search"], 12_000)]);
    const text = visibleText(html);
    expect(text).toContain("read 2 pages");
    expect(text).toContain("searched the web · 12s");
    expect(html).toContain('data-testid="activity-trigger"');
    // The one rounded container holds the divided rows on the page background.
    expect(html).toContain("border-border/50");
    expect(html).toContain("bg-card/55");
    expect(html).toContain("divide-border/40");
  });

  it("says each summarized action in its singular or its counted form", () => {
    expect(visibleText(markup([steps(["Web fetch"])]))).toContain("read a page");
    expect(visibleText(markup([steps(["Read file"])]))).toContain("read a file");
    expect(visibleText(markup([steps(["Web search"])]))).toContain("searched the web");
    expect(visibleText(markup([steps(["Web search", "Web search"])]))).toContain(
      "searched the web 2 times",
    );
    expect(visibleText(markup([steps(["Shell"])]))).toContain("ran a command");
  });

  it("falls back to the last thing it did, its tool calls and its duration", () => {
    const html = markup([steps(["Open calendar", "Check conflicts"], 12_000)]);
    expect(visibleText(html)).toContain("Check conflicts · 2 tools · 12s");
  });

  it("uses the singular for one tool and omits an unusable duration", () => {
    expect(visibleText(markup([steps(["Analyze"])]))).toContain("Analyze · 1 tool");
    expect(visibleText(markup([steps(["Analyze"])]))).not.toMatch(/Analyze · 1 tool · \d/);
  });

  it("shows the latest line with its tool count while a run is live", () => {
    const html = markup(
      [{ kind: "progress", text: "Searching the web", activity: true }, steps(["Read results"])],
      true,
    );
    expect(visibleText(html)).toContain("Read results · 1 tool");
    const html2 = markup([{ kind: "progress", text: "Searching the web", activity: true }], true);
    expect(visibleText(html2)).toContain("Searching the web");
  });

  it("falls back to Working… while live and Done once finished", () => {
    expect(visibleText(markup([thinking([])], true))).toContain("Working…");
    expect(visibleText(markup([thinking([])], false))).toContain("Done");
  });

  it("starts open while working and folds when the run ends", () => {
    expect(markup([steps(["Shell"])], true)).toMatch(OPEN_TRIGGER);
    const folded = markup([steps(["Shell"], 4_000)], false);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toMatch(OPEN_TRIGGER);
  });

  it("keeps a manual collapse while more activity arrives in the same run", () => {
    const panel = mountPanel();
    panel.render([steps(["One", "Two"])], true);
    flushSync(() => panel.trigger()?.click());
    expect(panel.trigger()?.getAttribute("aria-expanded")).toBe("false");

    panel.render([steps(["One", "Two", "Three"])], true);
    expect(panel.trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(panel.trigger()?.textContent).toContain("Three");

    panel.render([steps(["One", "Two", "Three"])], false);
    expect(panel.trigger()?.getAttribute("aria-expanded")).toBe("false");
    panel.unmount();
  });

  it("lists reasoning and tool rows flat, in the order they happened", () => {
    const html = markup([
      thinking(["First thought.", "Second thought."]),
      steps(["Read file"]),
      thinking(["Third thought."], 4_000),
    ]);
    expect(html.match(/data-testid="thinking-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="activity-row"/g)).toHaveLength(1);
    expect(html.indexOf("First thought.")).toBeLessThan(html.indexOf("Read file"));
    expect(html.indexOf("Read file")).toBeLessThan(html.indexOf("Third thought."));
    // Monochrome: no semantic success/warning colors on the rows.
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
    expect(html).toContain("text-muted-foreground");
  });

  it("summarizes a reasoning segment in one line and expands its full lines", () => {
    const panel = mountPanel();
    panel.render(
      [thinking(["Checking the calendar.", "Weighing Tuesday."]), steps(["Read file"])],
      false,
    );
    // Done runs open no row beyond its summary, so the full lines wait behind the chevron.
    expect(panel.byTestId("thinking-trigger")?.getAttribute("aria-expanded")).toBe("false");
    expect(panel.byTestId("thinking-row")?.textContent).toContain("Checking the calendar.");

    flushSync(() => panel.byTestId("thinking-trigger")?.click());
    expect(panel.byTestId("thinking-trigger")?.getAttribute("aria-expanded")).toBe("true");
    expect(panel.byTestId("thinking-detail")?.textContent).toContain("Thought for 2s");
    expect(panel.byTestId("thinking-detail")?.textContent).toContain("Weighing Tuesday.");
    panel.unmount();
  });

  it("leaves a one-line thought as a plain row with nothing to expand", () => {
    const html = markup([thinking(["Checking the calendar."]), steps(["Read file"])]);
    expect(html.match(/data-testid="thinking-row"/g)).toHaveLength(1);
    expect(html).not.toContain('data-testid="thinking-trigger"');
  });

  it("opens its newest reasoning row while the run is live", () => {
    const panel = mountPanel();
    panel.render([thinking(["Checking.", "Weighing Tuesday."]), steps(["Read file"])], true);
    expect(panel.byTestId("thinking-trigger")?.getAttribute("aria-expanded")).toBe("true");
    panel.unmount();
  });

  it("folds a reasoning row once a newer thought starts in the same live run", () => {
    const panel = mountPanel();
    panel.render([thinking(["Checking.", "Weighing Tuesday."]), steps(["Read file"])], true);
    panel.render(
      [
        thinking(["Checking.", "Weighing Tuesday."]),
        steps(["Read file"]),
        thinking(["Drafting.", "Second draft thought."]),
      ],
      true,
    );
    const triggers = panel.container.querySelectorAll('[data-testid="thinking-trigger"]');
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(triggers[1]?.getAttribute("aria-expanded")).toBe("true");
    panel.unmount();
  });

  it("says what a tool call touched, underlining a URL it names", () => {
    const html = markup([
      steps(["Web fetch"], undefined, { 0: "https://bend-lang.com/ — the docs" }),
    ]);
    expect(visibleText(html)).toContain("Web fetch https://bend-lang.com/ — the docs");
    expect(html).toContain("text-foreground/85");
    expect(html).toContain("underline underline-offset-2");
  });

  it("expands a tool row to the note the bot wrote before the call", () => {
    const panel = mountPanel();
    panel.render([steps(["Web search"], undefined, { 0: "Anna is free all Tuesday." })], false);
    flushSync(() => panel.byTestId("activity-row-trigger")?.click());
    expect(panel.byTestId("tool-step-note")?.textContent).toContain("Anna is free all Tuesday.");
    panel.unmount();
  });

  it("marks only the call still running, with a safe pulse", () => {
    const html = markup([steps(["Open calendar", "Check conflicts"])], true);
    expect(html.match(/◷/g)).toHaveLength(1);
    expect(html).toContain("motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]");
  });

  it("lists only the last tool rows while live and counts the earlier ones", () => {
    const labels = Array.from({ length: LIVE_TOOL_STEP_WINDOW + 2 }, (_, i) => `step-${i}`);
    const html = markup([thinking(["Checking the calendar."]), steps(labels)], true);
    expect(html).toContain('data-testid="tool-rows-hidden"');
    expect(html).toContain("+2 earlier steps");
    // The reasoning row stays visible; only old tool rows fold away.
    expect(html).toContain("Checking the calendar.");
    for (const hidden of ["step-0", "step-1"]) expect(html).not.toContain(`${hidden}<`);
    for (let i = 2; i < labels.length; i++) expect(html).toContain(`step-${i}<`);
    // The pulsing marker stays on the latest step after the window shifts the indexes.
    expect(html).toMatch(/◷<\/span>/);
    expect(html.match(/◷/g)).toHaveLength(1);
  });

  it("uses the singular for one hidden step", () => {
    const labels = Array.from({ length: LIVE_TOOL_STEP_WINDOW + 1 }, (_, i) => `step-${i}`);
    expect(markup([steps(labels)], true)).toContain("+1 earlier step");
  });

  it("lists every row when the list fits or the run has finished", () => {
    const labels = Array.from({ length: LIVE_TOOL_STEP_WINDOW }, (_, i) => `step-${i}`);
    const live = markup([steps(labels)], true);
    expect(live).not.toContain("earlier");
    for (const label of labels) expect(live).toContain(`${label}<`);
    const doneLabels = [...labels, "step-last"];
    const done = markup([steps(doneLabels)], false);
    expect(done).not.toContain("earlier");
    for (const label of doneLabels) expect(done).toContain(`${label}<`);
  });

  it("exposes the full label as the title of a truncated row", () => {
    const label = "Read apps/web/src/components/ActivityPanel.tsx";
    const html = markup([steps([label])]);
    expect(html).toContain(`title="${label}"`);
  });

  it("renders a panel for a standalone activity-only message", () => {
    const html = renderToStaticMarkup(
      <StandaloneActivity blocks={[steps(["Shell"], 4_000)]} live={false} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toContain("ran a command · 4s");
    expect(html).not.toContain("bg-muted");
  });

  it("groups reasoning and steps into one slim line", () => {
    const html = renderToStaticMarkup(
      <ActivityOnlyNarration
        blocks={[thinking(["Checking the calendar."]), steps(["Open calendar"], 12_000)]}
        live={false}
      />,
    );
    expect(html.match(/data-testid="tool-activity-line"/g)).toHaveLength(1);
    expect(html.match(/data-testid="tool-activity"/g)).toHaveLength(1);
    expect(html.match(/data-testid="thinking-row"/g)).toHaveLength(1);
    expect(visibleText(html)).toContain("Open calendar · 1 tool · 12s");
  });
});
