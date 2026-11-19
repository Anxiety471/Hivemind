// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ErrorDetails } from "../lib/user-error";
import { ErrorNotice } from "./ErrorNotice";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(error: ErrorDetails, onRetry?: () => unknown) {
  await act(async () => root.render(<ErrorNotice error={error} onRetry={onRetry} />));
  const button = host.querySelector("button");
  if (!button) throw new Error("expected a retry button");
  return button;
}

it("holds the retry button until the refetch it started settles", async () => {
  const gate = deferred();
  const onRetry = vi.fn(() => gate.promise);
  const button = await render(
    { message: "Could not load artifacts.", helpUrl: undefined },
    onRetry,
  );
  expect(button.textContent).toBe("Try again");
  await act(async () => button.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => {
    gate.resolve();
    await Promise.resolve();
  });
  expect(button.disabled).toBe(false);
});

it("reports the failure without offering a retry when nothing can be refetched", async () => {
  await act(async () =>
    root.render(
      <ErrorNotice error={{ message: "Could not load credentials.", helpUrl: undefined }} />,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load credentials.");
  expect(host.querySelector("button")).toBeNull();
});
