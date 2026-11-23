// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineEventRow } from "./routine-event-row";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["created", 'Created routine "Morning joke"'],
  ["updated", 'Updated routine "Morning joke"'],
  ["enabled", 'Enabled routine "Morning joke"'],
  ["disabled", 'Disabled routine "Morning joke"'],
  ["deleted", 'Deleted routine "Morning joke"'],
] as const)("says what happened for %s", (change, expected) => {
  act(() =>
    root.render(
      <RoutineEventRow block={{ kind: "routine_event", change, name: "Morning joke" }} />,
    ),
  );
  expect(container.textContent).toBe(expected);
});

it("opens the routine from its row, and has nothing to open once it is deleted", () => {
  const open = vi.fn();
  act(() =>
    root.render(
      <RoutineEventRow
        block={{ kind: "routine_event", change: "created", name: "Morning joke" }}
        onOpenRoutine={open}
      />,
    ),
  );
  act(() => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(open).toHaveBeenCalledWith("Morning joke");

  act(() =>
    root.render(
      <RoutineEventRow
        block={{ kind: "routine_event", change: "deleted", name: "Morning joke" }}
        onOpenRoutine={open}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});
