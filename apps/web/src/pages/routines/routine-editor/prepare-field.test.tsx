import type { RoutineCommand } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { RoutinePrepareDraft } from "../../../lib/routines/routine-draft";
import { RoutinePrepareField } from "./prepare-field";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const commands: RoutineCommand[] = [
  {
    name: "daily_check",
    description: "Checks the inbox",
    icon: null,
    parameters: { type: "object" },
  },
];

function html(prepare: RoutinePrepareDraft | null, list: RoutineCommand[]): string {
  return renderToStaticMarkup(
    <RoutinePrepareField
      prepare={prepare}
      commands={list}
      onChange={() => undefined}
      fieldId="routine"
    />,
  );
}

it("offers the picker only when the space has saved commands", () => {
  expect(html(null, [])).toBe("");
  expect(html(null, commands)).toContain("Run first");
  // A prepare whose command was deleted stays visible so it can be cleared.
  expect(html({ command: "deleted", args: "{}" }, [])).toContain("Run first");
});
