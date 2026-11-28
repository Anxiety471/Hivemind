import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_RESPONSE_OPTIONAL_REMINDER_PROMPT,
  EMPTY_RESPONSE_REMINDER_PROMPT,
  SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT,
  SILENT_TOOL_CONTINUATION_PROMPT,
  UNFINISHED_WORK_CONTINUATION_PROMPT,
} from "../../runs/assembly/continuation.prompt.js";
import { UNDECIDED_ASK_CORRECTION_PROMPT } from "../../runs/assembly/final-reply-decision.prompt.js";
import type { PiPostTurnContext, PiPostTurnHook } from "./pi-post-turn-hooks.js";
import {
  createPostTurnHookRunner,
  DEFAULT_PI_POST_TURN_HOOKS,
  emptyResponseReminderHook,
  silentToolContinuationHook,
  undecidedAskCorrectionHook,
  unfinishedWorkContinuationHook,
} from "./pi-post-turn-hooks.js";

const premature = "Not checked yet: the release notes.\nNext I'll finish checking the commits.";

/** A text-only final turn with nothing else going on. */
const finalTurn = (overrides: Partial<PiPostTurnContext> = {}): PiPostTurnContext => ({
  runId: "run-1",
  turnIndex: 1,
  messageText: "Done.",
  finalTurnText: "Done.",
  streamed: true,
  hasToolCalls: false,
  hasToolResults: false,
  toolWorkPendingFinal: false,
  hasTools: true,
  allowSilentEmpty: false,
  optionalReply: false,
  pausePending: false,
  aborted: false,
  isAssistant: true,
  stopReason: "stop",
  hasProviderFailure: false,
  hadThinking: false,
  priorTriggers: 0,
  ...overrides,
});

/** A turn that ended with nothing visible at all. */
const emptyTurn = (overrides: Partial<PiPostTurnContext> = {}): PiPostTurnContext =>
  finalTurn({ messageText: "", finalTurnText: "", streamed: false, ...overrides });

/** A tool-narration turn that is still waiting for a final reply. */
const pendingSilentTurn = (overrides: Partial<PiPostTurnContext> = {}): PiPostTurnContext =>
  emptyTurn({ toolWorkPendingFinal: true, ...overrides });

describe("silentToolContinuationHook", () => {
  it("nudges a tool-narration turn that never reached a final reply", () => {
    expect(silentToolContinuationHook.evaluate(pendingSilentTurn())).toEqual({
      action: "follow_up",
      prompt: SILENT_TOOL_CONTINUATION_PROMPT,
    });
  });

  it("uses the allowed-silent prompt in a run allowed to stay silent", () => {
    expect(
      silentToolContinuationHook.evaluate(pendingSilentTurn({ allowSilentEmpty: true })),
    ).toEqual({ action: "follow_up", prompt: SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT });
  });

  it.each([
    ["no tool work is pending", emptyTurn()],
    [
      "the turn has final text",
      pendingSilentTurn({ messageText: "Here it is.", finalTurnText: "Here it is." }),
    ],
    ["the turn has tool calls", pendingSilentTurn({ hasToolCalls: true, hasToolResults: true })],
    ["the run is paused", pendingSilentTurn({ pausePending: true })],
    ["the provider failed", pendingSilentTurn({ hasProviderFailure: true })],
  ])("allows when %s", (_name, ctx) => {
    expect(silentToolContinuationHook.evaluate(ctx)).toEqual({ action: "allow" });
  });
});

describe("emptyResponseReminderHook", () => {
  it("nudges an empty assistant turn with the standard reminder", () => {
    expect(emptyResponseReminderHook.evaluate(emptyTurn())).toEqual({
      action: "follow_up",
      prompt: EMPTY_RESPONSE_REMINDER_PROMPT,
      logEvent: "agent.empty_response_reminder",
      meta: { optionalReply: false, hadThinking: false },
    });
  });

  it("uses the optional-reply reminder and reports thinking", () => {
    expect(
      emptyResponseReminderHook.evaluate(emptyTurn({ optionalReply: true, hadThinking: true })),
    ).toEqual({
      action: "follow_up",
      prompt: EMPTY_RESPONSE_OPTIONAL_REMINDER_PROMPT,
      logEvent: "agent.empty_response_reminder",
      meta: { optionalReply: true, hadThinking: true },
    });
  });

  it.each([
    ["the reply has text", emptyTurn({ messageText: "Hi", finalTurnText: "Hi" })],
    ["text was streamed", emptyTurn({ streamed: true })],
    ["the run may stay silent", emptyTurn({ allowSilentEmpty: true })],
    ["the turn was aborted", emptyTurn({ stopReason: "aborted" })],
    ["the run signal aborted", emptyTurn({ aborted: true })],
    ["the message is not an assistant's", emptyTurn({ isAssistant: false })],
    ["the provider failed", emptyTurn({ hasProviderFailure: true })],
    ["tool work is pending", pendingSilentTurn()],
    ["the turn has tool calls", emptyTurn({ hasToolCalls: true, hasToolResults: true })],
  ])("allows when %s", (_name, ctx) => {
    expect(emptyResponseReminderHook.evaluate(ctx)).toEqual({ action: "allow" });
  });
});

describe("unfinishedWorkContinuationHook", () => {
  it("nudges a final reply that admits unfinished checks, and moves the boundary", () => {
    expect(
      unfinishedWorkContinuationHook.evaluate(
        finalTurn({ messageText: premature, finalTurnText: premature }),
      ),
    ).toEqual({
      action: "follow_up",
      prompt: UNFINISHED_WORK_CONTINUATION_PROMPT,
      logEvent: "agent.unfinished_work_continuation",
      meta: { reason: expect.any(String) },
      resetPendingFinalBoundary: true,
    });
  });

  it("allows a final reply that is complete", () => {
    expect(unfinishedWorkContinuationHook.evaluate(finalTurn())).toEqual({ action: "allow" });
  });

  it.each([
    ["no tools are offered", { hasTools: false }],
    ["the run may stay silent", { allowSilentEmpty: true }],
    ["the run is optional-reply", { optionalReply: true }],
    ["the stop reason is not stop", { stopReason: "length" }],
    ["the provider failed", { hasProviderFailure: true }],
    ["the run signal aborted", { aborted: true }],
  ])("allows when %s", (_name, overrides) => {
    expect(
      unfinishedWorkContinuationHook.evaluate(
        finalTurn({ messageText: premature, finalTurnText: premature, ...overrides }),
      ),
    ).toEqual({ action: "allow" });
  });
});

describe("DEFAULT_PI_POST_TURN_HOOKS", () => {
  it("runs the built-in guards in their order", () => {
    expect(DEFAULT_PI_POST_TURN_HOOKS).toEqual([
      silentToolContinuationHook,
      emptyResponseReminderHook,
      unfinishedWorkContinuationHook,
      undecidedAskCorrectionHook,
    ]);
  });
});

describe("undecidedAskCorrectionHook", () => {
  const decision = "Decision for owner: either option A or option B?";
  const judged = (needsDecision: boolean) => {
    const judge = vi.fn(async (_reply: string) => needsDecision);
    return {
      judge,
      ctx: finalTurn({ messageText: decision, finalTurnText: decision, finalReplyJudge: judge }),
    };
  };

  it("sends the correction when the judge says the reply leaves a decision in prose", async () => {
    const { judge, ctx } = judged(true);

    expect(await undecidedAskCorrectionHook.evaluate(ctx)).toEqual({
      action: "follow_up",
      prompt: UNDECIDED_ASK_CORRECTION_PROMPT,
      logEvent: "agent.undecided_ask_correction",
      resetPendingFinalBoundary: true,
    });
    expect(judge).toHaveBeenCalledWith(decision);
  });

  it("allows when the judge says no decision is pending", async () => {
    const { ctx } = judged(false);

    expect(await undecidedAskCorrectionHook.evaluate(ctx)).toEqual({ action: "allow" });
  });

  it("allows, not fails, when the judge errors", async () => {
    const ctx = finalTurn({
      messageText: decision,
      finalTurnText: decision,
      finalReplyJudge: async () => {
        throw new Error("judge down");
      },
    });

    expect(await undecidedAskCorrectionHook.evaluate(ctx)).toEqual({ action: "allow" });
  });

  it.each([
    ["the run has no ask_user judge", { finalReplyJudge: undefined }],
    ["the reply is the exact no-response token", { messageText: "NO_RESPONSE" }],
    ["the turn has tool calls", { hasToolCalls: true }],
    ["the turn has tool results", { hasToolResults: true }],
    ["tool work is still pending", { toolWorkPendingFinal: true }],
    ["the run is paused", { pausePending: true }],
    ["the stop reason is not stop", { stopReason: "length" }],
    ["the provider failed", { hasProviderFailure: true }],
  ])("does not call the judge when %s", async (_name, overrides) => {
    const judge = vi.fn(async () => true);

    expect(
      await undecidedAskCorrectionHook.evaluate(
        finalTurn({
          messageText: decision,
          finalTurnText: decision,
          finalReplyJudge: judge,
          ...overrides,
        }),
      ),
    ).toEqual({ action: "allow" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("fires once per run", async () => {
    const judge = vi.fn(async () => true);
    const runner = createPostTurnHookRunner(DEFAULT_PI_POST_TURN_HOOKS);
    const turn = finalTurn({
      messageText: decision,
      finalTurnText: decision,
      finalReplyJudge: judge,
    });

    expect(await runner.evaluate(turn)).toMatchObject({ hookName: "undecided_ask_correction" });
    expect(await runner.evaluate(turn)).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("runs after unfinished-work: a draft with unfinished checks never reaches the judge", async () => {
    const judge = vi.fn(async () => true);
    const runner = createPostTurnHookRunner(DEFAULT_PI_POST_TURN_HOOKS);

    expect(
      await runner.evaluate(
        finalTurn({ messageText: premature, finalTurnText: premature, finalReplyJudge: judge }),
      ),
    ).toMatchObject({ hookName: "unfinished_work_continuation" });
    expect(judge).not.toHaveBeenCalled();

    expect(
      await runner.evaluate(
        finalTurn({ messageText: decision, finalTurnText: decision, finalReplyJudge: judge }),
      ),
    ).toMatchObject({
      hookName: "undecided_ask_correction",
      decision: { prompt: UNDECIDED_ASK_CORRECTION_PROMPT },
    });
    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe("createPostTurnHookRunner", () => {
  const followUp = (name: string, prompt = name): PiPostTurnHook => ({
    name,
    maxTriggers: 1,
    evaluate: () => ({ action: "follow_up", prompt }),
  });

  it("caps each hook at its maxTriggers", async () => {
    const runner = createPostTurnHookRunner([emptyResponseReminderHook]);

    expect(await runner.evaluate(finalTurn({ messageText: "", streamed: false }))).toMatchObject({
      hookName: "empty_response_reminder",
      attempt: 1,
    });
    expect(await runner.evaluate(finalTurn({ messageText: "", streamed: false }))).toBeUndefined();
    expect(runner.triggerCount("empty_response_reminder")).toBe(1);
  });

  it("clears a resetOnToolTurn hook's count on a tool turn", async () => {
    const runner = createPostTurnHookRunner([silentToolContinuationHook]);
    const pending = finalTurn({
      toolWorkPendingFinal: true,
      messageText: "",
      finalTurnText: "",
      streamed: false,
    });

    for (let i = 1; i <= 3; i += 1) {
      expect(await runner.evaluate(pending)).toMatchObject({ attempt: i });
    }
    expect(await runner.evaluate(pending)).toBeUndefined();

    runner.onToolTurn();
    expect(runner.triggerCount("silent_tool_continuation")).toBe(0);
    expect(await runner.evaluate(pending)).toMatchObject({ attempt: 1 });
  });

  it("keeps a count that does not opt into resetOnToolTurn", async () => {
    const runner = createPostTurnHookRunner([emptyResponseReminderHook]);
    await runner.evaluate(finalTurn({ messageText: "", streamed: false }));

    runner.onToolTurn();

    expect(runner.triggerCount("empty_response_reminder")).toBe(1);
  });

  it("lets the first hook that asks for a follow-up win", async () => {
    const runner = createPostTurnHookRunner([followUp("first", "one"), followUp("second", "two")]);

    expect(await runner.evaluate(finalTurn())).toMatchObject({
      hookName: "first",
      decision: { prompt: "one" },
    });
    expect(runner.triggerCount("second")).toBe(0);
    expect(await runner.evaluate(finalTurn())).toMatchObject({
      hookName: "second",
      decision: { prompt: "two" },
    });
  });

  it("passes priorTriggers to each hook", async () => {
    const seen: number[] = [];
    const counting: PiPostTurnHook = {
      name: "counting",
      maxTriggers: 2,
      evaluate: (ctx) => {
        seen.push(ctx.priorTriggers);
        return { action: "follow_up", prompt: "again" };
      },
    };
    const runner = createPostTurnHookRunner([counting]);

    await runner.evaluate(finalTurn());
    await runner.evaluate(finalTurn());
    await runner.evaluate(finalTurn());

    expect(seen).toEqual([0, 1]);
  });

  it("logs a throwing hook and moves on to the next one", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const broken: PiPostTurnHook = {
      name: "broken",
      maxTriggers: 1,
      evaluate: () => {
        throw new Error("boom");
      },
    };
    const runner = createPostTurnHookRunner([broken, followUp("after")]);

    expect(await runner.evaluate(finalTurn())).toMatchObject({ hookName: "after" });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "agent.post_turn_hook_error",
        runId: "run-1",
        hook: "broken",
      }),
    ]);
    expect(runner.triggerCount("broken")).toBe(0);
  });
});
