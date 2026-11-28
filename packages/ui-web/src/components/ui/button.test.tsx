// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Button } from "./button";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function mount(children: ReactNode, loading?: boolean) {
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Button loading={loading}>{children}</Button>));
  return container.querySelector("button")!;
}

afterEach(() => act(() => root.unmount()));

it("holds the button, with a spinner beside its label, while work is in flight", () => {
  const button = mount("Save", true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.disabled).toBe(true);
  expect(button.querySelector('[role="status"]')).not.toBeNull();
  expect(button.textContent).toBe("Save");
});

it("is an ordinary button when nothing is loading", () => {
  const button = mount("Save");
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(button.disabled).toBe(false);
  expect(button.querySelector('[role="status"]')).toBeNull();
});
