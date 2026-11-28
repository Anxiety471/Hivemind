import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  contextToolsInstruction,
  dedupeInstructions,
  PRIVATE_WORKSPACE_INSTRUCTION,
  PROACTIVE_POSTURE_INSTRUCTION,
  renderBaseSystemPromptPreview,
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

describe("userTurnInstructions code mode clause", () => {
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

  it("tells the model to batch read-only lookups only when the run offers code_mode", () => {
    const without = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["read_file", "search_history"]),
    }).join("\n");
    expect(without).not.toContain("code_mode");

    const withCode = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["code_mode", "read_file"]),
    }).join("\n");
    expect(withCode).toContain("batch");
    expect(withCode).toContain("code_mode");
  });

  it("names skill_mode as a direct tool only when the run offers it", () => {
    const withSkillMode = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["code_mode", "skill_mode"]),
    }).join("\n");
    expect(withSkillMode).toContain(
      "skill_mode is a direct tool: call it on its own before code_mode when a listed skill fits the task.",
    );

    const withoutSkillMode = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["code_mode", "read_file"]),
    }).join("\n");
    expect(withoutSkillMode).not.toContain("skill_mode is a direct tool");
  });

  it("points at the Routines skill for schedules only when the run can load it", () => {
    const routinesPointer =
      'Before creating or changing a routine or schedule, call skill_mode({ name: "Routines" }) and follow it.';
    const withRoutines = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["schedule_create", "command_save"]),
      followUpsOffered: true,
    }).join("\n");
    expect(withRoutines).toContain(routinesPointer);

    const withoutCommandSave = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["schedule_create"]),
      followUpsOffered: true,
    }).join("\n");
    expect(withoutCommandSave).not.toContain('skill_mode({ name: "Routines" })');

    const withoutFollowUps = userTurnInstructions({
      ...base,
      offeredToolNames: new Set(["schedule_create", "command_save"]),
      followUpsOffered: false,
    }).join("\n");
    expect(withoutFollowUps).not.toContain('skill_mode({ name: "Routines" })');
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
      "Only the latest 10–20 messages stay directly in your conversation window",
    );
    expect(text).toContain('skill_mode({ name: "History" })');
    const memoryOnly = contextToolsInstruction(new Set(["recall_memory"]));
    expect(memoryOnly).not.toContain("conversation window");
    expect(memoryOnly).not.toContain("10–20");
    expect(memoryOnly).not.toContain('skill_mode({ name: "History" })');
    expect(contextToolsInstruction(new Set(["search_history"]))).toMatch(
      /^You have history tools \(search_history\)\. Only the latest 10–20 messages stay directly in your conversation window/,
    );
  });

  it("adds nothing when the run has none of those tools", () => {
    expect(contextToolsInstruction(new Set(["remember"]))).toBeUndefined();
    expect(contextToolsInstruction(undefined)).toBeUndefined();
  });

  it("is the first block of the turn instructions, ahead of appends and bot instructions", () => {
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
    expect(instructions.join("\n")).not.toContain("You run on Rakazo");
  });
});

describe("appends, prefix cache order, and duplicates", () => {
  const base = {
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
  };

  it("places operator and Space appends after static base and before botInstructions", () => {
    const instructions = userTurnInstructions({
      ...base,
      operatorInstruction: "Use wake.",
      spaceSystemPromptAppend: "Always log dates.",
    });
    const opIdx = instructions.indexOf("Use wake.");
    const spaceIdx = instructions.indexOf("Always log dates.");
    const botIdx = instructions.indexOf("Be brief.");
    expect(opIdx).toBeGreaterThan(0);
    expect(spaceIdx).toBeGreaterThan(opIdx);
    expect(botIdx).toBeGreaterThan(spaceIdx);
  });

  it("leaves appends out when the bot's instructions already carry them", () => {
    const instructions = userTurnInstructions({
      ...base,
      botInstructions: "Be brief. Use wake. Always log dates.",
      operatorInstruction: " Use wake. ",
      spaceSystemPromptAppend: " Always log dates. ",
    });
    expect(instructions.filter((block) => block.includes("Use wake."))).toEqual([
      "Be brief. Use wake. Always log dates.",
    ]);
    expect(instructions.filter((block) => block.includes("Always log dates."))).toEqual([
      "Be brief. Use wake. Always log dates.",
    ]);
  });

  it("renders a read-only base system prompt preview without platform branding or duplicate history block", () => {
    const preview = renderBaseSystemPromptPreview();
    expect(preview).toContain(PROACTIVE_POSTURE_INSTRUCTION);
    expect(preview).toContain('skill_mode({ name: "Computer" })');
    expect(preview).toContain('skill_mode({ name: "Subagents" })');
    expect(preview).toContain('skill_mode({ name: "Tasks" })');
    expect(preview).toContain("Kanban board is enabled");
    expect(preview).toContain("ticket_update");
    expect(preview).not.toContain("scratchpad_add");
    expect(preview).toContain("Prefer tools over claiming you already did the work:");
    expect(preview).not.toContain("You run on Rakazo");
    expect(preview).toContain(
      "Only the latest 10–20 messages stay directly in your conversation window",
    );
    expect(preview).toContain('skill_mode({ name: "History" })');
    expect(preview.match(/10–20/g)?.length).toBe(1);
    expect(preview).not.toContain("Only the latest 10–20 messages stay in your window;");
    // The skills catalog is injected on every turn, so its growth is bounded here on purpose.
    // Raised for the attachment and teammate-ownership guardrails, which every turn needs.
    expect(preview.length).toBeLessThan(7_000);
    const catalogAt = preview.indexOf("Available skills (8):");
    expect(catalogAt).toBeGreaterThan(-1);
    expect(preview).toContain("- Computer: ");
    expect(catalogAt).toBeLessThan(preview.indexOf(PRIVATE_WORKSPACE_INSTRUCTION));
    expect(preview).toContain("skill_mode is a direct tool");

    const codeFirstPreview = renderBaseSystemPromptPreview({
      ticketBoardEnabled: true,
      codeModeEnabled: true,
      codeFirst: true,
    });
    expect(codeFirstPreview).toContain("Call most tools from code_mode");
    expect(codeFirstPreview).toContain("skill_mode is a direct tool");
  });

  it("collapses identical blocks and empties, but never a block that merely contains another", () => {
    expect(dedupeInstructions(["A.", undefined, "", "A.", " A. ", "A. B."])).toEqual([
      "A.",
      "A. B.",
    ]);
  });
});
