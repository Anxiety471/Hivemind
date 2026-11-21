import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  taughtSkillsInstruction,
  userTurnInstructions,
} from "./run-instructions.prompt.js";

describe("connectedPluginsInstruction", () => {
  it("names each connected plugin and prefers its tools to browsing", () => {
    expect(
      connectedPluginsInstruction([
        { displayName: "Mail", connectorId: "apps", provider: "mail" },
        { displayName: "Code", connectorId: "apps", provider: "code" },
      ]),
    ).toBe(
      "Connected plugins: Mail (apps:mail), Code (apps:code). Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).",
    );
  });

  it("says so when nothing is connected", () => {
    expect(connectedPluginsInstruction([])).toBe("No plugins are connected yet.");
  });
});

describe("taughtSkillsInstruction", () => {
  it("lists each taught skill with when to use it", () => {
    expect(
      taughtSkillsInstruction([
        { name: "File expenses", whenToUse: "When a receipt arrives" },
        { name: "Book travel", whenToUse: "Book a trip" },
      ]),
    ).toBe(
      "Saved taught skills:\n- File expenses: When a receipt arrives\n- Book travel: Book a trip\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.",
    );
  });

  it("adds nothing when no skill was taught", () => {
    expect(taughtSkillsInstruction([])).toBeUndefined();
  });
});

describe("userTurnInstructions Kanban board clause", () => {
  const base = {
    botInstructions: "",
    groupContext: undefined,
    messagingContext: undefined,
    redactedMemoryContext: undefined,
    redactedScratchpadContext: undefined,
    hasHistoricalContext: false,
    computerInstruction: "Computer.",
    pageBrowserAllowed: false,
    workspaceInstruction: "",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: undefined,
    replyGuidance: "",
  };

  it("includes Kanban board guidance only when ticketBoardEnabled is true", () => {
    const withoutBoard = userTurnInstructions(base).filter(Boolean).join("\n");
    expect(withoutBoard).not.toContain("Kanban board is enabled");

    const withBoard = userTurnInstructions({ ...base, ticketBoardEnabled: true })
      .filter(Boolean)
      .join("\n");
    expect(withBoard).toContain("Kanban board is enabled");
    expect(withBoard).toContain("ticket_create");
    expect(withBoard).toContain("ticket_update");
  });
});
