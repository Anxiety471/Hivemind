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
const moveTicket = vi.hoisted(() => vi.fn(async (_input: { id: string; status: string }) => {}));

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
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({ tickets: { list: { key: () => ["tickets", "list"] } } }),
  useSave: <Input,>({
    save,
  }: {
    save: (input: Input, rpc: { tickets: { move: typeof moveTicket } }) => Promise<unknown>;
  }) => ({
    run: (input: Input) => void save(input, { tickets: { move: moveTicket } }),
    pending: false,
    error: null,
  }),
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
    pullRequests: [],
  };
  botTickets.current = [ticket];

  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });

  expect(host.querySelector('[data-testid="tasks-rail-summary"]')?.textContent).toContain("1 open");
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

it("puts tasks waiting on the user first and names the bots other blocked tasks wait on", async () => {
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
    pullRequests: [],
  };
  botTickets.current = [
    { ...base, id: "t-doing", ref: "TASK-1", title: "Active item", status: "doing" },
    {
      ...base,
      id: "t-blocked",
      ref: "TASK-2",
      title: "Waiting on review",
      status: "blocked",
      description: "Blocked on @user for approval",
    },
    {
      ...base,
      id: "t-waiting-bot",
      ref: "TASK-3",
      title: "Ship the backup fix",
      status: "blocked",
      description: "Blocked on @Eggbot for SHIP",
      mentionsMe: false,
      waitingOnBotIds: ["bot-2"],
    },
  ];
  const eggbot = { id: "bot-2", name: "Eggbot · Reviewer" } as Bot;
  activeRun.current = {
    id: "run-1",
    botId: "bot-1",
    status: "running",
    trigger: "tickets",
    promptSnippet: "Work on ticket TASK-1. Read it with ticket_get.",
  };

  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot, eggbot]} />);
  });

  expect(host.querySelector('[data-testid="tasks-rail-activity"]')?.textContent).toContain(
    "Working TASK-1",
  );
  const section = (id: string) =>
    host.querySelector(`[data-testid="tasks-rail-section-${id}"]`)?.textContent ?? "";
  expect(section("needsYou")).toContain("Waiting on review");
  expect(section("blocked")).not.toContain("Waiting on review");
  expect(section("blocked")).toContain("Waiting on Eggbot");
  expect(section("blocked")).not.toContain("TASK-3");
  expect(section("doing")).toContain("Active item");

  // Unrelated non-ticket runs without a TASK-* reference do not show the working banner.
  activeRun.current = {
    id: "run-2",
    botId: "bot-1",
    status: "running",
    trigger: "user",
    promptSnippet: "Hello there",
  };
  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot, eggbot]} />);
  });
  expect(host.querySelector('[data-testid="tasks-rail-activity"]')).toBeNull();
});

it("changes a task's status from its right-click menu", async () => {
  const ticket = {
    id: "t-1",
    boardId: "b-1",
    spaceId: "s-1",
    number: 1,
    ref: "TASK-1",
    title: "Exclude caches from backup",
    description: null,
    status: "doing",
    priority: "normal",
    assigneeBotId: "bot-1",
    ownerUserId: null,
    ownerBotId: "bot-1",
    workerBotIds: ["bot-1"],
    createdByBotId: "bot-1",
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    pullRequests: [],
  } satisfies Ticket;
  botTickets.current = [ticket];
  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });

  await act(async () => {
    host
      .querySelector('[data-testid="tasks-rail-ticket-t-1"]')
      ?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    await flush();
  });
  const done = [...document.querySelectorAll('[role="menuitemradio"]')].find(
    (item) => item.textContent === "Done",
  );
  expect(done).toBeDefined();
  await act(async () => {
    (done as HTMLElement).click();
    await flush();
  });

  expect(moveTicket).toHaveBeenCalledWith({ id: "t-1", status: "done" });
  expect(modalProps.last).toBeNull();
});

it("remembers a folded section after the rail remounts", async () => {
  botTickets.current = [
    {
      id: "t-1",
      boardId: "b-1",
      spaceId: "s-1",
      number: 1,
      ref: "TASK-1",
      title: "Planned item",
      description: null,
      status: "todo",
      priority: "normal",
      assigneeBotId: "bot-1",
      ownerUserId: null,
      ownerBotId: "bot-1",
      workerBotIds: ["bot-1"],
      createdByBotId: "bot-1",
      createdByUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      pullRequests: [],
    },
  ];
  const toggle = () =>
    host.querySelector<HTMLElement>('[data-testid="tasks-rail-section-planned"] button');
  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });
  await act(async () => {
    toggle()?.click();
    await flush();
  });
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<ConversationTasksRail bot={{ ...bot, id: "bot-9" }} bots={[bot]} />);
  });

  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  expect(localStorage.getItem("rakazo.tasksRailCollapsed")).toBe('["planned"]');
  await act(async () => {
    toggle()?.click();
    await flush();
  });
  expect(localStorage.getItem("rakazo.tasksRailCollapsed")).toBeNull();
});

it("collapses and expands the entire Tasks rail and persists the state", async () => {
  botTickets.current = [
    {
      id: "t-1",
      boardId: "b-1",
      spaceId: "s-1",
      number: 1,
      ref: "TASK-1",
      title: "Planned item",
      description: null,
      status: "todo",
      priority: "normal",
      assigneeBotId: "bot-1",
      ownerUserId: null,
      ownerBotId: "bot-1",
      workerBotIds: ["bot-1"],
      createdByBotId: "bot-1",
      createdByUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      pullRequests: [],
    },
  ];
  const rail = () => host.querySelector<HTMLElement>('[data-testid="conversation-tasks-rail"]');
  const toggle = () => host.querySelector<HTMLElement>('[data-testid="tasks-rail-toggle"]');

  await act(async () => {
    root.render(<ConversationTasksRail bot={bot} bots={[bot]} />);
  });
  expect(rail()?.getAttribute("data-collapsed")).toBe("false");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Planned item");

  await act(async () => {
    toggle()?.click();
    await flush();
  });

  expect(rail()?.getAttribute("data-collapsed")).toBe("true");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  expect(host.textContent).not.toContain("Planned item");
  expect(localStorage.getItem("rakazo.tasksRailMinimized")).toBe("1");

  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<ConversationTasksRail bot={{ ...bot, id: "bot-9" }} bots={[bot]} />);
  });
  expect(rail()?.getAttribute("data-collapsed")).toBe("true");

  await act(async () => {
    toggle()?.click();
    await flush();
  });
  expect(rail()?.getAttribute("data-collapsed")).toBe("false");
  expect(host.textContent).toContain("Planned item");
  expect(localStorage.getItem("rakazo.tasksRailMinimized")).toBeNull();
});
