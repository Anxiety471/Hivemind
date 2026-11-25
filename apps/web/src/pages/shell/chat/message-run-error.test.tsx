// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRunError } from "./message-run-error";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
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

describe("MessageRunError", () => {
  it("shows Continue when resumable is true and invokes onRetry on click", () => {
    const onRetry = vi.fn();
    act(() =>
      root.render(<MessageRunError error="503 Service Unavailable" resumable onRetry={onRetry} />),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="message-retry-button"]',
    );
    expect(button?.textContent).toContain("Continue");
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows Retry when resumable is false and disables while retrying", () => {
    const onRetry = vi.fn();
    act(() =>
      root.render(
        <MessageRunError error="Request timed out." resumable={false} retrying onRetry={onRetry} />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="message-retry-button"]',
    );
    expect(button?.textContent).toContain("Retry");
    expect(button?.disabled).toBe(true);
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toBe("Request timed out.");
  });

  it("renders group speaker header when not attached to an existing message", () => {
    act(() =>
      root.render(
        <MessageRunError
          error="502 Bad Gateway"
          onRetry={vi.fn()}
          speaker={{ botId: "bot-2", name: "Analyst", color: "#3b82f6" }}
        />,
      ),
    );
    expect(container.textContent).toContain("Analyst");
  });
});
