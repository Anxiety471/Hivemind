import type { ConnectorTool } from "@rakazo/adapter-kit";

export const CODE_MODE = "code_mode";
/** A script reaches writes through the host, so their count is bounded apart from all calls. */
export const CODE_MODE_MAX_WRITES = 8;

/**
 * The API index the model writes against: one signature per tool, cut to a size budget with the
 * rest named. It rides in the tool description because it changes with the run's tool set, like
 * find_tool's name index.
 */
export function codeModeToolDefinition(index: string): ConnectorTool {
  return {
    name: CODE_MODE,
    description: [
      `Run one TypeScript snippet that calls several tools and prints only what you need. Top-level await is available. \`console.log\` is the only output; print text or JSON. The snippet has no fetch, require, import, files or network — only the API below. Tools marked (writes) change data and are approved exactly like a direct call. A call that asks the person stops the script. Once they approve, run that approved call directly, then finish the remaining steps yourself or with a new script for only those steps: running the whole script again would ask for the same write again. A script may make at most ${CODE_MODE_MAX_WRITES} writes.`,
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
    // Every call it makes is gated on its own, so the script itself changes nothing.
    readOnly: true,
  };
}
