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
    ).toEqual({ kind: "bot", botId: "bot-1", text: "PR #42 is ready" });
  });

  it("names an outside agent by its own label, never as a bot", () => {
    expect(wakeSender({ fromAgent: " Oh My Pi ", detail: "hello" })).toEqual({
      kind: "agent",
      name: "Oh My Pi",
      text: "hello",
    });
    expect(wakeSender({ fromAgent: "a".repeat(200), message: "hi" })).toMatchObject({
      kind: "agent",
      name: "a".repeat(80),
    });
  });

  it("is absent without a sender, and a bot id wins over an agent label", () => {
    expect(wakeSender({ source: "bot:potato", message: "hi" })).toBeNull();
    expect(wakeSender({ fromBotId: 7, message: "hi" })).toBeNull();
    expect(wakeSender({ fromBotId: "bot-1", fromAgent: "x", message: "hi" })).toMatchObject({
      kind: "bot",
    });
  });
});
