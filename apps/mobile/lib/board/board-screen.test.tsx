// @vitest-environment jsdom

import type { Ticket } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardScreen from "../../app/board";
import { queryClient } from "../query/query";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-fixture" },
  }),
  rpc,
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => createElement("div", { role: "progressbar" }),
  Alert: { alert: vi.fn() },
  Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) =>
    visible ? createElement("div", { "data-testid": "ticket-modal" }, children) : null,
  Platform: { OS: "ios" },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  TextInput: ({
    accessibilityLabel,
    onChangeText,
  }: {
    accessibilityLabel?: string;
    onChangeText?: (value: string) => void;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../native/native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("./board-list", () => ({
  BoardList: ({
    sections,
    error,
    onRefresh,
    onSelect,
  }: {
    sections: { tickets: Ticket[] }[];
    error: string;
    onRefresh: () => Promise<void>;
    onSelect: (ticket: Ticket) => void;
  }) =>
    createElement(
      "div",
      null,
      sections.flatMap((section) =>
        section.tickets.map((ticket) =>
          createElement(
            "button",
            { key: ticket.id, type: "button", onClick: () => onSelect(ticket) },
            ticket.title,
          ),
        ),
      ),
      error,
      createElement("button", { type: "button", onClick: () => void onRefresh() }, "Refresh"),
    ),
}));

const ticket = {
  id: "ticket-1",
  title: "Example ticket",
  status: "todo",
  pullRequests: [] as Ticket["pullRequests"],
} as Ticket;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  queryClient.clear();
  rpc.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent === label);
const render = async () => {
  await act(async () => root.render(createElement(BoardScreen)));
  await act(flush);
};

it("retries a failed first load without leaving the screen", async () => {
  const retry = deferred<{ tickets: Ticket[] }>();
  rpc.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(retry.promise);
  await render();
  expect(host.textContent).toContain("Offline");
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith("tickets/list", {}, expect.anything());
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(button("Retry")).toBeUndefined();
  await act(async () => retry.resolve({ tickets: [ticket] }));
  await act(flush);
  expect(host.textContent).toContain("Example ticket");
  expect(host.textContent).not.toContain("Offline");
});

it("allows another retry after the retry fails", async () => {
  rpc
    .mockRejectedValueOnce(new Error("Offline"))
    .mockRejectedValueOnce(new Error("Still offline"))
    .mockResolvedValueOnce({ tickets: [] });
  await render();
  await act(async () => button("Retry")?.click());
  await act(flush);
  expect(host.textContent).toContain("Still offline");
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")?.click());
  await act(flush);
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(3);
});

it("keeps the empty state after a successful empty load", async () => {
  rpc.mockResolvedValueOnce({ tickets: [] });
  await render();
  expect(host.textContent).toBe("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
});

it("keeps existing tickets available when a refresh fails", async () => {
  rpc.mockResolvedValueOnce({ tickets: [ticket] }).mockRejectedValueOnce(new Error("Offline"));
  await render();
  await act(async () => button("Refresh")?.click());
  await act(flush);
  expect(host.textContent).toContain("Example ticket");
  expect(host.textContent).toContain("Offline");
  expect(button("Refresh")).toBeDefined();
  expect(button("Retry")).toBeUndefined();
});

it("opens a ticket detail sheet on tap and submits a 3-option decision", async () => {
  const decisionTicket = {
    id: "ticket-dec",
    ref: "RAK-67",
    title: "Choose backup format",
    status: "blocked",
    decision: {
      question: "Keep .git repair tarballs in R2?",
      options: [
        { id: "skip", label: "Skip tarballs", recommended: true },
        { id: "bundle", label: "Add .bundle copies", recommended: false },
        { id: "both", label: "Keep both", recommended: false },
      ],
    },
    pullRequests: [] as Ticket["pullRequests"],
  } as Ticket;
  const decidedTicket = {
    ...decisionTicket,
    status: "todo",
    decision: {
      ...decisionTicket.decision!,
      answer: "Skip tarballs",
      answeredAt: "2026-11-21T00:00:00Z",
    },
  } as Ticket;
  rpc
    .mockResolvedValueOnce({ tickets: [decisionTicket] })
    .mockResolvedValueOnce({ ticket: decidedTicket })
    .mockResolvedValue({ tickets: [decidedTicket] });
  await render();

  await act(async () => button("Choose backup format")?.click());
  expect(host.querySelector('[data-testid="ticket-modal"]')).not.toBeNull();
  expect(host.textContent).toContain("Needs your decision");
  expect(button("Skip tarballs (Recommended)")).toBeDefined();
  expect(button("Other")).toBeDefined();

  await act(async () => button("Skip tarballs (Recommended)")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith(
    "tickets/decide",
    { ticketId: "ticket-dec", optionId: "skip" },
    expect.anything(),
  );
});

it("offers 3 fallback choices (+ Recommended + Other) on legacy blocked tickets without stored decision", async () => {
  const legacyTicket = {
    id: "ticket-leg",
    ref: "RAK-130",
    title: "Fix delete-before-upload bug",
    status: "blocked",
    pullRequests: [] as Ticket["pullRequests"],
  } as Ticket;
  rpc
    .mockResolvedValueOnce({ tickets: [legacyTicket] })
    .mockResolvedValueOnce({ ticket: { ...legacyTicket, status: "todo" } })
    .mockResolvedValue({ tickets: [{ ...legacyTicket, status: "todo" }] });
  await render();

  await act(async () => button("Fix delete-before-upload bug")?.click());
  expect(button("Approve and proceed (Recommended)")).toBeDefined();
  expect(button("Other")).toBeDefined();

  await act(async () => button("Approve and proceed (Recommended)")?.click());
  await act(flush);
  expect(rpc).toHaveBeenCalledWith(
    "tickets/decide",
    { ticketId: "ticket-leg", customAnswer: "Approve and proceed" },
    expect.anything(),
  );
});
