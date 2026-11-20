// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HomePanel } from "./home-panel";

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
vi.mock("../../routines/RoutineList", () => ({ routineTriggerSummary: () => "Daily" }));
vi.mock("../../space/use-board-stream", () => ({ useBotTickets: () => [] }));
vi.mock("../../../lib/chat/roster-status", () => ({ compactRosterStatusLabel: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "bot1", name: "Scout", color: "#3EC5A8", status: "idle" } as Bot;
const routine = { id: "r1", name: "Morning digest" } as unknown as Routine;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderPanel(onOpenSettings = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <HomePanel
        bot={bot}
        boardEnabled={false}
        routineList={{
          routines: [routine],
          loaded: true,
          onCreate: vi.fn(),
          onEdit: vi.fn(),
          onStop: vi.fn(),
          onToggle: vi.fn(),
        }}
        onOpenSettings={onOpenSettings}
        onClose={vi.fn()}
      />,
    ),
  );
  return onOpenSettings;
}

it("lists the bot's automations and leaves tickets out without the board", () => {
  renderPanel();
  expect(host.textContent).toContain("Morning digest");
  expect(host.textContent).not.toContain("In progress");
});

it("opens settings from the gear", () => {
  const onOpenSettings = renderPanel();
  act(() => host.querySelector<HTMLElement>('[data-testid="home-panel-settings"]')?.click());
  expect(onOpenSettings).toHaveBeenCalled();
});
