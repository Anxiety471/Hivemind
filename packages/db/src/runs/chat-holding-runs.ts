import { BACKGROUND_RUN_TRIGGERS, isBackgroundRunTrigger } from "@rakazo/core";
import type { Prisma } from "../database/client.js";

/**
 * Background work (ticket runs) and routines that run alongside their chat never make a user
 * message, a follow-up turn or an in-chat routine wait for them. Every other active run does.
 */
export const HOLDS_CHAT: Prisma.RunWhereInput = {
  NOT: [
    { trigger: { in: [...BACKGROUND_RUN_TRIGGERS] } },
    { trigger: "routine", routine: { is: { inChat: false } } },
  ],
};

/** The same rule for a run already read with its routine's `inChat`. */
export function runHoldsChat(run: {
  trigger: string | null;
  routine?: { inChat: boolean } | null;
}): boolean {
  if (isBackgroundRunTrigger(run.trigger)) return false;
  return !(run.trigger === "routine" && run.routine && !run.routine.inChat);
}
