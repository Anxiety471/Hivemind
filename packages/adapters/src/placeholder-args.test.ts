import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolHost } from "./pi-runtime-tools.js";
import { toAgentTools } from "./pi-runtime-tools.js";
import { lintPlaceholderArguments, placeholderRejectionMessage } from "./placeholder-args.js";

const schema = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

describe("lintPlaceholderArguments", () => {
  it("flags the placeholder poll a bot posted to chat", () => {
    const findings = lintPlaceholderArguments(
      "create_poll",
      { title: "placeholder", options: ["a", "b"] },
      schema({ title: { type: "string" }, options: { type: "array" } }, ["title", "options"]),
    );
    expect(findings.map(({ path, rule }) => [path, rule])).toEqual([
      ["options[0]", "alphabet-index"],
      ["options[1]", "alphabet-index"],
      ["title", "placeholder-word"],
    ]);
    expect(placeholderRejectionMessage(findings)).toBe(
      'argument "options[0]" looks like a placeholder ("a"); provide the actual value, or ask the user if it\'s unknown ' +
        'argument "options[1]" looks like a placeholder ("b"); provide the actual value, or ask the user if it\'s unknown ' +
        'argument "title" looks like a placeholder ("placeholder"); provide the actual value, or ask the user if it\'s unknown',
    );
  });

  it.each([
    ["a single uppercase letter", "A"],
    ["an uppercase letter with digits", "B7"],
    ["a lowercase letter, which a whole argument is a stub for", "b"],
    ["a filler word with separators", "to_do"],
    ["a filler word with case", "PlaceHolder"],
    ["repeated filler letters", "xXx"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the token is the test input
    ["a template escape", "${answer}"],
    ["a mustache token", "{{user_name}}"],
    ["an angle token", "<your-api-key>"],
    ["a printf token", "%s"],
    ["lorem ipsum", "lorem ipsum"],
  ])("flags %s", (_label, value) => {
    expect(
      lintPlaceholderArguments(
        "some_tool",
        { field: value },
        schema({ field: { type: "string" } }),
      ),
    ).toEqual([expect.objectContaining({ path: "field", value })]);
  });

  it.each([
    ["an empty optional field", { note: "" }],
    ["a real short answer", { field: "yes" }],
    ["markup", { field: "see <div class=x> and <stdio.h>" }],
    ["comparison prose", { field: "x < y and 5 < 10 > 3" }],
    ["percent-encoding", { field: "https://example.com/a%20b?q=%2F" }],
    ["ratio prose", { field: "5% v/v and 5% e.g." }],
    ["a verb inside a word", { field: "%done and %d0" }],
    ["a sentence naming a placeholder", { field: "The title says placeholder here" }],
    ["a normal name", { name: "Comms Bot" }],
    ["a number-shaped value", { count: "42" }],
  ])("leaves %s alone", (_label, args) => {
    const properties = Object.fromEntries(
      Object.keys(args).map((name) => [name, { type: "string" }]),
    );
    expect(lintPlaceholderArguments("some_tool", args, schema(properties))).toEqual([]);
  });

  it("flags a blank value only when the schema requires the argument", () => {
    const properties = { title: { type: "string" }, note: { type: "string" } };
    expect(
      lintPlaceholderArguments("some_tool", { title: "", note: "" }, schema(properties, ["title"])),
    ).toEqual([expect.objectContaining({ path: "title", rule: "blank-required" })]);
  });

  it("leaves enum values the schema itself declares alone", () => {
    expect(
      lintPlaceholderArguments(
        "some_tool",
        { mode: "a", grade: "b" },
        schema({
          mode: { type: "string", enum: ["a", "b"] },
          grade: { type: "string", enum: ["a", "b", "c"] },
        }),
      ),
    ).toEqual([]);
  });

  it("leaves the prose a bot is asked to transcribe verbatim alone", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the token is the test input
    const content = "Write a template: ${name} <placeholder> %s TODO xxx";
    expect(
      lintPlaceholderArguments(
        "write_file",
        { path: "notes/result.txt", content },
        schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      ),
    ).toEqual([]);
    expect(
      lintPlaceholderArguments(
        "shell",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the token is the test input
        { command: "echo ${X} | grep <pattern>" },
        schema({ command: { type: "string" } }),
      ),
    ).toEqual([]);
  });

  it("leaves computer tools alone: their values are keystrokes and UI text", () => {
    expect(
      lintPlaceholderArguments(
        "computer_act",
        { actions: [{ type: "type", text: "a" }], description: "b" },
        undefined,
      ),
    ).toEqual([]);
  });

  it("walks nested shapes and sorts the findings by path", () => {
    const findings = lintPlaceholderArguments(
      "some_tool",
      { config: { label: "TBD" }, hosts: ["dummy", "real.example"], "weird.key": "xxx" },
      undefined,
    );
    expect(findings.map(({ path, rule }) => [path, rule])).toEqual([
      ["config.label", "placeholder-word"],
      ["hosts[0]", "placeholder-word"],
      ["weird\\.key", "filler-repeat"],
    ]);
    const weird = findings.find(({ path }) => path === "weird\\.key");
    expect(placeholderRejectionMessage([weird!])).toContain('"weird.key"');
  });

  it("cannot loop on a self-referential argument object", () => {
    const args: Record<string, unknown> = { name: "real" };
    args.self = args;
    expect(lintPlaceholderArguments("some_tool", args, undefined)).toEqual([]);
  });

  it("truncates a long offending value in the message", () => {
    const [finding] = lintPlaceholderArguments(
      "some_tool",
      { field: "x".repeat(80) },
      schema({ field: { type: "string" } }),
    );
    expect(finding?.value).toHaveLength(80);
    expect(placeholderRejectionMessage([finding!])).toContain(`"${"x".repeat(37)}..."`);
  });
});

describe("toAgentTools placeholder rejection", () => {
  const signal = new AbortController().signal;
  let host: ToolHost;

  beforeEach(() => {
    host = {
      queue: { push: vi.fn() },
      request: { runId: "run" } as ToolHost["request"],
      toolCallBudget: { count: 0, exceeded: false, limit: 0, inFlight: 0 },
      toolCallSeq: { value: 0 },
      providerToolCallIds: new Map(),
      abortTurn: vi.fn(),
      signal,
      pausePending: false,
      pendingShells: [],
    } as unknown as ToolHost;
  });

  const tool = (name: string, required: string[]): ConnectorTool =>
    ({
      name,
      description: "test tool",
      inputSchema: schema(
        { title: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        required,
      ),
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    }) as unknown as ConnectorTool;

  it("refuses the call before it runs, with the finding and no recorded arguments", async () => {
    const [agentTool] = toAgentTools([tool("create_poll", ["title", "options"])], host);
    await expect(
      agentTool!.execute("call-1", { title: "placeholder", options: ["a", "b"] } as never, signal),
    ).rejects.toThrow(
      'argument "title" looks like a placeholder ("placeholder"); provide the actual value, or ask the user if it\'s unknown',
    );
    expect(host.queue.push).not.toHaveBeenCalled();
    expect(host.toolCallBudget.count).toBe(0);
  });

  it("lets the same call through once every flagged value is real", async () => {
    const [agentTool] = toAgentTools([tool("create_poll", ["title", "options"])], host);
    await expect(
      agentTool!.execute(
        "call-1",
        { title: "Lunch on Friday?", options: ["Yes", "No"] } as never,
        signal,
      ),
    ).resolves.toBeDefined();
  });
});
