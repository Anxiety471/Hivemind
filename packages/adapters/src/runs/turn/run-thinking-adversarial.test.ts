import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { AppendEventInput } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreReply, snapshotReply } from "../assembly/reply-snapshot.js";
import type { RunContext } from "../assembly/run-context.js";
import {
  closeThinkingSegment,
  createReplyState,
  flushPendingTools,
  THINKING_BLOCK_MAX_CHARS,
  THINKING_LINE_MAX_CHARS,
  thinkingBlockLines,
} from "../lifecycle/run-progress.js";
import { consumeRunEvents } from "./run-turn.js";

async function context(options: { secrets?: string[] } = {}) {
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
    trigger: "message",
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
    scripted: false,
  } as unknown as RunContext;
  return { ctx, appended };
}

function runtimeEvents(events: AgentRuntimeEvent[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const liveThinking = (appended: AppendEventInput[]) =>
  appended.filter((event) => event.type === "thread.thinking").map((event) => event.payload);

afterEach(() => {
  vi.useRealTimers();
});

describe("reasoning segment lifecycle", () => {
  it("keeps a late delta after the end marker in the segment it belongs to", async () => {
    const { ctx } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "first half " },
        { type: "thinking", active: false },
        { type: "thinking_delta", text: "second half" },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    const thinking = ctx.state.reply.messageSegments.filter((block) => block.kind === "thinking");
    expect(thinking).toEqual([
      expect.objectContaining({ kind: "thinking", lines: ["first half second half"] }),
    ]);
  });

  it("does not open a second segment for a stray delta that opened the first", async () => {
    const { ctx, appended } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking_delta", text: "no lifecycle " },
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "markers" },
        { type: "thinking", active: false },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    flushPendingTools(ctx.state.reply);
    expect(ctx.state.reply.messageSegments).toEqual([
      expect.objectContaining({ kind: "thinking", lines: ["no lifecycle markers"] }),
      { kind: "text", text: "Done." },
    ]);
    expect(liveThinking(appended).every((payload) => payload?.segment === 0)).toBe(true);
  });
});

describe("reopening a closed reasoning segment", () => {
  it("rejoins a delta split mid-word across the end marker into one block", async () => {
    const { ctx, appended } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "hel" },
        { type: "thinking", active: false },
        { type: "thinking_delta", text: "lo" },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    expect(ctx.state.reply.messageSegments).toEqual([
      expect.objectContaining({ kind: "thinking", lines: ["hello"] }),
    ]);
    expect(liveThinking(appended).every((payload) => payload?.segment === 0)).toBe(true);
    expect(liveThinking(appended).at(-1)?.lines).toEqual(["hello"]);
  });

  it("extends the newest stream, never an earlier closed one", async () => {
    const { ctx } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "first stream." },
        { type: "thinking", active: false },
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "second stream." },
        { type: "thinking", active: false },
        { type: "thinking_delta", text: "more of the second." },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    expect(ctx.state.reply.messageSegments).toEqual([
      expect.objectContaining({ kind: "thinking", lines: ["first stream."] }),
      expect.objectContaining({
        kind: "thinking",
        lines: ["second stream.more of the second."],
      }),
    ]);
  });

  it("keeps the reopen slot out of the checkpoint snapshot", async () => {
    const { ctx } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "before the pause" },
        { type: "thinking", active: false },
      ]),
    );
    const snapshot = JSON.parse(JSON.stringify(snapshotReply(ctx.state.reply))) as Record<
      string,
      unknown
    >;
    expect("lastThinking" in snapshot).toBe(false);
    expect(snapshot.thinking).toBeUndefined();
    const fresh = await context();
    restoreReply(fresh.ctx.state.reply, snapshot, "run-1");
    await consumeRunEvents(
      fresh.ctx,
      runtimeEvents([
        { type: "thinking_delta", text: " after the resume" },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    // A restored reply has no reopen slot, so the stray delta is its own segment rather than
    // rewriting the checkpoint's committed block.
    expect(
      fresh.ctx.state.reply.messageSegments.filter((block) => block.kind === "thinking"),
    ).toHaveLength(2);
  });

  it("never lets a secret split across the end marker reach a live snapshot", async () => {
    const secret = "sk-ant-cross-close";
    const { ctx, appended } = await context({ secrets: [secret] });
    // The redactor holds back a possible match's start; the close flushes it, and the late
    // delta completes the value. Reopening must not publish the joined value.
    const half = Math.floor(secret.length / 2);
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: `key ${secret.slice(0, half)}` },
        { type: "thinking", active: false },
        { type: "thinking_delta", text: `${secret.slice(half)} done` },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    // The live payload is what reaches the DB and every thread subscriber; the durable block
    // is re-redacted when the run finishes, so this is the boundary that must hold.
    expect(JSON.stringify(liveThinking(appended))).not.toContain(secret);
  });

  it("keeps the reopened live snapshots inside the cadence and the block budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const { ctx, appended } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: "closed" },
        { type: "thinking", active: false },
      ]),
    );
    const before = liveThinking(appended).length;
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < 200; i += 1) events.push({ type: "thinking_delta", text: ` r${i}` });
    events.push({ type: "text", text: "Done." }, { type: "done", text: "Done." });
    await consumeRunEvents(ctx, runtimeEvents(events));
    const after = liveThinking(appended);
    expect(after.length - before).toBeLessThanOrEqual(2);
    expect(after.every((payload) => payload?.segment === 0)).toBe(true);
    const [block] = ctx.state.reply.messageSegments;
    const lines = block?.kind === "thinking" ? block.lines : [];
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.join("").length).toBeLessThanOrEqual(THINKING_BLOCK_MAX_CHARS);
  });
});

describe("reasoning redaction and truncation", () => {
  it("hides a secret split across deltas and clamps one huge line", async () => {
    const secret = "sk-ant-secret-value";
    const { ctx, appended } = await context({ secrets: [secret] });
    const huge = `Compare ${secret.slice(0, 7)}`;
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: huge },
        { type: "thinking_delta", text: `${secret.slice(7)} and ${"x".repeat(2_000)}` },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    const blocks = JSON.stringify(ctx.state.reply.messageSegments);
    const live = JSON.stringify(liveThinking(appended));
    for (const value of [blocks, live]) {
      expect(value).not.toContain(secret);
      expect(value).toContain("[redacted]");
    }
    const [block] = ctx.state.reply.messageSegments;
    const line = block?.kind === "thinking" ? block.lines[0] : "";
    expect(line?.length).toBe(THINKING_LINE_MAX_CHARS);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("survives one delta larger than every cap", async () => {
    const { ctx } = await context();
    await consumeRunEvents(
      ctx,
      runtimeEvents([
        { type: "thinking", active: true },
        { type: "thinking_delta", text: Array(40).fill("y".repeat(1_000)).join("\n") },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    const [block] = ctx.state.reply.messageSegments;
    const lines = block?.kind === "thinking" ? block.lines : [];
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.join("").length).toBeLessThanOrEqual(THINKING_BLOCK_MAX_CHARS);
    expect(lines.every((line) => line.length <= THINKING_LINE_MAX_CHARS)).toBe(true);
  });
});

describe("live snapshot cadence", () => {
  it("publishes at the text cadence instead of once per delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const { ctx, appended } = await context();
    const events: AgentRuntimeEvent[] = [{ type: "thinking", active: true }];
    for (let i = 0; i < 200; i += 1) events.push({ type: "thinking_delta", text: `w${i} ` });
    events.push({ type: "text", text: "Done." }, { type: "done", text: "Done." });
    await consumeRunEvents(ctx, runtimeEvents(events));
    const snapshots = liveThinking(appended);
    // One snapshot on the first delta and one on the close, not one per delta.
    expect(snapshots.length).toBeLessThanOrEqual(2);
    expect(liveThinking(appended).every((payload) => payload?.segment === 0)).toBe(true);
  });

  it("publishes again once the cadence has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
    const { ctx, appended } = await context();
    const events: AgentRuntimeEvent[] = [
      { type: "thinking", active: true },
      { type: "thinking_delta", text: "first\n" },
    ];
    await consumeRunEvents(ctx, runtimeEvents(events));
    vi.advanceTimersByTime(300);
    const gen = runtimeEvents([
      { type: "thinking_delta", text: "second\n" },
      { type: "text", text: "Done." },
      { type: "done", text: "Done." },
    ]);
    // A fresh consume keeps its own (closed) stream state; drive the same context instead.
    await consumeRunEvents(ctx, gen);
    expect(liveThinking(appended).length).toBeGreaterThanOrEqual(3);
  });
});

describe("checkpoint restore mid-segment", () => {
  it("keeps reasoning written before the checkpoint and continues it", async () => {
    const fresh = await context();
    // A checkpoint can hold a segment that was still open (the field is optional so an older
    // snapshot without it resumes with none).
    const saved = JSON.parse(
      JSON.stringify({
        ...snapshotReply(fresh.ctx.state.reply),
        thinking: {
          startedAt: Date.now() - 1_000,
          text: "before the checkpoint\n",
          lastFlushedAt: 0,
        },
      }),
    ) as Record<string, unknown>;
    restoreReply(fresh.ctx.state.reply, saved, "run-1");
    await consumeRunEvents(
      fresh.ctx,
      runtimeEvents([
        { type: "thinking_delta", text: "after the checkpoint\n" },
        { type: "text", text: "Done." },
        { type: "done", text: "Done." },
      ]),
    );
    flushPendingTools(fresh.ctx.state.reply);
    const [block] = fresh.ctx.state.reply.messageSegments;
    expect(block).toEqual(
      expect.objectContaining({
        kind: "thinking",
        lines: ["before the checkpoint", "after the checkpoint"],
      }),
    );
  });

  it("closes a restored segment on demand with a bounded block", async () => {
    const { ctx } = await context();
    ctx.state.reply.thinking = { startedAt: Date.now() - 1_000, text: "", lastFlushedAt: 0 };
    await closeThinkingSegment(ctx);
    // Nothing was written in it, so it keeps no block at all.
    expect(ctx.state.reply.messageSegments).toEqual([]);
    expect(thinkingBlockLines("a\n\nb")).toEqual(["a", "b"]);
  });
});
