// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The macro compiles away in the app build; tests run the source, so expand the
// plural by hand to assert the singular vs plural English forms.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
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
  ToolSteps,
} from "./ActivityPanel";

function stepsOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `step-${i}`, count: 1 }));
}

const steps = (labels: string[], durationMs?: number): MessageBlock => ({
  kind: "steps",
  steps: labels.map((label) => ({ label, count: 1 })),
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
  return { render, trigger, unmount: () => root.unmount() };
}

describe("ActivityPanel", () => {
  it("heads a finished panel with the last thing it did, its tool calls and its duration", () => {
    const html = markup([
      steps(["Open calendar", "Check conflicts"], 12_000),
      { kind: "text", text: "Tuesday at 2 pm is free." },
    ]);
    expect(visibleText(html)).toContain("Check conflicts · 2 tools · 12s");
    expect(html).toContain('data-testid="activity-trigger"');
    expect(html).toContain("border-border/50");
    expect(html).toContain("bg-card/55");
  });

  it("uses the singular for one tool and omits an unusable duration", () => {
    expect(visibleText(markup([steps(["Shell"])]))).toContain("Shell · 1 tool");
    expect(visibleText(markup([steps(["Shell"])]))).not.toMatch(/Shell · 1 tool · \d/);
  });

  it("shows the last line it reasoned and no tool suffix when it only reasoned", () => {
    const html = markup([thinking(["Checking.", "", "Weighing the second premise."])], false);
    expect(visibleText(html)).toContain("Weighing the second premise.");
    expect(visibleText(html)).not.toMatch(/Weighing the second premise\.\s*·/);
  });

  it("shows the running tool status line while a run is live", () => {
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
    expect(folded).toContain("Shell");
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

  it("lists reasoning rows in the quiet card and tool rows as monochrome lines", () => {
    const html = markup([
      thinking(["First thought.", "Second thought."]),
      steps(["Open calendar", "Check conflicts"]),
    ]);
    expect(html.match(/data-testid="thinking-row"/g)).toHaveLength(1);
    expect(visibleText(html)).toContain("Thought for 2s");
    expect(visibleText(html)).toContain("First thought.");
    expect(visibleText(html)).toContain("Second thought.");
    expect(html).toContain('data-testid="tool-rows"');
    // The reasoning card comes before the tool rows.
    expect(html.indexOf("thinking-row")).toBeLessThan(html.indexOf("tool-rows"));
    // Monochrome: no semantic success/warning colors on the rows.
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
    expect(html).toContain("text-muted-foreground");
  });

  it("marks only the call still running, with a safe pulse", () => {
    const html = markup([steps(["Open calendar", "Check conflicts"])], true);
    expect(html.match(/◷/g)).toHaveLength(1);
    expect(html).toContain("motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]");
  });

  it("renders a panel for a standalone activity-only message", () => {
    const html = renderToStaticMarkup(
      <StandaloneActivity blocks={[steps(["Shell"], 4_000)]} live={false} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toContain("Shell · 1 tool · 4s");
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

describe("ToolSteps", () => {
  it("lists only the last steps and counts the earlier ones when limited", () => {
    const all = stepsOf(LIVE_TOOL_STEP_WINDOW + 3);
    const html = renderToStaticMarkup(
      <ToolSteps steps={all} currentIndex={all.length - 1} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("+3 earlier steps");
    for (const hidden of ["step-0<", "step-1<", "step-2<"]) expect(html).not.toContain(hidden);
    for (let i = 3; i < all.length; i++) expect(html).toContain(`step-${i}<`);
    // The pulsing marker stays on the latest step after the window shifts the indexes.
    expect(html).toMatch(/◷<\/span><span[^>]*>step-8</);
    expect(html.match(/◷/g)).toHaveLength(1);
  });

  it("uses the singular for one hidden step", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW + 1)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("+1 earlier step<");
  });

  it("exposes the full label as the title of a truncated step", () => {
    const label = "Read apps/web/src/components/ActivityPanel.tsx";
    const html = renderToStaticMarkup(<ToolSteps steps={[{ label, count: 2 }]} />);
    expect(html).toContain(`title="${label}"`);
  });

  it("lists every step when not limited or when the list fits", () => {
    const all = renderToStaticMarkup(<ToolSteps steps={stepsOf(9)} />);
    const fits = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(all).not.toContain("earlier");
    expect(fits).not.toContain("earlier");
    for (let i = 0; i < 9; i++) expect(all).toContain(`step-${i}<`);
  });

  it("shows what the bot wrote before a step above it", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Read calendar", count: 1 },
          { label: "Save event", count: 1, note: "The meeting is with **Anna**." },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("✓ Read calendar The meeting is with Anna . ✓ Save event");
    expect(html).toContain("<strong>Anna</strong>");
  });
});
