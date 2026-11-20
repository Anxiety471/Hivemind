import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { AppendEventInput } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import {
  createReplyState,
  flushPendingTools,
  THINKING_BLOCK_MAX_CHARS,
  THINKING_BLOCK_MAX_LINES,
  THINKING_LINE_MAX_CHARS,
  thinkingBlockLines,
} from "../lifecycle/run-progress.js";
import { consumeRunEvents } from "./run-turn.js";

async function context(options: { scripted?: boolean; trigger?: string; secrets?: string[] } = {}) {
  const appended: AppendEventInput[] = [];
  const deps = {
    prisma: {
      message: { findMany: async () => [] },
      run: {
        findUnique: async () => ({
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 1,
          checkpoint: null,
        }),
      },
    },
    events: {
      append: vi.fn(async (event: AppendEventInput) => {
        appended.push(event);
        return event;
      }),
    },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: options.trigger ?? "message",
    groupReplyOptional: false,
  };
  const reply = await createReplyState(deps as never, run as never, options.secrets ?? []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId },
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: 0 },
      computerUse: {},
      toolCallStreak: { key: undefined, count: 0 },
      toolResults: new Map(),
      overLimitActionCalls: 0,
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    secrets: options.secrets ?? [],
    scripted: options.scripted ?? false,
  } as unknown as RunContext;
  return { ctx, appended };
}

function runtimeEvents(events: AgentRuntimeEvent[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const reasoning = (lines: string[]): AgentRuntimeEvent[] => [
  { type: "thinking", active: true },
  { type: "thinking_delta", text: lines.join("\n") },
  { type: "thinking", active: false },
];

const liveThinking = (appended: AppendEventInput[]) =>
  appended.filter((event) => event.type === "thread.thinking").map((event) => event.payload);

describe("reasoning on a turn", () => {
  it("keeps the reasoning block before the answer it preceded, with its wall time", async () => {
    const { ctx, appended } = await context();
    const ended = await consumeRunEvents(
      ctx,
      runtimeEvents([
        ...reasoning(["Check the totals.", "They match."]),
        { type: "text", text: "They match." },
        { type: "done", text: "They match." },
      ]),
    );
    flushPendingTools(ctx.state.reply);

    expect(ended).toBe(false);
    expect(ctx.state.reply.messageSegments).toEqual([
      {
        kind: "thinking",
        durationMs: expect.any(Number),
        lines: ["Check the totals.", "They match."],
      },
      { kind: "text", text: "They match." },
    ]);
    const [block] = ctx.state.reply.messageSegments;
    expect(Number.isInteger(block && "durationMs" in block ? block.durationMs : undefined)).toBe(
      true,
    );
    // The live card is the same snapshot, published once it had lines and again when it ended.
    const snapshots = liveThinking(appended);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ segment: 0, lines: ["Check the totals.", "They match."] });
    expect(snapshots[1]).toMatchObject({ segment: 0, lines: ["Check the totals.", "They match."] });
    expect(snapshots.every((payload) => Number.isInteger(payload?.durationMs))).toBe(true);
  });

  it("redacts a secret inside a reasoning line in the block and in every live snapshot", async () => {
    const secret = "sk-live-123";
    const { ctx, appended } = await context({ secrets: [secret] });
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        ...reasoning([`Compare ${secret} with the key on file.`]),
        { type: "text", text: "They differ." },
        { type: "done", text: "They differ." },
      ]),
    );

    const [block] = ctx.state.reply.messageSegments;
    expect(block?.kind).toBe("thinking");
    const lines = block?.kind === "thinking" ? block.lines : [];
    expect(lines.join("\n")).toContain("[redacted]");
    expect(JSON.stringify(ctx.state.reply.messageSegments)).not.toContain(secret);
    expect(JSON.stringify(liveThinking(appended))).not.toContain(secret);
  });

  it("captures nothing for scripted, routine or background work", async () => {
    for (const options of [{ scripted: true }, { trigger: "routine" }, { trigger: "tickets" }]) {
      const { ctx, appended } = await context(options);
      await consumeRunEvents(
        ctx,
        runtimeEvents([
          ...reasoning(["A private plan."]),
          { type: "text", text: "Done." },
          { type: "done", text: "Done." },
        ]),
      );
      expect(ctx.state.reply.messageSegments.some((block) => block.kind === "thinking")).toBe(
        false,
      );
      expect(liveThinking(appended)).toEqual([]);
    }
  });

  it("keeps an empty reasoning stream out of the message", async () => {
    const { ctx, appended } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking", active: false },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    expect(ctx.state.reply.messageSegments).toEqual([]);
    expect(liveThinking(appended)).toEqual([]);
  });
});

describe("reasoning line policy", () => {
  it("keeps the first non-empty lines and drops the rest", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n\n");
    const lines = thinkingBlockLines(text);
    expect(lines).toEqual(
      Array.from({ length: THINKING_BLOCK_MAX_LINES }, (_, i) => `line ${i + 1}`),
    );
    expect(lines).not.toContain("line 9");
  });

  it("clamps a long line and stays inside the block budget", () => {
    const long = "y".repeat(2_000);
    const lines = thinkingBlockLines(Array(20).fill(long).join("\n"));
    expect(lines).toHaveLength(THINKING_BLOCK_MAX_LINES);
    for (const line of lines) {
      expect(line.length).toBe(THINKING_LINE_MAX_CHARS);
      expect(line.endsWith("…")).toBe(true);
    }
    const joined = lines.join("").length;
    expect(joined).toBeLessThanOrEqual(THINKING_BLOCK_MAX_CHARS);
    expect(THINKING_BLOCK_MAX_LINES * THINKING_LINE_MAX_CHARS).toBeLessThanOrEqual(
      THINKING_BLOCK_MAX_CHARS,
    );
  });

  it("skips blank and whitespace-only lines without spending a line", () => {
    expect(thinkingBlockLines("\n  \nfirst\n\t\nsecond\n")).toEqual(["first", "second"]);
  });
});
