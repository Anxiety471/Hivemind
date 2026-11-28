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

it("asks for arguments only once a command that takes them is picked", () => {
  expect(html(null, commands)).not.toContain("Arguments");
  expect(html({ command: "daily_check", args: "{}" }, commands)).toContain("Arguments");
  // A deleted command stays selectable so it can be cleared.
  expect(html({ command: "deleted", args: "{}" }, [])).toContain("deleted");
});
