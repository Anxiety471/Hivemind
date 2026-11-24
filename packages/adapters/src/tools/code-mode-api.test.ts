import { describe, expect, it } from "vitest";
import {
  CODE_FIRST_INDEX_MAX_CHARS,
  codeModeToolIndex,
  searchCodeModeTools,
} from "./code-mode-api.js";

describe("codeModeToolIndex", () => {
  it("renders one signature per tool, sorted, with enums and optional fields", () => {
    const index = codeModeToolIndex([
      {
        name: "ticket_list",
        description: "List tickets. Continue with nextCursor when returned.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["todo", "done"] },
            limit: { type: "number" },
          },
          required: ["status"],
        },
        readOnly: true,
      },
      {
        name: "list_files",
        description: "List files in a folder",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        readOnly: true,
      },
    ]);
    expect(index.split("\n")).toEqual([
      "- codemode.list_files({ path?: string }) => JSON — List files in a folder",
      '- codemode.ticket_list({ status: "todo" | "done"; limit?: number }) => JSON — List tickets.',
    ]);
  });

  it("keeps nested objects short and collapses a long description to one line", () => {
    const index = codeModeToolIndex([
      {
        name: "search",
        description: `${"Long guidance. ".repeat(20)}`,
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: {
                owner: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
    ]);
    expect(index).not.toContain("\n-");
    expect(index).toContain("- codemode.search({ filter?: { owner?: { id?: string } } }) => JSON");
    expect(index.length).toBeLessThan(180);
  });

  it("replaces the tool list with a sentence when nothing is callable", () => {
    expect(codeModeToolIndex([])).toBe("No tools are available in this run.");
  });

  it("marks a tool that is not declared read-only as writing", () => {
    const index = codeModeToolIndex([
      { name: "ticket_create", description: "Create a ticket.", inputSchema: {} },
      { name: "ticket_list", description: "List tickets.", inputSchema: {}, readOnly: true },
    ]);
    expect(index.split("\n")).toEqual([
      "- codemode.ticket_create({}) => JSON (writes) — Create a ticket.",
      "- codemode.ticket_list({}) => JSON — List tickets.",
    ]);
  });

  it("names the tools past the size budget and keeps the preferred ones whole", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${String(i).padStart(3, "0")}`,
      description: "Does a thing for the person.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      readOnly: true,
    }));
    const index = codeModeToolIndex(many, { listedFirst: (name) => name === "tool_199" });
    expect(index.length).toBeLessThan(8_000);
    expect(index).toContain("- codemode.tool_199(");
    expect(index).toContain("More tools, by name only;");
    expect(index).toMatch(/tool_198(,|$)/);
    expect(index).not.toContain("- codemode.tool_198(");
  });

  it("keeps more signatures when the budget is raised", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${String(i).padStart(3, "0")}`,
      description: "Does a thing for the person.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      readOnly: true,
    }));
    const small = codeModeToolIndex(many);
    const large = codeModeToolIndex(many, { maxChars: CODE_FIRST_INDEX_MAX_CHARS });
    expect(large.split("\n- codemode.").length).toBeGreaterThan(
      small.split("\n- codemode.").length * 1.5,
    );
  });
});

describe("searchCodeModeTools", () => {
  const tools = [
    {
      name: "ticket_create",
      description: "Create a ticket on the board.",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
    {
      name: "board_tickets",
      description: "List the board's tickets.",
      inputSchema: {},
      readOnly: true,
    },
    { name: "read_file", description: "Read a file.", inputSchema: {}, readOnly: true },
  ];

  it("returns signatures for tools matching every word, name matches first", () => {
    expect(searchCodeModeTools(tools, "ticket board")).toEqual([
      {
        name: "board_tickets",
        signature: "{}",
        description: "List the board's tickets.",
        writes: false,
      },
      {
        name: "ticket_create",
        signature: "{ title?: string }",
        description: "Create a ticket on the board.",
        writes: true,
      },
    ]);
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(searchCodeModeTools(tools, "  ")).toEqual([]);
    expect(searchCodeModeTools(tools, "zebra")).toEqual([]);
  });
});
