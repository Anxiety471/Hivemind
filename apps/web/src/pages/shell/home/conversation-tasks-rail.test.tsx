// @vitest-environment jsdom
import type { Bot, Ticket } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const botTickets = vi.hoisted(() => ({ current: [] as Ticket[] }));
const activeRun = vi.hoisted(() => ({
  current: null as {
    id: string;
    botId: string;
    status: string;
    trigger: string;
    promptSnippet?: string;
  } | null,
}));
const modalProps = vi.hoisted(() => ({
  last: null as { open: boolean; target: unknown; botId?: string } | null,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../lib/locale/relative-time", () => ({ formatRelativeTime: () => "1m ago" }));
vi.mock("../../space/use-board-stream", () => ({
  useBotTickets: () => botTickets.current,
  useBotActiveRun: () => activeRun.current,
}));
vi.mock("../../space/KanbanModal", () => ({
  KanbanModal: (props: { open: boolean; target: unknown; botId?: string }) => {
    modalProps.last = props;
    return <div data-testid="mock-kanban-modal">{String(props.open)}</div>;
  },
}));

import { ConversationTasksRail } from "./conversation-tasks-rail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "bot-1", name: "Grok Bot" } as Bot;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  botTickets.current = [];
  activeRun.current = null;
  modalProps.last = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("renders synced tasks inline beside the conversation and opens the Kanban modal on click", async () => {
  const ticket: Ticket = {
    id: "t-1",
    boardId: "b-1",
    spaceId: "s-1",
    number: 1,
    ref: "RAK-1",
    title: "Verify wake PR #151",
    description: null,
    status: "doing",
    priority: "high",
    assigneeBotId: "bot-1",
    ownerUserId: null,
    ownerBotId: "bot-1",
    workerBotIds: ["bot-1"],
    createdByBotId: "bot-1",
    createdByUserId: "u-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
  botTickets.current = [ticket];

  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });

  expect(host.querySelector('[data-testid="tasks-rail-progress"]')).not.toBeNull();
  expect(host.textContent).toContain("Verify wake PR #151");
  expect(host.textContent).toContain("RAK-1");

  await act(async () => {
    host.querySelector<HTMLElement>('[data-testid="tasks-rail-ticket-t-1"]')?.click();
    await flush();
  });

  expect(host.querySelector('[data-testid="mock-kanban-modal"]')).not.toBeNull();
  expect(modalProps.last?.target).toEqual(ticket);
});

it("opens the board modal from the header Kanban icon", async () => {
  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });

  expect(host.textContent).toContain("No tasks yet");

  await act(async () => {
    host.querySelector<HTMLElement>('[data-testid="tasks-rail-open-kanban"]')?.click();
    await flush();
  });

  expect(modalProps.last?.target).toBe("board");
});

it("shows live working status and separates Blocked from Doing", async () => {
  const base: Omit<Ticket, "id" | "ref" | "title" | "status"> = {
    boardId: "b-1",
    spaceId: "s-1",
    number: 1,
    description: null,
    priority: "normal",
    assigneeBotId: "bot-1",
    ownerUserId: null,
    ownerBotId: "bot-1",
    workerBotIds: ["bot-1"],
    createdByBotId: "bot-1",
    createdByUserId: "u-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
  botTickets.current = [
    { ...base, id: "t-doing", ref: "TASK-1", title: "Active item", status: "doing" },
    { ...base, id: "t-blocked", ref: "TASK-2", title: "Waiting on review", status: "blocked" },
  ];
  activeRun.current = {
    id: "run-1",
    botId: "bot-1",
    status: "running",
    trigger: "tickets",
    promptSnippet: "Work on ticket TASK-1. Read it with ticket_get.",
  };

  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });

  expect(host.querySelector('[data-testid="tasks-rail-activity"]')?.textContent).toContain(
    "Working TASK-1",
  );
  expect(host.textContent).toContain("Doing");
  expect(host.textContent).toContain("Blocked");

  // Unrelated non-ticket runs without a TASK-* reference do not show the working banner.
  activeRun.current = {
    id: "run-2",
    botId: "bot-1",
    status: "running",
    trigger: "user",
    promptSnippet: "Hello there",
  };
  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });
  expect(host.querySelector('[data-testid="tasks-rail-activity"]')).toBeNull();
});
