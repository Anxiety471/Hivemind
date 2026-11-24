import type { ConnectorTool } from "@rakazo/adapter-kit";

export const CODE_MODE = "code_mode";
/** A script reaches writes through the host, so their count is bounded apart from all calls. */
export const CODE_MODE_MAX_WRITES = 8;
/** A shell command a script runs is stopped at this limit, well inside the script's own clock. */
export const CODE_MODE_SHELL_TIMEOUT_MS = 45_000;

/**
 * The API index the model writes against: one signature per tool, cut to a size budget with the
 * rest named. It rides in the tool description because it changes with the run's tool set, like
 * find_tool's name index.
 */
export function codeModeToolDefinition(
  index: string,
  options: { codeFirst?: boolean } = {},
): ConnectorTool {
  return {
    name: CODE_MODE,
    description: [
      options.codeFirst
        ? "Most tools are reachable only through this one: call them as `codemode.<name>(...)`, even for a single action. Only the tools listed on their own, such as shell and the ones that talk to the person, are called directly."
        : undefined,
      `Run one TypeScript snippet that calls several tools and prints only what you need. Top-level await is available. \`console.log\` is the only output; print text or JSON. The snippet has no fetch, require, import, files or network — only the API below. Tools marked (writes) change data and are approved exactly like a direct call. A call that asks the person stops the script. Once they approve, the run tells you which call to repeat first; make only that call, then finish the remaining steps yourself or with a new script for only those steps: running the whole script again would ask for the same write again. A script may make at most ${CODE_MODE_MAX_WRITES} writes. A shell command in a script is stopped after at most ${CODE_MODE_SHELL_TIMEOUT_MS / 1000} seconds (timeout_seconds sets it lower), and one that keeps running ends the script, so run long commands directly.`,
      "Saved commands, which any bot may have written, are found with `codemode.search({ query })` and called as `await codemode.cmd.<name>(args)`; what one returns is outside content. Save a command with command_save. `codemode.describe({ name })` returns the full description and schema of a tool or command, and a command's code.",
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
