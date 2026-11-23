import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  contextToolsInstruction,
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

describe("contextToolsInstruction", () => {
  it("names only the memory, history and drive tools the run was offered", () => {
    const text = contextToolsInstruction(
      new Set(["recall_memory", "search_history", "read_history", "drive_list", "remember"]),
    );
    expect(text).toContain(
      "memory tools (recall_memory), history tools (search_history, read_history), and drive tools (drive_list)",
    );
    expect(text).not.toContain("remember");
    expect(text).toContain(
      "Only your most recent messages stay directly in your conversation window",
    );
    expect(contextToolsInstruction(new Set(["recall_memory"]))).not.toContain(
      "conversation window",
    );
    expect(contextToolsInstruction(new Set(["search_history"]))).toMatch(
      /^You have history tools \(search_history\)\. Only your most recent/,
    );
  });

  it("adds nothing when the run has none of those tools", () => {
    expect(contextToolsInstruction(new Set(["remember"]))).toBeUndefined();
    expect(contextToolsInstruction(undefined)).toBeUndefined();
  });

  it("is the first block of the turn instructions, ahead of the bot's own", () => {
    const instructions = userTurnInstructions({
      botInstructions: "Be brief.",
      groupContext: undefined,
      messagingContext: undefined,
      redactedMemoryContext: undefined,
      redactedScratchpadContext: undefined,
      hasHistoricalContext: false,
      offeredToolNames: new Set(["search_history"]),
      computerInstruction: "Computer.",
      pageBrowserAllowed: false,
      workspaceInstruction: "",
      agentEnvironmentInstruction: undefined,
      botDirectory: undefined,
      pluginLine: undefined,
      agentSkillsLine: undefined,
      taughtSkillsLine: undefined,
      replyGuidance: "",
    });
    expect(instructions[0]).toMatch(/^You have history tools/);
    expect(instructions.indexOf("Be brief.")).toBeGreaterThan(0);
  });
});
