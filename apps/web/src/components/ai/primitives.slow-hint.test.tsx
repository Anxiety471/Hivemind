// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerReachableForTests } from "../../lib/query/connection-state";
import { SlowHint } from "./primitives";

/** Runs the due timers and every callback they queue, as the wait would have. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    async render(pending: boolean) {
      await act(async () => root.render(<SlowHint pending={pending} delayMs={2_500} />));
    },
    async unmount() {
      await act(async () => root.unmount());
    },
  };
}

beforeEach(() => {
  resetServerReachableForTests(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetServerReachableForTests(true);
});

describe("SlowHint", () => {
  it("says nothing while a load may still be quick", async () => {
    const hint = mount();
    await hint.render(true);
    expect(hint.container.textContent).toBe("");

    await wait(2_499);
    expect(hint.container.textContent).toBe("");

    await hint.unmount();
  });

  it("shows a calm label once the wait outlasts the delay", async () => {
    const hint = mount();
    await hint.render(true);
    await wait(2_500);

    expect(hint.container.textContent).toBe("Still loading…");
    expect(hint.container.querySelector('[role="status"]')).not.toBeNull();

    await hint.unmount();
  });

  it("disappears at once when the work finishes, and stays silent for the next wait", async () => {
    const hint = mount();
    await hint.render(true);
    await wait(2_500);
    expect(hint.container.textContent).toBe("Still loading…");

    await hint.render(false);
    expect(hint.container.textContent).toBe("");

    // A new wait starts its delay again instead of reappearing at once.
    await hint.render(true);
    expect(hint.container.textContent).toBe("");
    await wait(2_500);
    expect(hint.container.textContent).toBe("Still loading…");

    await hint.unmount();
  });

  it("names the server when that is why the wait lasts", async () => {
    resetServerReachableForTests(false);
    const hint = mount();
    await hint.render(true);
    await wait(2_500);

    expect(hint.container.textContent).toBe("Reconnecting…");

    await hint.unmount();
  });
});
