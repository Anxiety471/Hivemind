import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorInstruction } from "./operator-instructions.js";

describe("operatorInstruction", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "operator-instructions-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the trimmed text of the configured file, re-read on each call", async () => {
    const file = join(dir, "run.md");
    vi.stubEnv("RAKAZO_RUN_INSTRUCTIONS_FILE", file);
    await writeFile(file, "\nUse wake.\n");
    expect(await operatorInstruction()).toBe("Use wake.");
    await writeFile(file, "Use wake twice.");
    expect(await operatorInstruction()).toBe("Use wake twice.");
  });

  it("adds nothing when unset, blank, empty or unreadable", async () => {
    vi.stubEnv("RAKAZO_RUN_INSTRUCTIONS_FILE", undefined);
    expect(await operatorInstruction()).toBeUndefined();
    vi.stubEnv("RAKAZO_RUN_INSTRUCTIONS_FILE", "  ");
    expect(await operatorInstruction()).toBeUndefined();
    const empty = join(dir, "empty.md");
    await writeFile(empty, " \n");
    vi.stubEnv("RAKAZO_RUN_INSTRUCTIONS_FILE", empty);
    expect(await operatorInstruction()).toBeUndefined();
    vi.stubEnv("RAKAZO_RUN_INSTRUCTIONS_FILE", join(dir, "missing.md"));
    expect(await operatorInstruction()).toBeUndefined();
  });
});
