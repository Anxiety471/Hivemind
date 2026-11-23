import { describe, expect, it } from "vitest";
import { wakeSender } from "./wake-receipt.js";

describe("wakeSender", () => {
  it("reads the sending bot and its message, preferring the message over the detail with host context", () => {
    expect(
      wakeSender({
        fromBotId: " bot-1 ",
        message: "PR #42 is ready",
        detail: "PR #42 is ready | host=h user=u cwd=/x",
      }),
    ).toEqual({ botId: "bot-1", text: "PR #42 is ready" });
  });

  it("falls back to the detail, and is absent without a sender", () => {
    expect(wakeSender({ fromBotId: "bot-1", detail: "hello" })).toEqual({
      botId: "bot-1",
      text: "hello",
    });
    expect(wakeSender({ source: "bot:potato", message: "hi" })).toBeNull();
    expect(wakeSender({ fromBotId: 7, message: "hi" })).toBeNull();
  });
});
