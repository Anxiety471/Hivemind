import type { AgentRunRequest, AgentRuntimeEvent, BackgroundJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "../../computers/computer-lifecycle.js";
import { loadBotMessageContext, returnBotMessageOutcome } from "../../messaging/bot-messages.js";
import type * as ModelVisionModule from "../../models/model-vision.js";
import type * as BackgroundHelpersModule from "../../tasks/background-helpers.js";
import { returnHelperOutcome } from "../../tasks/background-helpers.js";
import { detectEmptyResponse } from "../assembly/empty-response.js";
import { DELEGATED_EMPTY_NOTICE } from "../assembly/run-replies.prompt.js";
import { createRunExecutor } from "../executor/executor.js";
import type * as RunNotificationsModule from "./run-notifications.js";
import { notifyRun } from "./run-notifications.js";
import { userProgressClientNonce } from "./user-progress.js";

vi.mock("../../computers/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  waitForRunComputerLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const vision = vi.hoisted(() => ({ seesImages: false }));
vi.mock("../../models/model-vision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVisionModule>()),
  modelAcceptsImageInput: () => vision.seesImages,
}));

vi.mock("./run-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunNotificationsModule>()),
  notifyRun: vi.fn(async () => undefined),
}));

vi.mock("../../tasks/background-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundHelpersModule>()),
  returnHelperOutcome: vi.fn(async () => undefined),
}));

vi.mock("../../messaging/bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  })),
  returnBotMessageOutcome: vi.fn(async () => undefined),
  reportBotMessageWait: vi.fn(async () => undefined),
}));

async function runTurn(
  finalText: string,
  silent = true,
  narration: string | string[] = "I will check that.",
  secrets: string[] = [],
  intent: "fyi" | "question" | "request" | "result" | "status" = "fyi",
  options: {
    trigger?: string;
    doneText?: string;
    splitText?: boolean;
    priorProgressText?: string;
    runtimeEvents?: AgentRuntimeEvent[];
    runtimeFailure?: boolean;
    /** The reply ends by asking the user, so the run pauses instead of finishing. */
    expectPause?: boolean;
    runtimeError?: Error;
    runtimeCancel?: boolean;
    failHelperId?: string;
    failMessageOnce?: boolean;
    history?: Array<{ id: string; seq: number; role: string; text: string; clientNonce?: string }>;
    /** When the run started; defaults to now, a turn too fresh for interim messages. */
    startedAt?: Date;
    /** Runs each scripted tool call through the executor, as a real runtime does. */
    executeTools?: boolean;
    /** A hand-written runtime, for orderings a flat event list can't express. */
    runtime?: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
    /** Lets a test hold an event write open, to land runtime events while it waits. */
    appendGate?: (event: AppendEventInput) => Promise<void> | undefined;
    /** The computer has a screen and a page browser, and the model can see. */
    graphical?: boolean;
    replyMode?: "chat" | "messages";
    /** The run belongs to a group chat; `optional` is whether the send named nobody. */
    group?: { optional: boolean; namedWhileRunning?: boolean };
    /** The run already put a message in the chat, such as an ask card answered by its button. */
    priorBotMessage?: boolean;
    /** A messaging run from a 1:1 chat instead of a group channel. */
    directChat?: boolean;
    /** The peer message answers a request this bot sent, so the user reads the reply. */
    repliesToRequest?: boolean;
  } = {},
) {
  vi.mocked(loadBotMessageContext).mockResolvedValue({
    kind: "bot_message_received",
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "Look again",
    intent,
    hop: 1,
    repliesToRequest: options.repliesToRequest ?? false,
  });
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? (silent ? "bot_message" : "user"),
    sourceMessageId: "source-1",
    leaseFence: 0,
    groupReplyOptional: options.group?.optional ?? false,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    // A later message that names the member reaches the run while it works.
    if (options.group?.namedWhileRunning) run.groupReplyOptional = false;
    if (options.runtime) {
      yield* options.runtime(request);
      return;
    }
    if (options.runtimeEvents) {
      for (const event of options.runtimeEvents) {
        yield event;
        if (options.executeTools && event.type === "tool") {
          await request.executeTool?.(event.name, event.args, event.executionId);
        }
      }
      if (options.runtimeCancel) {
        run.status = "cancelled";
        yield { type: "done" as const };
      }
      if (options.runtimeFailure) {
        throw options.runtimeError ?? new Error("fixture runtime failure");
      }
      return;
    }
    const narrations = Array.isArray(narration) ? narration : [narration];
    for (const [index, text] of narrations.entries()) {
      for (const chunk of options.splitText ? [...text] : [text]) {
        yield { type: "text" as const, text: chunk };
      }
      yield {
        type: "tool" as const,
        name: "read_file",
        args: {},
        executionId: `call-${index + 1}`,
      };
    }
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: options.doneText ?? narrations.join("") + finalText };
  });
  const messages: { blocks: MessageBlock[] }[] = [];
  const savedEvents: AppendEventInput[] = [];
  let failMessage = options.failMessageOnce;
  const prisma = {
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        name: "Team",
        members: [
          { bot: { id: "bot-1", name: "Assistant", description: null } },
          { bot: { id: "bot-2", name: "Other", description: null } },
        ],
      })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        replyMode: options.replyMode ?? "chat",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      update: vi.fn(async () => ({
        nextMessageSeq: messages.length + 1,
        nextEventSeq: savedEvents.length + 1,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: options.group ? "group-1" : null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
        if (
          data.type === "thread.subagent" &&
          (data.payload as { status?: string; agentId?: string }).status === "failed" &&
          (data.payload as { agentId?: string }).agentId === options.failHelperId
        )
          throw new Error("fixture settlement unavailable");
        savedEvents.push(data);
        return { ...data, seq: savedEvents.length };
      }),
    },
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => {
        if (failMessage) {
          failMessage = false;
          throw new Error("fixture message unavailable");
        }
        messages.push(data);
        return { ...data, id: `message-${messages.length}` };
      }),
      findMany: vi.fn(async ({ where }: { where: { runId?: string } }) =>
        !where.runId && options.history
          ? options.history.toReversed().map((message) => ({
              ...message,
              threadId: run.threadId,
              botId: message.role === "bot" ? run.botId : null,
              runId: null,
              blocks: [{ kind: "text", text: message.text }],
              createdAt: new Date("2026-10-24T08:00:00.000Z"),
              replyToMessageId: null,
              replyQuote: null,
              replyTo: null,
              clientNonce: message.clientNonce ?? null,
              steeringMessages: [],
            }))
          : where.runId === run.id && options.priorProgressText
            ? [
                {
                  blocks: [{ kind: "text", text: options.priorProgressText }],
                  clientNonce: userProgressClientNonce(run.id),
                },
              ]
            : [],
      ),
      findUnique: vi.fn(async () =>
        run.trigger === "messaging" && !options.directChat
          ? { blocks: [{ kind: "channel_message", channelId: "channel-1" }] }
          : null,
      ),
      findFirst: vi.fn(async ({ where }: { where?: { runId?: string; role?: string } } = {}) =>
        options.priorBotMessage && where?.runId === run.id && where.role === "bot"
          ? { id: "ask-1" }
          : null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Look again",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "fixture-model",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${data.idempotencyKey}`,
        ...data,
      })),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: `effect-${create.idempotencyKey}`,
        ...create,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const messageCount = messages.length;
      const eventCount = savedEvents.length;
      try {
        return await fn(prisma);
      } catch (error) {
        messages.length = messageCount;
        savedEvents.length = eventCount;
        throw error;
      }
    }),
  };
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[]; markUnread?: boolean }) => ({
    continuationRunId: null,
  }));
  const append = vi.fn(async (event: AppendEventInput) => {
    await options.appendGate?.(event);
    return appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event);
  });
  const pauseRunForInput = vi.fn(async () => ({ continuationRunId: null }));
  const jobs = { enqueue: vi.fn(async (_job: BackgroundJob) => undefined) };
  const messagingDelivery = {
    deliverRun: vi.fn(async (_runId: string, _options?: { progress?: boolean }) => undefined),
  };
  vision.seesImages = options.graphical ?? false;
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: options.graphical ?? false } }),
      observe: async () => ({
        frameId: "frame-1",
        width: 1,
        height: 1,
        image: new Uint8Array([0]),
      }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append, finalizeRun, pauseRunForInput, notify: vi.fn(async () => undefined) },
    jobs,
    messagingDelivery,
    secrets,
    ...(options.graphical
      ? {
          browser: {
            describe: () => ({ capabilities: { page: true } }),
            snapshot: async () => ({
              url: "https://example.test/",
              title: "Example",
              tree: "",
              elements: [],
            }),
          },
        }
      : {}),
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  if (!options.runtimeFailure && !options.expectPause)
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return {
    finalizeRun,
    append,
    pauseRunForInput,
    messages,
    savedEvents,
    prisma,
    runtimeRun,
    run,
    messagingDelivery,
  };
}

type Result = Awaited<ReturnType<typeof runTurn>>;
type RuntimeEvents = AgentRuntimeEvent[];

const done: AgentRuntimeEvent = { type: "done" };
const text = (value: string): AgentRuntimeEvent => ({ type: "text", text: value });
const thinking = (value: string): RuntimeEvents => [
  { type: "thinking", active: true },
  { type: "thinking_delta", text: value },
  { type: "thinking", active: false },
];
const tool: AgentRuntimeEvent = {
  type: "tool",
  name: "read_file",
  args: {},
  executionId: "call-1",
};
const REASONING = "Work out the reply, then answer plainly.";

let logs: LogEvent[];
let previousLogger: ReturnType<typeof getLogger>;

beforeEach(() => {
  const sink = createTestSink();
  logs = sink.events;
  previousLogger = getLogger();
  installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
  vi.mocked(notifyRun).mockClear();
  vi.mocked(returnBotMessageOutcome).mockClear();
  vi.mocked(returnHelperOutcome).mockClear();
});

afterEach(() => {
  installLogger(previousLogger);
});

/** Runs one turn over the scripted runtime events. */
function run(runtimeEvents: RuntimeEvents, options: Parameters<typeof runTurn>[5] = {}) {
  return runTurn("", false, "", [], "fyi", { runtimeEvents, ...options });
}

/** Runs one bot-to-bot turn with the given intent. */
function peer(
  intent: "fyi" | "question" | "request" | "result" | "status",
  runtimeEvents: RuntimeEvents,
  options: Parameters<typeof runTurn>[5] = {},
) {
  return runTurn("", false, "", [], intent, {
    trigger: "bot_message",
    runtimeEvents,
    ...options,
  });
}

function emptyLogs() {
  return logs.filter((event) => event.message === "run.empty_response");
}

function finalInput(result: Result) {
  return result.finalizeRun.mock.calls[0]![0] as {
    blocks: MessageBlock[];
    markUnread?: boolean;
    emptyResponse?: unknown;
    outcome: string;
  };
}

function textOf(blocks: MessageBlock[]) {
  return blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []));
}

/** The run was captured: hidden from the chat, not unread, and not notified. */
function expectCaptured(result: Result, reason: string, extra: Record<string, unknown> = {}) {
  expect(finalInput(result)).toMatchObject({
    outcome: "completed",
    blocks: [],
    markUnread: false,
    emptyResponse: expect.objectContaining({ reason, ...extra }),
  });
  expect(emptyLogs()).toHaveLength(1);
  expect(vi.mocked(notifyRun)).not.toHaveBeenCalled();
}

/** The run stayed silent on purpose: no capture, no warning. */
function expectIntentionalSilence(result: Result) {
  expect(finalInput(result)).toMatchObject({ blocks: [] });
  expect(finalInput(result).emptyResponse).toBeUndefined();
  expect(emptyLogs()).toHaveLength(0);
}

/** A real answer: visible, unread, no warning. */
function expectVisible(result: Result, visible: string) {
  expect(textOf(finalInput(result).blocks)).toEqual([visible]);
  expect(finalInput(result).markUnread).toBe(true);
  expect(finalInput(result).emptyResponse).toBeUndefined();
  expect(emptyLogs()).toHaveLength(0);
}

describe("direct user chat: empty replies are captured", () => {
  it("captures a finish that says it is empty", async () => {
    expectCaptured(await run([{ type: "done", emptyResponse: true }]), "model_empty", {
      hadThinking: false,
      thinkingChars: 0,
    });
  });

  it("captures a bare finish with no text", async () => {
    expectCaptured(await run([done]), "model_empty");
  });

  it("captures a thinking-only turn with the reasoning size, not its text", async () => {
    const result = await run([...thinking(REASONING), done]);
    expectCaptured(result, "thinking_only", {
      hadThinking: true,
      thinkingChars: REASONING.length,
    });
  });

  it("captures whitespace-only text", async () => {
    expectCaptured(await run([text("   \n\t"), done]), "model_empty");
  });

  it.each([".", "…", "\u200c", "\u200c.", "..."])("captures placeholder %j", async (value) => {
    expectCaptured(await run([text(value), done]), "placeholder_only");
  });

  it("captures the no-response fallback text alone and after reasoning", async () => {
    expectCaptured(await run([text("No response. Try again."), done]), "no_response_fallback");
    logs.length = 0;
    expectCaptured(
      await run([...thinking(REASONING), text("No response. Try again."), done]),
      "no_response_fallback",
      { hadThinking: true },
    );
  });
});

describe("direct user chat: real replies stay visible", () => {
  it("shows a normal reply, unread and notified", async () => {
    const result = await run([text("Here is the plan."), done]);
    expectVisible(result, "Here is the plan.");
    expect(vi.mocked(notifyRun)).toHaveBeenCalledTimes(1);
  });

  it.each(["OK", "✓", "42", "👍", "—"])("keeps the short reply %j", async (value) => {
    expectVisible(await run([text(value), done]), value);
  });

  it("keeps prose that quotes the fallback text", async () => {
    const quoted = 'The old build said "No response. Try again." when it had nothing.';
    expectVisible(await run([text(quoted), done]), quoted);
  });

  it("keeps a literal NO_RESPONSE on a run that must reply", async () => {
    const result = await run([text("NO_RESPONSE"), done]);
    expect(textOf(finalInput(result).blocks)).toEqual(["NO_RESPONSE"]);
    expect(emptyLogs()).toHaveLength(0);
  });

  it("keeps a turn whose only activity is tool steps", async () => {
    const result = await run([tool, done]);
    expect(finalInput(result).blocks.map((block) => block.kind)).toContain("steps");
    expect(finalInput(result).emptyResponse).toBeUndefined();
    expect(emptyLogs()).toHaveLength(0);
  });

  it("keeps a turn that asks the person a question", async () => {
    const result = await run(
      [
        {
          type: "ask",
          text: "Which should I use?",
          actions: [{ id: "choice-1", label: "Keep it" }],
        } as AgentRuntimeEvent,
      ],
      { expectPause: true },
    );
    expect(result.pauseRunForInput).toHaveBeenCalled();
    expect(emptyLogs()).toHaveLength(0);
  });

  it("keeps a turn that reports a finished subagent", async () => {
    const result = await peer("fyi", [
      {
        type: "subagent",
        agentId: "agent-1",
        name: "Researcher",
        task: "Find the number",
        status: "completed",
        result: "42",
      },
      done,
    ]);
    expect(emptyLogs()).toHaveLength(0);
    expect(finalInput(result).emptyResponse).toBeUndefined();
  });

  it("keeps narration held back until the final answer", async () => {
    const result = await runTurn(
      "",
      false,
      ["I will check that.", "The draft is posted."],
      [],
      "fyi",
      {
        trigger: "user",
      },
    );
    expect(textOf(finalInput(result).blocks).join("")).toContain("The draft is posted.");
    expect(emptyLogs()).toHaveLength(0);
  });
});

describe("group chat, unaddressed member", () => {
  const group = { optional: true };

  it("captures an empty finish without notifying", async () => {
    expectCaptured(await run([done], { group }), "model_empty");
  });

  it("captures a thinking-only finish", async () => {
    expectCaptured(await run([...thinking(REASONING), done], { group }), "thinking_only", {
      hadThinking: true,
      thinkingChars: REASONING.length,
    });
  });

  it("captures a placeholder", async () => {
    expectCaptured(await run([text("."), done], { group }), "placeholder_only");
  });

  it("stays silent on an intentional NO_RESPONSE without a warning", async () => {
    const result = await run([text("NO_RESPONSE"), done], { group });
    expectIntentionalSilence(result);
    expect(vi.mocked(notifyRun)).not.toHaveBeenCalled();
  });
});

describe("group chat, addressed member", () => {
  const group = { optional: false };

  it.each([
    { name: "an empty finish", events: [done], reason: "model_empty" },
    {
      name: "a thinking-only finish",
      events: [...thinking(REASONING), done],
      reason: "thinking_only",
    },
    { name: "a placeholder", events: [text("."), done], reason: "placeholder_only" },
  ])("captures $name instead of posting a fallback", async ({ events, reason }) => {
    const result = await run(events, { group });
    expectCaptured(result, reason);
    expect(textOf(finalInput(result).blocks)).not.toContain("done.");
    expect(textOf(finalInput(result).blocks)).not.toContain("No response. Try again.");
  });
});

describe("bot-to-bot messages", () => {
  it("captures an empty fyi without a peer return", async () => {
    const result = await peer("fyi", [done]);
    expectCaptured(result, "model_empty");
    expect(vi.mocked(returnBotMessageOutcome)).not.toHaveBeenCalled();
  });

  it("captures a thinking-only fyi", async () => {
    const result = await peer("fyi", [...thinking(REASONING), done]);
    expectCaptured(result, "thinking_only", { hadThinking: true });
    expect(vi.mocked(returnBotMessageOutcome)).not.toHaveBeenCalled();
  });

  it("stays silent on an intentional NO_RESPONSE fyi without a warning", async () => {
    const result = await peer("fyi", [text("NO_RESPONSE"), done]);
    expectIntentionalSilence(result);
  });

  it.each(["result", "status"] as const)(
    "keeps the contextual notice for an empty %s",
    async (intent) => {
      const result = await peer(intent, [done]);
      expect(textOf(finalInput(result).blocks)).toEqual([`Update from Caller: Look again`]);
      expect(emptyLogs()).toHaveLength(0);
    },
  );

  it("keeps the contextual notice for an empty reply to a request", async () => {
    const result = await peer("fyi", [done], { repliesToRequest: true });
    expect(textOf(finalInput(result).blocks)).toEqual(["Update from Caller: Look again"]);
    expect(emptyLogs()).toHaveLength(0);
  });

  it("keeps the delegated notice for an empty request reply", async () => {
    const result = await peer("request", [done]);
    expect(textOf(finalInput(result).blocks)).toEqual([DELEGATED_EMPTY_NOTICE]);
    expect(emptyLogs()).toHaveLength(0);
  });
});

describe("routines and reactions", () => {
  it.each(["routine", "reaction"])(
    "stays silent on explicit NO_RESPONSE in %s",
    async (trigger) => {
      const result = await run([text("NO_RESPONSE"), done], { trigger });
      expectIntentionalSilence(result);
    },
  );

  it.each(["routine", "reaction"])("captures an empty %s finish", async (trigger) => {
    expectCaptured(await run([done], { trigger }), "model_empty");
  });

  it("captures a routine finish that only reasoned, with no reasoning recorded", async () => {
    // Routines record no reasoning, so the capture carries no thinking count.
    expectCaptured(
      await run([...thinking(REASONING), done], { trigger: "routine" }),
      "model_empty",
      {
        hadThinking: false,
      },
    );
  });

  it("captures a reaction finish that only reasoned", async () => {
    expectCaptured(
      await run([...thinking(REASONING), done], { trigger: "reaction" }),
      "thinking_only",
      {
        hadThinking: true,
      },
    );
  });
});

describe("other triggers", () => {
  it.each([
    { name: "follow-up", options: { trigger: "follow_up" } },
    { name: "webhook", options: { trigger: "webhook" } },
    { name: "1:1 messaging", options: { trigger: "messaging", directChat: true } },
    { name: "channel messaging", options: { trigger: "messaging" } },
    { name: "helper result", options: { trigger: "helper_result" } },
    { name: "created", options: { trigger: "created" } },
    { name: "call end", options: { trigger: "call_end" } },
  ])("captures an empty $name run", async ({ options }) => {
    expectCaptured(await run([done], options), "model_empty");
  });

  it("captures an empty helper run and still settles its helper card", async () => {
    const result = await run([done], { trigger: BACKGROUND_HELPER_TRIGGER });
    expectCaptured(result, "model_empty");
    expect(vi.mocked(returnHelperOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { status: "completed", text: "" },
    );
  });
});

describe("runs that already posted or hand off their reply", () => {
  it("does not capture a turn whose mid-turn progress was already posted", async () => {
    const result = await runTurn("", true, "The draft is posted.", [], "fyi", {
      trigger: "reaction",
      priorProgressText: "The draft is posted.",
    });
    expect(emptyLogs()).toHaveLength(0);
    expect(finalInput(result).blocks).toEqual([]);
    expect(finalInput(result).emptyResponse).toBeUndefined();
  });

  it("does not capture a background ticket run", async () => {
    const result = await run([done], { trigger: "tickets" });
    expect(emptyLogs()).toHaveLength(0);
    expect(finalInput(result).blocks).toEqual([]);
  });
});

describe("captured warnings carry metadata only", () => {
  const SECRET = "sk-test-SECRET-1234";

  it("logs the run, reason and reasoning size, never the reasoning text or secrets", async () => {
    const result = await runTurn("", false, "", [SECRET], "fyi", {
      runtimeEvents: [...thinking(`Plan for ${SECRET}: keep the user's private note.`), done],
    });
    const [entry] = emptyLogs();
    expect(entry).toMatchObject({
      "run.id": "run-1",
      "space.id": "space-1",
      "thread.id": "thread-1",
      "bot.id": "bot-1",
      "run.trigger": "user",
      reason: "thinking_only",
      hadThinking: true,
    });
    expect(entry!.thinkingChars).toBeGreaterThan(0);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain(SECRET);
    expect(Object.keys(entry!).sort()).toEqual(
      expect.arrayContaining(["reason", "hadThinking", "thinkingChars"]),
    );
    expect(result.finalizeRun).toHaveBeenCalled();
  });
});

describe("detectEmptyResponse", () => {
  const base = {
    assembled: "",
    blocks: [] as MessageBlock[],
    runtimeEmptyResponse: false,
    allowSilentEmpty: false,
    groupSilentEnd: false,
    handedOff: false,
    backgroundRun: false,
    publishedMidTurnUserMessage: false,
    publishedTerminalSubagent: false,
    explicitNoResponse: false,
  };
  const reasoning = (...lines: string[]): MessageBlock => ({
    kind: "thinking",
    durationMs: 10,
    lines,
  });

  it("never captures handed-off, background, already-posted or terminal-subagent turns", () => {
    for (const override of [
      { handedOff: true },
      { backgroundRun: true },
      { publishedMidTurnUserMessage: true },
      { publishedTerminalSubagent: true },
    ]) {
      expect(detectEmptyResponse({ ...base, ...override })).toBeNull();
    }
  });

  it("never captures a turn with a contextual peer notice", () => {
    expect(
      detectEmptyResponse({ ...base, emptyResponseText: "Update from Researcher: 42" }),
    ).toBeNull();
    expect(detectEmptyResponse({ ...base, emptyResponseText: DELEGATED_EMPTY_NOTICE })).toBeNull();
  });

  it("treats a blank notice as no notice", () => {
    expect(detectEmptyResponse({ ...base, emptyResponseText: "   " })).toMatchObject({
      reason: "model_empty",
    });
  });

  it("never captures a turn with real activity or content", () => {
    for (const block of [
      { kind: "steps", steps: [{ label: "List files", count: 1 }] },
      { kind: "ask", text: "Which?", status: "pending", actions: [] },
    ] as MessageBlock[]) {
      expect(detectEmptyResponse({ ...base, blocks: [block] })).toBeNull();
    }
  });

  it("counts the reasoning in the original blocks when silence cleared them", () => {
    expect(
      detectEmptyResponse({
        ...base,
        groupSilentEnd: true,
        sourceBlocks: [reasoning("first ", "second")],
      }),
    ).toEqual({ reason: "thinking_only", hadThinking: true, thinkingChars: 12, reminders: 0 });
  });

  it("sums thinking characters across every reasoning block", () => {
    expect(
      detectEmptyResponse({
        ...base,
        blocks: [reasoning("abc", "de"), reasoning("fgh")],
      }),
    ).toEqual({ reason: "thinking_only", hadThinking: true, thinkingChars: 8, reminders: 0 });
  });

  it("keeps short valid replies and prose in must-reply turns", () => {
    for (const assembled of ["OK", "✓", "42", "👍", "—", "No response. Try again. Thanks"]) {
      expect(detectEmptyResponse({ ...base, assembled })).toBeNull();
    }
  });

  it("leaves intentional silence alone when silence is allowed", () => {
    expect(
      detectEmptyResponse({
        ...base,
        allowSilentEmpty: true,
        assembled: "NO_RESPONSE",
        explicitNoResponse: true,
      }),
    ).toBeNull();
  });

  it("classifies silent-allowed empty turns", () => {
    expect(detectEmptyResponse({ ...base, allowSilentEmpty: true })).toEqual({
      reason: "model_empty",
      hadThinking: false,
      thinkingChars: 0,
      reminders: 0,
    });
    expect(
      detectEmptyResponse({ ...base, groupSilentEnd: true, assembled: "No response. Try again." }),
    ).toMatchObject({ reason: "no_response_fallback" });
    expect(detectEmptyResponse({ ...base, allowSilentEmpty: true, assembled: "…" })).toMatchObject({
      reason: "placeholder_only",
    });
    expect(detectEmptyResponse({ ...base, allowSilentEmpty: true, assembled: "Fine." })).toBeNull();
  });

  it("treats a runtime's empty flag as empty even with text blocks present", () => {
    expect(
      detectEmptyResponse({ ...base, runtimeEmptyResponse: true, assembled: "ignored" }),
    ).toMatchObject({ reason: "model_empty" });
  });
});

describe("empty-response reminders", () => {
  it("tells the runtime whether a reply is optional, for unaddressed group members only", async () => {
    const unaddressed = await run([text("Noted."), done], { group: { optional: true } });
    expect(unaddressed.runtimeRun.mock.calls[0]![0]).toMatchObject({ optionalReply: true });
    const addressed = await run([text("Noted."), done], { group: { optional: false } });
    expect(addressed.runtimeRun.mock.calls[0]![0]).toMatchObject({ optionalReply: false });
    const direct = await run([text("Noted."), done]);
    expect(direct.runtimeRun.mock.calls[0]![0]).toMatchObject({ optionalReply: false });
  });

  it("captures an answer that is still empty after its reminder, with the reminder count", async () => {
    const result = await run([
      ...thinking(REASONING),
      { type: "done", emptyResponse: true, emptyResponseReminders: 1 },
    ]);
    expectCaptured(result, "thinking_only", { hadThinking: true, reminders: 1 });
    expect(emptyLogs()[0]!.reminders).toBe(1);
  });

  it("shows an answer the reminder produced after reasoning", async () => {
    const result = await run([
      ...thinking(REASONING),
      text("Here is the answer."),
      { type: "done", emptyResponseReminders: 1 },
    ]);
    expectVisible(result, "Here is the answer.");
  });
});
