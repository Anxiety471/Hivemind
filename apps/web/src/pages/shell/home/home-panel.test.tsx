// @vitest-environment jsdom
import type { Bot, Routine, Ticket } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomePanel } from "./home-panel";

const botTickets = vi.hoisted(() => ({ current: [] as Ticket[] }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/ui-web")>()),
  BotAvatar: () => null,
}));
vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../routines/RoutineList", () => ({ routineTriggerSummary: () => "Daily" }));
vi.mock("../../space/use-board-stream", () => ({ useBotTickets: () => botTickets.current }));
vi.mock("../../../lib/chat/roster-status", () => ({ compactRosterStatusLabel: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "bot1", name: "Scout", color: "#3EC5A8", status: "idle" } as Bot;
const routine = { id: "r1", name: "Morning digest" } as unknown as Routine;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  botTickets.current = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderPanel({
  onOpenSettings = vi.fn(),
  onOpenKanban = vi.fn(),
  routines = [routine] as Routine[],
  onCreate = vi.fn(),
  boardEnabled = false,
} = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <HomePanel
        bot={bot}
        boardEnabled={boardEnabled}
        routineList={{
          routines,
          loaded: true,
          onCreate,
          onEdit: vi.fn(),
          onStop: vi.fn(),
          onToggle: vi.fn(),
        }}
        onOpenKanban={onOpenKanban}
        onOpenSettings={onOpenSettings}
        onClose={vi.fn()}
      />,
    ),
  );
  return { onOpenSettings, onOpenKanban, onCreate };
}

it("lists the bot's automations and leaves tickets out without the board", () => {
  renderPanel();
  expect(host.textContent).toContain("Morning digest");
  expect(host.textContent).not.toContain("In progress");
});

it("opens settings from the gear", () => {
  const { onOpenSettings } = renderPanel();
  act(() => host.querySelector<HTMLElement>('[data-testid="home-panel-settings"]')?.click());
  expect(onOpenSettings).toHaveBeenCalled();
});

it("offers a new routine instead of a blank panel when there is nothing to list", () => {
  const { onCreate } = renderPanel({ routines: [] });
  act(() => host.querySelector<HTMLElement>('[data-testid="home-new-routine"]')?.click());
  expect(onCreate).toHaveBeenCalled();
});

it("shows task progress and opens the Kanban modal on click", () => {
  const ticket: Ticket = {
    id: "t1",
    boardId: "b1",
    spaceId: "s1",
    number: 7,
    ref: "RAK-7",
    title: "Ship Go task detector",
    description: null,
    status: "doing",
    priority: "normal",
    assigneeBotId: "bot1",
    ownerUserId: null,
    ownerBotId: "bot1",
    workerBotIds: ["bot1"],
    createdByBotId: "bot1",
    createdByUserId: "u1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    pullRequests: [],
  };
  botTickets.current = [ticket];
  const { onOpenKanban } = renderPanel({ boardEnabled: true });

  expect(host.querySelector('[data-testid="home-task-progress"]')).not.toBeNull();
  act(() => host.querySelector<HTMLElement>('[data-testid="home-ticket"]')?.click());
  expect(onOpenKanban).toHaveBeenCalledWith(ticket);

  act(() => host.querySelector<HTMLElement>('[data-testid="home-open-kanban"]')?.click());
  expect(onOpenKanban).toHaveBeenCalledWith("board");
});
