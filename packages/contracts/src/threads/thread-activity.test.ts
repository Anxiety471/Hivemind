import { describe, expect, it } from "vitest";
import {
  ProductEventSchema,
  ThreadActivityPayloadSchema,
  ThreadThinkingPayloadSchema,
} from "./events.js";
import { MessageBlock } from "./message-blocks.js";

const event = {
  id: "event-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  seq: 1,
  type: "thread.meta",
  runId: "run-1",
  createdAt: "2026-10-27T00:00:00Z",
  payload: { activity: { thinking: true } },
};
describe("coarse public thinking contract", () => {
  it("accepts only an explicit boolean and required run scope", () => {
    expect(ProductEventSchema.parse(event)).toEqual(event);
    expect(ThreadActivityPayloadSchema.parse({ activity: { thinking: false } })).toEqual({
      activity: { thinking: false },
    });
    expect(ProductEventSchema.safeParse({ ...event, runId: undefined }).success).toBe(false);
    for (const payload of [
      { activity: { thinking: "true" } },
      { activity: { thinking: true }, text: "private" },
      { activity: { thinking: true, text: "private" } },
      { activity: { thinking: true, partial: { content: "private" } } },
    ]) {
      expect(ThreadActivityPayloadSchema.safeParse(payload).success).toBe(false);
      expect(ProductEventSchema.safeParse({ ...event, payload }).success).toBe(false);
    }
  });
  it("preserves existing and unrelated metadata without imposing an activity run scope", () => {
    expect(ThreadActivityPayloadSchema.safeParse({}).success).toBe(false);
    for (const payload of [
      {},
      { notice: "stuck", state: "pending" },
      { activity: { status: "unrelated" } },
    ]) {
      expect(ProductEventSchema.parse({ ...event, runId: undefined, payload }).payload).toEqual(
        payload,
      );
    }
  });
});

describe("reasoning transcript contract", () => {
  const block = {
    kind: "thinking",
    durationMs: 1_800,
    lines: ["Checking the premise.", "Weighing the counterexample."],
  };

  it("accepts a reasoning block on its own terms", () => {
    expect(MessageBlock.parse(block)).toEqual(block);
    expect(MessageBlock.safeParse({ ...block, durationMs: 0, lines: [] }).success).toBe(true);
  });

  it("rejects unknown block kinds and malformed reasoning", () => {
    expect(MessageBlock.safeParse({ ...block, kind: "reasoning" }).success).toBe(false);
    for (const malformed of [
      { ...block, durationMs: -1 },
      { ...block, durationMs: 1.5 },
      { ...block, lines: "one line" },
      { ...block, lines: [1] },
    ]) {
      expect(MessageBlock.safeParse(malformed).success).toBe(false);
    }
  });

  it("accepts a live reasoning event only with a run and an exact payload", () => {
    const live = {
      id: "event-2",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      seq: 2,
      type: "thread.thinking",
      runId: "run-1",
      createdAt: "2026-10-27T00:00:01Z",
      payload: { segment: 0, durationMs: 250, lines: ["Checking."] },
    };
    expect(ProductEventSchema.parse(live)).toEqual(live);
    expect(ThreadThinkingPayloadSchema.parse(live.payload)).toEqual(live.payload);
    expect(ProductEventSchema.safeParse({ ...live, runId: undefined }).success).toBe(false);
    for (const payload of [
      { segment: -1, durationMs: 250, lines: [] },
      { segment: 0.5, durationMs: 250, lines: [] },
      { segment: 0, durationMs: -250, lines: [] },
      { segment: 0, durationMs: 250, lines: [null] },
      { segment: 0, durationMs: 250, lines: [], text: "private" },
      { segment: 0, durationMs: 250 },
    ]) {
      expect(ThreadThinkingPayloadSchema.safeParse(payload).success).toBe(false);
      expect(ProductEventSchema.safeParse({ ...live, payload }).success).toBe(false);
    }
  });
});
