// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// The macro compiles away in the app build; tests run the source, so render the English text
// with the interpolated duration in place.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

import { ThinkingPanel } from "./ThinkingPanel";

function renderText(element: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  flushSync(() => root.render(element));
  const text = container.textContent ?? "";
  root.unmount();
  return text;
}

describe("ThinkingPanel", () => {
  it("leads with the formatted thinking duration", () => {
    const text = renderText(
      <ThinkingPanel durationMs={2000} lines={["Checking a premise about bears and Russians."]} />,
    );
    expect(text).toContain("Thought for 2s");
  });

  it("renders the reasoning lines in order", () => {
    const text = renderText(
      <ThinkingPanel
        durationMs={2000}
        lines={[
          "Checking a premise about bears and Russians.",
          "Weighing the bear's role as a national symbol.",
        ]}
      />,
    );
    const first = text.indexOf("Checking a premise about bears and Russians.");
    const second = text.indexOf("Weighing the bear's role as a national symbol.");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("shows nothing when the duration cannot be formatted", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => root.render(<ThinkingPanel durationMs={-1} lines={["Thinking."]} />));
    expect(container.textContent).toBe("");
    root.unmount();
  });
});
