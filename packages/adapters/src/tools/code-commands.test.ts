import { describe, expect, it, vi } from "vitest";
import { CODE_COMMAND_PREFIX, codeCommandScript, parseCodeCommandInput } from "./code-commands.js";
import { runCodeModeScript } from "./code-mode-sandbox.js";

const valid = {
  name: "weekly_report",
  description: "Builds the weekly report.",
  code: "return 1;",
};

describe("parseCodeCommandInput", () => {
  it("accepts a command with an icon and parameters", () => {
    const parsed = parseCodeCommandInput({
      ...valid,
      icon: "file-text",
      parameters: { type: "object", properties: { week: { type: "string" } } },
    });
    expect(parsed).toEqual({
      command: {
        ...valid,
        icon: "file-text",
        parameters: { type: "object", properties: { week: { type: "string" } } },
      },
    });
  });

  it("leaves the icon and parameters out when they are not given", () => {
    expect(parseCodeCommandInput(valid)).toEqual({ command: valid });
  });

  it.each(["Weekly", "1report", "weekly-report", "a".repeat(49), ""])(
    "rejects the name %j",
    (name) => {
      expect(parseCodeCommandInput({ ...valid, name })).toHaveProperty("error");
    },
  );

  it.each(["FileText", "file_text", "-file", "file-", 3])("rejects the icon %j", (icon) => {
    expect(parseCodeCommandInput({ ...valid, icon })).toHaveProperty("error");
  });

  it("rejects a missing description, empty code and non-object parameters", () => {
    expect(parseCodeCommandInput({ ...valid, description: " " })).toHaveProperty("error");
    expect(parseCodeCommandInput({ ...valid, code: "  " })).toHaveProperty("error");
    expect(parseCodeCommandInput({ ...valid, parameters: ["a"] })).toHaveProperty("error");
  });
});

describe("codeCommandScript", () => {
  const run = (code: string, args: Record<string, unknown> = {}) =>
    runCodeModeScript({
      code: codeCommandScript(code, args),
      tools: [],
      call: async () => undefined,
    });

  it("prints only what the command returns, as JSON, with args in scope", async () => {
    const result = await run(`console.log("noise"); return { sum: args.a + args.b };`, {
      a: 2,
      b: 3,
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('{"sum":5}');
  });

  it("returns null for a command that returns nothing", async () => {
    expect((await run(`const x = 1;`)).output).toBe("null");
  });

  it("reports a command that throws", async () => {
    const result = await run(`throw new Error("bad input");`);
    expect(result.error?.message).toMatch(/bad input/);
  });
});

describe("codemode.cmd", () => {
  it("passes a call under the command prefix to the host, which decides what it is", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const result = await runCodeModeScript({
      code: `console.log(JSON.stringify(await codemode.cmd.weekly_report({ week: "w1" })));`,
      tools: [],
      commandPrefix: CODE_COMMAND_PREFIX,
      call,
    });
    expect(result.error).toBeUndefined();
    expect(call).toHaveBeenCalledWith("cmd.weekly_report", { week: "w1" });
    expect(result.output).toBe('{"ok":true}');
  });

  it("refuses a name outside the prefix that the run does not offer", async () => {
    const call = vi.fn(async () => undefined);
    const result = await runCodeModeScript({
      code: `await codemode.secret_tool({});`,
      tools: ["demo_search"],
      commandPrefix: CODE_COMMAND_PREFIX,
      call,
    });
    expect(result.error?.message).toMatch(/not a tool this run offers/);
    expect(call).not.toHaveBeenCalled();
  });
});
