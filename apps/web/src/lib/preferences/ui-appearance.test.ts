import { describe, expect, it } from "vitest";
import { applyResolvedAppearance, readSystemAppearance } from "./ui-appearance";

describe("ui-appearance", () => {
  it("treats matching light media as light", () => {
    expect(readSystemAppearance({ matches: true })).toBe("light");
    expect(readSystemAppearance({ matches: false })).toBe("dark");
  });

  it("writes data-theme and color-scheme on the root", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    };
    applyResolvedAppearance("light", root as unknown as HTMLElement);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("marks a named palette on top of its base scheme", () => {
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
    applyResolvedAppearance("dark", root as unknown as HTMLElement, "tokyo-night");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.palette).toBe("tokyo-night");
    applyResolvedAppearance("light", root as unknown as HTMLElement);
    expect(root.dataset.palette).toBeUndefined();
  });
});
