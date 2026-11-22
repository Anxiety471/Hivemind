import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { knownSandboxKinds, sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";

// The Go gateway answers threads.get from this copy, so it has to follow the providers.
const table = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../apps/api-go/internal/procedures/threads/computer_kinds.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  undeclared: Record<string, unknown>;
  kinds: Record<string, Record<string, unknown>>;
};

const shape = (kind: string | null) => {
  const { terminal, inPlaceUpdate, runsOnUserMachine, screen } = sandboxKindCapabilities(kind);
  return { terminal, inPlaceUpdate, runsOnUserMachine, width: screen.width, height: screen.height };
};

describe("computer kind capabilities copied for the Go gateway", () => {
  it("lists exactly the known kinds with their capabilities", () => {
    expect(Object.keys(table.kinds).sort()).toEqual([...knownSandboxKinds].sort());
    for (const kind of knownSandboxKinds) expect(table.kinds[kind]).toEqual(shape(kind));
  });

  it("matches what an unknown kind reads as", () => {
    expect(table.undeclared).toEqual(shape("no-such-kind"));
  });
});
