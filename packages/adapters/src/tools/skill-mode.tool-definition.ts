import type { ConnectorTool } from "@rakazo/adapter-kit";

export const SKILL_MODE = "skill_mode";
export const SKILL_MODE_MAX_BATCH_NAMES = 5;
export const SKILL_MODE_DEFAULT_LIMIT = 5;

export const skillModeToolDefinition: ConnectorTool = {
  name: SKILL_MODE,
  description:
    "Load the matching skill (recipe) first, before other tools. Use query, name (+ optional file), names (max 5), or list: true. Clear search winners auto-load.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      name: { type: "string" },
      names: {
        type: "array",
        items: { type: "string" },
        maxItems: SKILL_MODE_MAX_BATCH_NAMES,
        description: "Up to 5 skill names.",
      },
      file: { type: "string", description: "Attached file path." },
      list: { type: "boolean" },
      source: {
        type: "string",
        enum: ["builtin", "user", "plugin", "taught"],
      },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    additionalProperties: false,
  },
  readOnly: true,
};
