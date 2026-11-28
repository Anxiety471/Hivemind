// @vitest-environment jsdom

import type { AskItem } from "@rakazo/contracts";
import { formatBatchAskAnswer } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  TextInput: ({
    accessibilityLabel,
    value,
    editable,
    onChangeText,
  }: {
    accessibilityLabel?: string;
    value?: string;
    editable?: boolean;
    onChangeText?: (text: string) => void;
  }) =>
    createElement("textarea", {
      "aria-label": accessibilityLabel,
      value,
      disabled: editable === false,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({ native: {} }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    busy,
    selected,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        disabled: Boolean(disabled || busy),
        "aria-pressed": selected,
        onClick: onPress,
      },
      label,
    ),
}));

import { AskActions, AskItemsActions } from "./AskActions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("offers Always allow only when the approval card does", async () => {
  const actions = [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ];
  const show = (shown: typeof actions) =>
    act(async () =>
      root.render(<AskActions actions={shown} approval onAnswer={async () => undefined} />),
    );
  const labels = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
  await show(actions);
  expect(labels()).toEqual(["Allow once", "Always allow this tool", "Deny"]);
  await show(actions.filter((action) => action.id !== "always"));
  expect(labels()).toEqual(["Allow once", "Deny"]);
});

it("shows an option's description beneath its label", async () => {
  await act(async () =>
    root.render(
      <AskActions
        actions={[
          { id: "choice-1", label: "Publish first", description: "It stops the expiry." },
          { id: "choice-2", label: "Wait" },
        ]}
        approval={false}
        onAnswer={async () => undefined}
      />,
    ),
  );
  const texts = [...container.querySelectorAll("span")].map((item) => item.textContent);
  expect(texts).toContain("It stops the expiry.");
  expect(texts).not.toContain("Wait");
});

const shipItem: AskItem = {
  id: "ship",
  question: "Ship the release?",
  detail: "Notes are ready",
  actions: [
    { id: "yes", label: "Yes", recommended: true },
    { id: "no", label: "No" },
  ],
};
const regionItem: AskItem = {
  id: "region",
  question: "Which region?",
  actions: [
    { id: "eu", label: "Europe", description: "Lower latency for EU users" },
    { id: "us", label: "US" },
  ],
};
const buildItem: AskItem = { id: "build", question: "Build status", detail: "All checks passed" };
const batchItems: AskItem[] = [shipItem, regionItem, buildItem];

function buttonNamed(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function press(label: string) {
  await act(async () => buttonNamed(label).click());
}

it("renders a batch ask's items: choices with recommended, FYI rows, one submit", async () => {
  await act(async () =>
    root.render(
      <AskItemsActions items={batchItems} answered={false} onAnswer={async () => undefined} />,
    ),
  );
  const texts = [...container.querySelectorAll("span")].map((item) => item.textContent);
  expect(texts).toEqual(
    expect.arrayContaining([
      "Ship the release?",
      "Notes are ready",
      "Which region?",
      "Lower latency for EU users",
      "Build status",
      "All checks passed",
    ]),
  );
  const labels = [...container.querySelectorAll("button")].map((item) => item.textContent);
  expect(labels).toEqual(
    expect.arrayContaining([
      "Yes (Recommended)",
      "No",
      "Europe",
      "US",
      "Other",
      "Send answers (0/2)",
    ]),
  );
  expect(buttonNamed("Send answers (0/2)").disabled).toBe(true);
});

it("submits every answer in one call once each actionable item has a pick", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<AskItemsActions items={batchItems} answered={false} onAnswer={onAnswer} />),
  );
  await press("Yes (Recommended)");
  expect(buttonNamed("Send answers (1/2)").disabled).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  await press("Europe");
  expect(buttonNamed("Send answers (2/2)").disabled).toBe(false);
  expect(onAnswer).not.toHaveBeenCalled();
  await press("Send answers (2/2)");
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith(formatBatchAskAnswer({ ship: "yes", region: "eu" }));
});

it("accepts typed Other text as an item's answer", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <AskItemsActions
        items={[{ id: "owner", question: "Who owns it?", actions: [{ id: "me", label: "Me" }] }]}
        answered={false}
        onAnswer={onAnswer}
      />,
    ),
  );
  await press("Other");
  const field = container.querySelector("textarea");
  if (!field) throw new Error("No Other field");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(field, "  Platform team ");
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await press("Send answer");
  expect(onAnswer).toHaveBeenCalledWith(formatBatchAskAnswer({ owner: "Platform team" }));
});

it("shows each recorded answer and takes no input once answered", async () => {
  await act(async () =>
    root.render(
      <AskItemsActions
        items={[
          { ...shipItem, answer: "yes" },
          { ...regionItem, answer: "Ask the EU team first" },
          buildItem,
        ]}
        answered
        onAnswer={async () => undefined}
      />,
    ),
  );
  const texts = [...container.querySelectorAll("span")].map((item) => item.textContent);
  expect(texts).toEqual(expect.arrayContaining(["Yes", "Ask the EU team first"]));
  expect(texts).not.toContain("Yes (Recommended)");
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.querySelectorAll("textarea")).toHaveLength(0);
});
