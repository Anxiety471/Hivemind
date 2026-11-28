// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteServerReachable, resetServerReachableForTests } from "../lib/query/connection-state";
import { ReconnectingNotice } from "./ReconnectingNotice";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  resetServerReachableForTests(true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetServerReachableForTests(true);
});

async function render() {
  await act(async () => root.render(<ReconnectingNotice />));
}

describe("ReconnectingNotice", () => {
  it("stays out of the way while the server answers", async () => {
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("says it is reconnecting when a request cannot reach the server", async () => {
    await render();

    await act(async () => noteServerReachable(false));

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Reconnecting…");
  });

  it("leaves the moment the server answers again", async () => {
    await render();
    await act(async () => noteServerReachable(false));
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => noteServerReachable(true));

    expect(container.innerHTML).toBe("");
  });
});
