import { getLogger } from "@rakazo/logging";
import {
  EMPTY_RESPONSE_OPTIONAL_REMINDER_PROMPT,
  EMPTY_RESPONSE_REMINDER_PROMPT,
  SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT,
  SILENT_TOOL_CONTINUATION_PROMPT,
  UNFINISHED_WORK_CONTINUATION_PROMPT,
} from "../../runs/assembly/continuation.prompt.js";
import { detectPrematureStopReason } from "../../runs/assembly/premature-stop.js";

/** Snapshot of the turn that just ended, read by post-turn hooks. */
export interface PiPostTurnContext {
  readonly runId: string;
  /** 1-based count of `turn_end` events in this run. */
  readonly turnIndex: number;
  /** Text of the completed assistant message of this turn. */
  readonly messageText: string;
  /** Final-reply text: the message text, or text streamed after the last tool turn. */
  readonly finalTurnText: string;
  /** Whether any reply text was streamed in this run (non-blank). */
  readonly streamed: boolean;
  readonly hasToolCalls: boolean;
  readonly hasToolResults: boolean;
  /** Tool work ran and no final text has arrived since. */
  readonly toolWorkPendingFinal: boolean;
  /** The run offers tools. */
  readonly hasTools: boolean;
  readonly allowSilentEmpty: boolean;
  readonly optionalReply: boolean;
  readonly pausePending: boolean;
  /** The run's abort signal fired. */
  readonly aborted: boolean;
  readonly isAssistant: boolean;
  /** Stop reason of the completed assistant message. */
  readonly stopReason: string | undefined;
  readonly hasProviderFailure: boolean;
  readonly hadThinking: boolean;
  /** Triggers this hook already fired in the run. */
  readonly priorTriggers: number;
}

export type PiPostTurnDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "follow_up";
      readonly prompt: string;
      readonly logEvent?: string;
      readonly meta?: Record<string, unknown>;
      /** Move the final-reply boundary to the end of what is streamed so far. */
      readonly resetPendingFinalBoundary?: boolean;
    };

/**
 * Synchronous on purpose: `turn_end` listeners are awaited, but the agent loop checks its
 * follow-up queue right after them, so a follow-up must be queued before `evaluate` returns.
 */
export interface PiPostTurnHook {
  readonly name: string;
  /** Most follow-ups this hook may request in one run. */
  readonly maxTriggers: number;
  /** Clear this hook's trigger count when a tool turn runs. */
  readonly resetOnToolTurn?: boolean;
  evaluate(ctx: PiPostTurnContext): PiPostTurnDecision;
}

const ALLOW: PiPostTurnDecision = { action: "allow" };

// Some OpenAI-compatible models return EOS immediately after a tool result
// instead of taking another assistant turn. A bounded internal follow-up keeps
// that provider quirk from making a long task look complete after one step.
export const silentToolContinuationHook: PiPostTurnHook = {
  name: "silent_tool_continuation",
  maxTriggers: 3,
  resetOnToolTurn: true,
  evaluate(ctx) {
    if (
      !ctx.toolWorkPendingFinal ||
      ctx.hasToolCalls ||
      ctx.hasToolResults ||
      ctx.finalTurnText ||
      ctx.pausePending ||
      // A provider failure is not an empty success. Do not schedule
      // another model turn that would hide the error.
      ctx.hasProviderFailure
    ) {
      return ALLOW;
    }
    return {
      action: "follow_up",
      prompt: ctx.allowSilentEmpty
        ? SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT
        : SILENT_TOOL_CONTINUATION_PROMPT,
    };
  },
};

// One bounded nudge for a turn that ended with nothing visible, after the stream's own retries.
export const emptyResponseReminderHook: PiPostTurnHook = {
  name: "empty_response_reminder",
  maxTriggers: 1,
  evaluate(ctx) {
    if (
      ctx.toolWorkPendingFinal ||
      ctx.hasToolCalls ||
      ctx.hasToolResults ||
      ctx.allowSilentEmpty ||
      ctx.pausePending ||
      ctx.aborted ||
      !ctx.isAssistant ||
      ctx.stopReason === "aborted" ||
      ctx.hasProviderFailure ||
      ctx.messageText.trim() ||
      ctx.streamed
    ) {
      return ALLOW;
    }
    return {
      action: "follow_up",
      prompt: ctx.optionalReply
        ? EMPTY_RESPONSE_OPTIONAL_REMINDER_PROMPT
        : EMPTY_RESPONSE_REMINDER_PROMPT,
      logEvent: "agent.empty_response_reminder",
      meta: { optionalReply: ctx.optionalReply, hadThinking: ctx.hadThinking },
    };
  },
};

// One bounded nudge for a final reply that admits unfinished checks or promises tool work next.
export const unfinishedWorkContinuationHook: PiPostTurnHook = {
  name: "unfinished_work_continuation",
  maxTriggers: 1,
  evaluate(ctx) {
    if (
      ctx.hasToolCalls ||
      ctx.hasToolResults ||
      ctx.allowSilentEmpty ||
      ctx.optionalReply ||
      ctx.pausePending ||
      ctx.aborted ||
      !ctx.isAssistant ||
      ctx.stopReason !== "stop" ||
      ctx.hasProviderFailure ||
      !ctx.hasTools
    ) {
      return ALLOW;
    }
    const reason = detectPrematureStopReason(ctx.finalTurnText);
    if (!reason) return ALLOW;
    return {
      action: "follow_up",
      prompt: UNFINISHED_WORK_CONTINUATION_PROMPT,
      logEvent: "agent.unfinished_work_continuation",
      meta: { reason },
      resetPendingFinalBoundary: true,
    };
  },
};

export const DEFAULT_PI_POST_TURN_HOOKS: readonly PiPostTurnHook[] = [
  silentToolContinuationHook,
  emptyResponseReminderHook,
  unfinishedWorkContinuationHook,
];

export interface PiPostTurnFollowUp {
  readonly hookName: string;
  /** 1-based trigger count of the hook in this run, including this follow-up. */
  readonly attempt: number;
  readonly decision: Extract<PiPostTurnDecision, { action: "follow_up" }>;
}

/**
 * Per-run evaluator: hooks run in order, a hook stops at its `maxTriggers`, and the first
 * follow-up wins. A throwing hook is logged and skipped, so it cannot crash the run.
 */
export function createPostTurnHookRunner(hooks: readonly PiPostTurnHook[]) {
  const triggers = new Map<string, number>();
  return {
    /** A tool turn resets the trigger count of every hook that opts in. */
    onToolTurn(): void {
      for (const hook of hooks) if (hook.resetOnToolTurn) triggers.delete(hook.name);
    },
    /** How many follow-ups the named hook has requested in this run. */
    triggerCount(name: string): number {
      return triggers.get(name) ?? 0;
    },
    evaluate(baseCtx: Omit<PiPostTurnContext, "priorTriggers">): PiPostTurnFollowUp | undefined {
      for (const hook of hooks) {
        const priorTriggers = triggers.get(hook.name) ?? 0;
        if (priorTriggers >= hook.maxTriggers) continue;
        let decision: PiPostTurnDecision;
        try {
          decision = hook.evaluate({ ...baseCtx, priorTriggers });
        } catch (error) {
          getLogger().error("agent.post_turn_hook_error", error, {
            runId: baseCtx.runId,
            hook: hook.name,
          });
          continue;
        }
        if (decision.action !== "follow_up") continue;
        const attempt = priorTriggers + 1;
        triggers.set(hook.name, attempt);
        return { hookName: hook.name, attempt, decision };
      }
      return undefined;
    },
  };
}
