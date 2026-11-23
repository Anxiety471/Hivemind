import type { ConnectorTool } from "@rakazo/adapter-kit";

export const CODE_MODE = "code_mode";

/**
 * The API index the model writes against: one signature per callable tool. It rides in the
 * tool description because it changes with the run's tool set, like find_tool's name index.
 */
export function codeModeToolDefinition(index: string): ConnectorTool {
  return {
    name: CODE_MODE,
    description: [
      "Run one TypeScript snippet that calls several read-only tools and prints only what you need. Top-level await is available. `console.log` is the only output; print text or JSON. The snippet has no fetch, require, import, files or network — only the API below.",
      index,
    ]
      .filter(Boolean)
      .join("\n\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "TypeScript to run. Call tools as `await codemode.<name>({...})`; they resolve with the tool's JSON result and reject with its error.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    // Every call it can make is itself read-only.
    readOnly: true,
  };
}
