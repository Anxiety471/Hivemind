import type { ConnectorTool } from "@rakazo/adapter-kit";

/** One line per callable tool: enough to write a correct call without a second lookup. */
const DESCRIPTION_MAX_CHARS = 90;
const MAX_DEPTH = 3;

function literal(value: unknown): string {
  return JSON.stringify(value) ?? "unknown";
}

function typeOf(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum)) {
    const literals = value.enum.map(literal).join(" | ");
    return literals || "never";
  }
  const union = value.anyOf ?? value.oneOf;
  if (Array.isArray(union)) {
    const members = union.map((member) => typeOf(member, depth));
    return [...new Set(members)].join(" | ") || "unknown";
  }
  if (value.type === "array" || value.items) {
    return `Array<${typeOf(Array.isArray(value.items) ? undefined : value.items, depth)}>`;
  }
  switch (value.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return value.properties ? objectType(value, depth) : "unknown";
  }
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : literal(key);
}

function objectType(schema: Record<string, unknown>, depth: number): string {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const entries = Object.entries(properties);
  if (!entries.length) return "{}";
  if (depth >= MAX_DEPTH) return "{ ... }";
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields = entries.map(
    ([key, property]) =>
      `${propertyKey(key)}${required.has(key) ? "" : "?"}: ${typeOf(property, depth + 1)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

function firstSentence(description: string | undefined): string {
  const text = String(description ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > DESCRIPTION_MAX_CHARS
    ? `${sentence.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
    : sentence;
}

/** The compact call signatures shown to the model, sorted so a run's prompt is stable. */
export function codeModeToolIndex(tools: readonly ConnectorTool[]): string {
  if (!tools.length) return "No read-only tools are available in this run.";
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const signature = objectType(tool.inputSchema ?? {}, 0);
      const hint = firstSentence(tool.description);
      return `- codemode.${tool.name}(${signature}) => JSON${hint ? ` — ${hint}` : ""}`;
    })
    .join("\n");
}
