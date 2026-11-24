import type { ConnectorTool } from "@rakazo/adapter-kit";

export const COMMAND_TOOL_NAMES = new Set(["command_save", "command_delete"]);

export const commandTools: ConnectorTool[] = [
  {
    name: "command_save",
    description:
      "Save a command any bot can call from a code_mode script as `codemode.cmd.<name>(args)` and find with `codemode.search`. Use it for a sequence of calls worth repeating. Saving an existing name replaces it. `code` is the body of an async function with `args` in scope; what it returns is the call's result, and its console.log prints nothing. It may call tools but not other commands.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Lowercase letters, digits and underscores; the name after `cmd.`.",
        },
        description: {
          type: "string",
          description: "What it does and when to use it; search matches on this.",
        },
        icon: {
          type: "string",
          description: 'A Lucide icon name for the UI, such as "file-text". Optional.',
        },
        parameters: {
          type: "object",
          description: "JSON Schema for `args`, shown in search results. Omit if it takes none.",
        },
        code: { type: "string", description: "TypeScript function body." },
      },
      required: ["name", "description", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "command_delete",
    description: "Delete a saved command by name. Every bot loses it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];
