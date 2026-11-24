import { describe, expect, it } from "vitest";
import { codeModeToolIndex } from "./code-mode-api.js";

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
    expect(codeModeToolIndex([])).toBe("No read-only tools are available in this run.");
  });
});
