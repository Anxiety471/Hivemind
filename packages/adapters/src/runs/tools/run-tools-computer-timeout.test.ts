import { DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS } from "@rakazo/core/node/sandbox-command";
import { describe, expect, it } from "vitest";
import { shellTimeoutMs } from "./run-tools-computer.js";

const HOUR = 60 * 60_000;

describe("shellTimeoutMs", () => {
  it("uses the default when the bot sets none", () => {
    expect(shellTimeoutMs({ args: { command: "ls" } })).toBe(DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS);
  });

  it("lets the bot raise the limit up to an hour", () => {
    expect(shellTimeoutMs({ args: { timeout_seconds: 900 } })).toBe(900_000);
    expect(shellTimeoutMs({ args: { timeout_seconds: 86_400 } })).toBe(HOUR);
  });

  it("lets the bot lower it, and ignores a value that is not a positive number", () => {
    expect(shellTimeoutMs({ args: { timeout_seconds: 10 } })).toBe(10_000);
    for (const asked of [0, -5, Number.NaN, "30", null]) {
      expect(shellTimeoutMs({ args: { timeout_seconds: asked } })).toBe(
        DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
      );
    }
  });

  it("holds a script's command to the script's ceiling, which the bot may only lower", () => {
    expect(shellTimeoutMs({ args: {}, commandTimeoutMs: 45_000 })).toBe(45_000);
    expect(shellTimeoutMs({ args: { timeout_seconds: 10 }, commandTimeoutMs: 45_000 })).toBe(
      10_000,
    );
    expect(shellTimeoutMs({ args: { timeout_seconds: 600 }, commandTimeoutMs: 45_000 })).toBe(
      45_000,
    );
  });
});
