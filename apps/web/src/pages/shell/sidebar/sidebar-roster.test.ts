import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRosterTime, splitRosterName } from "./sidebar-roster";

vi.mock("@lingui/core", () => ({
  i18n: { locale: "en" },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

describe("splitRosterName", () => {
  it("splits Name · Role into primary name and muted role suffix", () => {
    expect(splitRosterName("Grok Bot · Chief of Staff")).toEqual({
      primary: "Grok Bot",
      role: " · Chief of Staff",
    });
  });

  it("leaves names without a middle-dot separator intact", () => {
    expect(splitRosterName("Documentation Writer")).toEqual({
      primary: "Documentation Writer",
      role: null,
    });
  });

  it("ignores leading or trailing separators", () => {
    expect(splitRosterName(" · Chief")).toEqual({ primary: " · Chief", role: null });
    expect(splitRosterName("Chief · ")).toEqual({ primary: "Chief · ", role: null });
  });
});

describe("formatRosterTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 21, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats same-day English times compactly", () => {
    const morning = new Date(2026, 10, 21, 5, 13, 0).toISOString();
    const afternoon = new Date(2026, 10, 21, 15, 42, 0).toISOString();
    expect(formatRosterTime(morning)).toBe("5:13a");
    expect(formatRosterTime(afternoon)).toBe("3:42p");
  });

  it("keeps Yesterday for the prior day", () => {
    const yesterday = new Date(2026, 10, 20, 9, 0, 0).toISOString();
    expect(formatRosterTime(yesterday)).toBe("Yesterday");
  });
});
