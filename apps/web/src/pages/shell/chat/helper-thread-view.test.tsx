// @vitest-environment jsdom

import type { ProductEvent, Run, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubagentCard } from "../../../components/messages/SubagentCard";
import type { HelperThreadTarget } from "../../../lib/chat/helper-thread";
import { HelperThreadView } from "./helper-thread-view";

const threads = vi.hoisted(() => ({
  helperGet: vi.fn(),
  helperSubscribe: vi.fn(),
  stopHelper: vi.fn(),
}));
const client = vi.hoisted(() => ({ threads, artifacts: { get: vi.fn() } }));

vi.mock("../../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values);
  return { Trans: ({ children }: { children: ReactNode }) => children, useLingui: () => ({ t }) };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  LinkifiedText: ({ children }: { children: ReactNode }) => <>{children}</>,
  withBlockMentions: (blocks: unknown) => blocks,
  useLinkPrompt: () => ({ open: () => undefined }),
  useExternalLinkOpener: () => ({ open: () => undefined, dialog: null }),
}));

const peerBot = () => undefined;
const noop = () => undefined;
const noopAsync = async () => undefined;

function run(id: string, status: Run["status"]): Run {
  return {
    id,
    botId: "helper-1",
    threadId: "helper-thread",
    taskId: id,
    status,
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function message(id: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "helper-thread",
    seq: 1,
    role: "bot",
    blocks,
    botId: "helper-1",
    createdAt: new Date().toISOString(),
  };
}

function snapshot(threadId: string, messages: ThreadMessage[], runs: Run[] = []): ThreadSnapshot {
  return {
    threadId,
    cursor: 1,
    messages,
    olderCursor: null,
    botId: "helper-1",
    run: null,
    activeRuns: runs,
  };
}

function event(seq: number, type: string, payload: Record<string, unknown> = {}): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "helper-thread",
    botId: "helper-1",
    seq,
    type,
    createdAt: new Date().toISOString(),
    payload,
  } as ProductEvent;
}

/** A stream that stays open until the subscription aborts, so no reconnect loop runs. */
function stream(events: ProductEvent[]) {
  threads.helperSubscribe.mockImplementation(
    async (_input: { threadId: string }, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      return (async function* () {
        await Promise.resolve();
        for (const item of events) yield item;
        if (!signal || signal.aborted) return;
        const closed = deferred<void>();
        signal.addEventListener("abort", () => closed.resolve(), { once: true });
        await closed.promise;
      })();
    },
  );
}

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  threads.helperGet.mockReset();
  threads.helperSubscribe.mockReset();
  vi.unstubAllGlobals();
});

function Harness({ target }: { target: HelperThreadTarget }) {
  const [opened, setOpened] = useState<HelperThreadTarget | null>(null);
  return opened ? (
    <HelperThreadView
      target={opened}
      rpc={client as never}
      peerBot={peerBot}
      onOpenBot={noop}
      onOpenPeerMessages={noop}
      onOpenComputer={noop}
      onReleaseComputer={noopAsync}
      onClose={() => setOpened(null)}
    />
  ) : (
    <SubagentCard
      block={{
        kind: "subagent",
        agentId: "writer",
        name: target.name,
        task: target.task,
        status: "running",
      }}
      onOpen={() => setOpened(target)}
    />
  );
}

function mount(target: HelperThreadTarget) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness target={target} />));
  return container;
}

const writer: HelperThreadTarget = {
  messageId: "card-1",
  name: "Writer",
  task: "Research the market",
  status: "running",
  stopped: false,
};

it("opens a saved card's live thread, follows progress, and closes back to the chat", async () => {
  threads.helperGet.mockResolvedValue(
    snapshot(
      "helper-thread",
      [message("saved-1", [{ kind: "text", text: "Researching" }])],
      [run("run-1", "running")],
    ),
  );
  const finish = deferred<void>();
  threads.helperSubscribe.mockImplementation(
    async (_input: { threadId: string }, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      return (async function* () {
        yield event(2, "thread.progress", { text: "Reading files" });
        await finish.promise;
        yield { ...event(3, "run.completed"), runId: "run-1" };
        if (!signal || signal.aborted) return;
        const closed = deferred<void>();
        signal.addEventListener("abort", () => closed.resolve(), { once: true });
        await closed.promise;
      })();
    },
  );
  const container = mount(writer);

  const open = container.querySelector('button[aria-label="Open helper thread"]');
  expect(open).not.toBeNull();
  act(() => (open as HTMLButtonElement).click());

  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="helper-thread-view"]')).not.toBeNull(),
  );
  expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
    "Writer",
  );
  expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
    "Research the market",
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="helper-thread-transcript"]')?.textContent,
    ).toContain("Reading files"),
  );
  expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
    "Running",
  );
  expect(document.querySelector('[data-testid="helper-thread-view"] textarea')).toBeNull();

  finish.resolve();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
      "Completed",
    ),
  );

  const close = document.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
  act(() => close.click());
  await flush();
  expect(document.querySelector('[data-testid="helper-thread-view"]')).toBeNull();
  expect(document.querySelector('[data-testid="subagent-card"]')).not.toBeNull();
});

it("opens a helper a helper started, then goes back to the thread that showed its card", async () => {
  const nestedCard = message("card-2", [
    {
      kind: "subagent",
      agentId: "reader",
      name: "Reader",
      task: "Read the sources",
      status: "running",
    },
  ]);
  threads.helperGet.mockImplementation(async ({ messageId }: { messageId: string }) =>
    messageId === "card-2"
      ? snapshot("nested-thread", [
          message("nested-1", [{ kind: "text", text: "Nested research" }]),
        ])
      : snapshot("helper-thread", [nestedCard]),
  );
  stream([]);
  const container = mount(writer);

  act(() =>
    (
      container.querySelector('button[aria-label="Open helper thread"]') as HTMLButtonElement
    ).click(),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="helper-thread-transcript"]')?.textContent,
    ).toContain("Read the sources"),
  );

  const nestedOpen = document.querySelector(
    '[data-testid="helper-thread-transcript"] button[aria-label="Open helper thread"]',
  ) as HTMLButtonElement;
  act(() => nestedOpen.click());
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="helper-thread-transcript"]')?.textContent,
    ).toContain("Nested research"),
  );
  expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
    "Reader",
  );
  expect(threads.helperGet).toHaveBeenCalledWith({ messageId: "card-2" }, expect.anything());

  act(() => (document.querySelector('button[aria-label="Back"]') as HTMLButtonElement).click());
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="helper-thread-view"]')?.textContent).toContain(
      "Writer",
    ),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="helper-thread-transcript"]')?.textContent,
    ).toContain("Read the sources"),
  );
});
