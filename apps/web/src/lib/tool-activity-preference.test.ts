import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeToolActivityEnabled,
  TOOL_ACTIVITY_STORAGE_KEY,
} from "./tool-activity-preference";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("tool activity preference", () => {
  it("stays on unless a saved choice turns it off", () => {
    expect(normalizeToolActivityEnabled("on")).toBe(true);
    expect(normalizeToolActivityEnabled("ON")).toBe(true);
    expect(normalizeToolActivityEnabled(" on ")).toBe(true);
    expect(normalizeToolActivityEnabled("off")).toBe(false);
    expect(normalizeToolActivityEnabled("OFF")).toBe(false);
    expect(normalizeToolActivityEnabled(" off ")).toBe(false);
    expect(normalizeToolActivityEnabled(null)).toBe(true);
    expect(normalizeToolActivityEnabled(undefined)).toBe(true);
    expect(normalizeToolActivityEnabled("")).toBe(true);
    expect(normalizeToolActivityEnabled("nonsense")).toBe(true);
  });

  it("saves the choice as on or off", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    const { toolActivityPreference } = await import("./tool-activity-preference");
    expect(toolActivityPreference.get()).toBe(true);
    toolActivityPreference.set(false);
    expect(store.get(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    toolActivityPreference.set(true);
    expect(store.get(TOOL_ACTIVITY_STORAGE_KEY)).toBe("on");
  });

  it.each([
    ["on", true],
    ["off", false],
    ["garbage", true],
    [null, true],
  ])("reads a saved %s choice as %s", async (saved, expected) => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === TOOL_ACTIVITY_STORAGE_KEY ? saved : null),
      setItem: () => undefined,
    });
    const { toolActivityPreference } = await import("./tool-activity-preference");
    expect(toolActivityPreference.get()).toBe(expected);
  });
});
