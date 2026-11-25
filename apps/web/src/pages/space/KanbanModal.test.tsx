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
    decide: vi.fn(),
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
  const assignee = overrides.assigneeBotId !== undefined ? overrides.assigneeBotId : "bot-1";
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
    assigneeBotId: assignee,
    ownerUserId: null,
    ownerBotId: assignee,
    workerBotIds: assignee ? [assignee] : [],
    createdByBotId: "bot-1",
    createdByUserId: "u-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    pullRequests: [],
    issues: [],
    repository: null,
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
  expect(host.querySelector('[data-testid="kanban-comment-panel"]')).not.toBeNull();
  expect(host.textContent).toContain("RAK-1");
  expect(host.textContent).toContain("Verify deploy");
});

it("links pull requests, issues and a repository through one link control", async () => {
  const ticket = makeTicket({
    id: "t-1",
    ref: "RAK-1",
    title: "Ship pull requests",
    pullRequests: [{ url: "https://example.com/owner/repo/pull/7", state: "merged" }],
  });
  api.tickets.list.mockResolvedValue({ tickets: [ticket] });
  api.tickets.update.mockResolvedValue(ticket);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target={ticket}
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

  const link = host.querySelector<HTMLAnchorElement>(
    'a[href="https://example.com/owner/repo/pull/7"]',
  );
  expect(link?.textContent).toBe("owner/repo#7Merged");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noreferrer");
  expect(host.querySelector('[data-testid="ticket-pull-requests"]')?.textContent).toContain(
    "Merged",
  );
  expect(host.querySelector('[data-testid="ticket-repository"]')).toBeNull();
  expect(host.querySelector('[data-testid="ticket-issues"]')).toBeNull();

  const openAddLink = async () => {
    const addButton = host.querySelector<HTMLButtonElement>('button[aria-label="Add link"]');
    await act(async () => addButton?.click());
  };
  const type = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Ticket link"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      host
        .querySelector('[aria-label="Ticket link"]')!
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
  };

  await openAddLink();
  await type("not a link");
  await submit();
  expect(host.textContent).toContain("Use a pull request, issue, or repository link.");
  expect(api.tickets.update).not.toHaveBeenCalled();

  await type("https://example.com/owner/repo/pull/8/files");
  await submit();
  expect(api.tickets.update).toHaveBeenLastCalledWith({
    id: "t-1",
    pullRequests: [
      { url: "https://example.com/owner/repo/pull/7" },
      { url: "https://example.com/owner/repo/pull/8" },
    ],
  });

  await openAddLink();
  await type("https://example.com/owner/repo/issues/12");
  await submit();
  expect(api.tickets.update).toHaveBeenLastCalledWith({
    id: "t-1",
    issues: [{ url: "https://example.com/owner/repo/issues/12" }],
  });

  await openAddLink();
  await type("https://example.com/acme/app/");
  await submit();
  expect(api.tickets.update).toHaveBeenLastCalledWith({
    id: "t-1",
    repository: "https://example.com/acme/app",
  });
});

it("unlinks a repository, an issue and a pull request", async () => {
  const ticket = makeTicket({
    id: "t-1",
    ref: "RAK-1",
    title: "Ship links",
    pullRequests: [{ url: "https://example.com/owner/repo/pull/7", state: "merged" }],
    issues: [{ url: "https://example.com/owner/repo/issues/12", state: "open" }],
    repository: "https://example.com/acme/app",
  });
  api.tickets.list.mockResolvedValue({ tickets: [ticket] });
  api.tickets.update.mockResolvedValue(ticket);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target={ticket}
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

  const repositorySection = host.querySelector('[data-testid="ticket-repository"]');
  expect(repositorySection?.textContent).toContain("acme/app");
  expect(
    repositorySection?.querySelector<HTMLAnchorElement>('a[href="https://example.com/acme/app"]'),
  ).not.toBeNull();
  const issuesSection = host.querySelector('[data-testid="ticket-issues"]');
  expect(issuesSection?.textContent).toContain("owner/repo#12");
  // An open issue shows no state label.
  expect(issuesSection?.textContent).toBe("owner/repo#12");

  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Unlink repository"]')?.click();
    await flush();
  });
  expect(api.tickets.update).toHaveBeenLastCalledWith({ id: "t-1", repository: null });

  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Unlink issue"]')?.click();
    await flush();
  });
  expect(api.tickets.update).toHaveBeenLastCalledWith({ id: "t-1", issues: [] });

  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Unlink pull request"]')?.click();
    await flush();
  });
  expect(api.tickets.update).toHaveBeenLastCalledWith({ id: "t-1", pullRequests: [] });
});

it("defaults new tasks to Owner=Me with the current bot as worker", async () => {
  api.tickets.list.mockResolvedValue({ tickets: [] });
  api.tickets.create.mockResolvedValue(
    makeTicket({
      id: "t-new",
      ref: "RAK-9",
      title: "Review release notes",
      ownerUserId: "u-1",
      ownerBotId: null,
      workerBotIds: ["bot-1"],
    }),
  );

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target="new"
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

  expect(
    Array.from(host.querySelectorAll("label")).map((label) => label.textContent),
  ).not.toContain("Owner");

  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Review release notes",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });

  expect(api.tickets.create).toHaveBeenCalledWith({
    title: "Review release notes",
    description: "",
    ownerUserId: "me",
    ownerBotId: null,
    workerBotIds: ["bot-1"],
    priority: "normal",
  });
});

it("renders 3-option + recommended + Other decision controls and submits both modes", async () => {
  const decision = {
    question: "Should we mirror repair bundles in R2?",
    options: [
      { id: "skip", label: "Skip repair tarballs", recommended: true },
      { id: "bundle", label: "Store .bundle copies" },
      { id: "off", label: "Disable repair check" },
    ],
  };
  const blockedTicket = makeTicket({
    id: "t-dec",
    ref: "RAK-67",
    status: "blocked",
    description: "Blocked on @user",
    decision,
  });
  api.tickets.list.mockResolvedValue({ tickets: [blockedTicket] });
  api.tickets.decide.mockResolvedValue({
    ticket: {
      ...blockedTicket,
      status: "todo",
      decision: {
        ...decision,
        answer: "Skip repair tarballs",
        answeredAt: new Date().toISOString(),
      },
    },
    comment: {
      id: "c-1",
      ticketId: "t-dec",
      body: "> Should we mirror repair bundles in R2?\n\nSkip repair tarballs",
      authorUserId: "u-1",
      authorBotId: null,
      authorName: "User",
      createdAt: new Date().toISOString(),
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target={blockedTicket}
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

  const decisionCard = host.querySelector('[data-testid="ticket-decision-card"]')!;
  expect(decisionCard).not.toBeNull();
  const commentPanel = host.querySelector('[data-testid="kanban-comment-panel"]')!;
  expect(commentPanel).not.toBeNull();
  expect(commentPanel.querySelector('textarea[aria-label="Comment"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="ticket-legacy-needs-you"]')).toBeNull();
  expect(decisionCard.textContent).toContain("Recommended");
  expect(decisionCard.textContent).toContain("Other");

  const firstOption = Array.from(decisionCard.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Skip repair tarballs"),
  )!;
  await act(async () => firstOption.click());
  await act(async () => {
    await flush();
  });
  expect(api.tickets.decide).toHaveBeenCalledWith({ ticketId: "t-dec", optionId: "skip" });

  const otherButton = Array.from(decisionCard.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Other"),
  )!;
  await act(async () => otherButton.click());
  const customInput = decisionCard.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Custom decision"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      customInput,
      "Pause backups tonight",
    );
    customInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    customInput
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  expect(api.tickets.decide).toHaveBeenCalledWith({
    ticketId: "t-dec",
    customAnswer: "Pause backups tonight",
  });
});

it("derives 3 choices (+ Recommended + Other) for legacy blocked tickets with side comment panel", async () => {
  const legacyBlocked = makeTicket({
    id: "t-legacy",
    ref: "RAK-114",
    title: "Decide R2 overage after preserving archive",
    status: "blocked",
    description:
      "Decision on R2 overage: choose keep (accept overage) or delete before next snapshot.",
  });
  api.tickets.list.mockResolvedValue({ tickets: [legacyBlocked] });
  api.tickets.decide.mockResolvedValue({
    ticket: { ...legacyBlocked, status: "todo" },
    comment: {
      id: "c-legacy",
      ticketId: "t-legacy",
      body: "Keep preserved archive (accept overage)",
      authorUserId: "u-1",
      authorBotId: null,
      authorName: "User",
      createdAt: new Date().toISOString(),
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <KanbanModal
          open
          target={legacyBlocked}
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

  const decisionCard = host.querySelector('[data-testid="ticket-decision-card"]')!;
  expect(decisionCard).not.toBeNull();
  const commentPanel = host.querySelector('[data-testid="kanban-comment-panel"]')!;
  expect(commentPanel).not.toBeNull();
  expect(commentPanel.querySelector('textarea[aria-label="Comment"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Reply to unblock");
  expect(decisionCard.textContent).toContain("Keep preserved archive (accept overage)");
  expect(decisionCard.textContent).toContain("Recommended");
  expect(decisionCard.textContent).toContain("Other");

  const firstOption = Array.from(decisionCard.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Keep preserved archive (accept overage)"),
  )!;
  await act(async () => firstOption.click());
  await act(async () => {
    await flush();
  });
  expect(api.tickets.decide).toHaveBeenCalledWith({
    ticketId: "t-legacy",
    customAnswer: "Keep preserved archive (accept overage)",
  });
});
