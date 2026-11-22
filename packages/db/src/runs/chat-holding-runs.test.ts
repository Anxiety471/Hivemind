import { BACKGROUND_RUN_TRIGGERS } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { HOLDS_CHAT, runHoldsChat } from "./chat-holding-runs.js";

describe("chat holding runs", () => {
  it("excludes background runs and routines running alongside their chat", () => {
    expect(runHoldsChat({ trigger: "tickets" })).toBe(false);
    expect(runHoldsChat({ trigger: "routine", routine: { inChat: false } })).toBe(false);

    expect(runHoldsChat({ trigger: "user" })).toBe(true);
    expect(runHoldsChat({ trigger: "follow_up" })).toBe(true);
    expect(runHoldsChat({ trigger: "webhook" })).toBe(true);
    expect(runHoldsChat({ trigger: "bot_message" })).toBe(true);
    expect(runHoldsChat({ trigger: "routine", routine: { inChat: true } })).toBe(true);
    expect(runHoldsChat({ trigger: "routine", routine: null })).toBe(true);
    expect(runHoldsChat({ trigger: null })).toBe(true);
  });

  it("matches the same exclusions in the Prisma HOLDS_CHAT filter", () => {
    expect(HOLDS_CHAT).toEqual({
      NOT: [
        { trigger: { in: [...BACKGROUND_RUN_TRIGGERS] } },
        { trigger: "routine", routine: { is: { inChat: false } } },
      ],
    });
  });
});
