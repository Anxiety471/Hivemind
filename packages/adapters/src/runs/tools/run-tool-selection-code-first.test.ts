import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { codeFirstListedTools } from "./run-tool-selection.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object" } };
}

describe("codeFirstListedTools", () => {
  const listed = (names: string[]) => codeFirstListedTools(names.map(tool)).map((t) => t.name);

  it("keeps code_mode, skill_mode, shell and the tools that talk to the person", () => {
    expect(
      listed(["code_mode", "skill_mode", "shell", "ask_user", "message_user", "request_secret"]),
    ).toEqual(["code_mode", "skill_mode", "shell", "ask_user", "message_user", "request_secret"]);
  });

  it("keeps a tool a script cannot call, such as one that returns an image", () => {
    expect(
      listed(["computer_observe", "run_subagent", "request_takeover", "user_computer_shell"]),
    ).toEqual(["computer_observe", "run_subagent", "request_takeover", "user_computer_shell"]);
  });

  it("drops what a script can call, built-in or connected", () => {
    expect(
      listed(["code_mode", "remember", "web_fetch", "installed_execute_tool", "create_space"]),
    ).toEqual(["code_mode"]);
  });
});
