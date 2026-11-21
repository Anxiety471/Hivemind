// @vitest-environment jsdom
import type { Bot, Ticket } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  boards: { subscribe: vi.fn() },
  tickets: {
    list: vi.fn(),
    move: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    comment: vi.fn(),
    comments: vi.fn(),
  },
}));

vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/locale/relative-time", () => ({ formatRelativeTime: () => "2m ago" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => (
    <div data-testid="chat-markdown">{children}</div>
  ),
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof UiWeb>();
  const Container = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...rest}>{children}</div>
  );
  return {
    ...actual,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

import { KanbanModal } from "./KanbanModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bots = [
  { id: "bot-1", name: "Scout" },
  { id: "bot-2", name: "Builder" },
] as Bot[];

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    id: "t-1",
    boardId: "board-1",
    spaceId: "space-1",
    number: 1,
    ref: "RAK-1",
    title: "Build Go task sync",
    description: "Sync tasks with Kanban",
    status: "doing",
    priority: "high",
    assigneeBotId: "bot-1",
    createdByBotId: "bot-1",
    createdByUserId: "u-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.boards.subscribe.mockReset();
  api.boards.subscribe.mockResolvedValue({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
  api.tickets.list.mockReset();
  api.tickets.comments.mockReset();
  api.tickets.comments.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("filters board columns to the active bot and opens ticket detail on click", async () => {
  const t1 = makeTicket({ id: "t-1", ref: "RAK-1", title: "Scout task", assigneeBotId: "bot-1" });
  const t2 = makeTicket({ id: "t-2", ref: "RAK-2", title: "Builder task", assigneeBotId: "bot-2" });
  api.tickets.list.mockResolvedValue({ tickets: [t1, t2] });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target="board"
          botId="bot-1"
          botName="Scout"
          bots={bots}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await flush();
  });

  expect(host.textContent).toContain("Scout task");
  expect(host.textContent).not.toContain("Builder task");

  act(() => host.querySelector<HTMLElement>('[data-testid="kanban-card-t-1"]')?.click());
  await act(async () => {
    await flush();
  });

  expect(host.querySelector('[data-testid="kanban-ticket-detail"]')).not.toBeNull();
  expect(host.textContent).toContain("Sync tasks with Kanban");
});

it("opens directly in read-first ticket detail view when targeting a ticket", async () => {
  const t1 = makeTicket({ id: "t-1", ref: "RAK-1", title: "Verify deploy" });
  api.tickets.list.mockResolvedValue({ tickets: [t1] });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal open target={t1} botId="bot-1" botName="Scout" bots={bots} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await flush();
  });

  expect(host.querySelector('[data-testid="kanban-ticket-detail"]')).not.toBeNull();
  expect(host.textContent).toContain("RAK-1");
  expect(host.textContent).toContain("Verify deploy");
});
