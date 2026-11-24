import type { ConnectorTool } from "@rakazo/adapter-kit";
import { isCodeModeWrite } from "../runs/tools/run-tool-selection.js";

/** One line per callable tool: enough to write a correct call without a second lookup. */
const DESCRIPTION_MAX_CHARS = 90;
const MAX_DEPTH = 3;
/** Signature characters one description carries; tools past it are listed by name only. */
const INDEX_MAX_CHARS = 6_000;
/** The budget when the script is the only way to most tools, so the index replaces their schemas. */
export const CODE_FIRST_INDEX_MAX_CHARS = 12_000;
const SEARCH_LIMIT = 8;
const WRITES_MARK = " (writes)";
/** The name `codemode.search` is installed under, when no real tool already has it. */
export const CODE_MODE_SEARCH = "search";

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

function signatureLine(tool: ConnectorTool): string {
  const signature = objectType(tool.inputSchema ?? {}, 0);
  const hint = firstSentence(tool.description);
  const writes = isCodeModeWrite(tool) ? WRITES_MARK : "";
  return `- codemode.${tool.name}(${signature}) => JSON${writes}${hint ? ` — ${hint}` : ""}`;
}

/**
 * The call signatures shown to the model, sorted so a run's prompt is stable. Signatures stop at
 * a size budget; the remaining tools are named so `codemode.search` can fetch their signature.
 * Tools `listedFirst` accepts keep their signature when the budget cuts the list.
 */
export function codeModeToolIndex(
  tools: readonly ConnectorTool[],
  options: { listedFirst?: (name: string) => boolean; maxChars?: number } = {},
): string {
  if (!tools.length) return "No tools are available in this run.";
  const first = options.listedFirst;
  const ordered = [...tools].sort(
    (a, b) =>
      Number(first?.(b.name) ?? false) - Number(first?.(a.name) ?? false) ||
      a.name.localeCompare(b.name),
  );
  const lines: string[] = [];
  const named: string[] = [];
  let size = 0;
  for (const tool of ordered) {
    const line = signatureLine(tool);
    if (named.length === 0 && size + line.length <= (options.maxChars ?? INDEX_MAX_CHARS)) {
      lines.push(line);
      size += line.length + 1;
    } else {
      named.push(isCodeModeWrite(tool) ? `${tool.name}${WRITES_MARK}` : tool.name);
    }
  }
  const rest = named.length
    ? [
        `More tools, by name only; \`await codemode.search({ query })\` returns their signatures: ${named
          .sort((a, b) => a.localeCompare(b))
          .join(", ")}`,
      ]
    : [];
  return [...lines.sort((a, b) => a.localeCompare(b)), ...rest].join("\n");
}

export interface CodeModeSearchHit {
  name: string;
  signature: string;
  description: string;
  writes: boolean;
}

/** The tools whose name or description matches every word of the query, best match first. */
export function searchCodeModeTools(
  tools: readonly ConnectorTool[],
  query: string,
): CodeModeSearchHit[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  if (!words.length) return [];
  return tools
    .flatMap((tool) => {
      const name = tool.name.toLowerCase();
      const description = String(tool.description ?? "").toLowerCase();
      if (!words.every((word) => name.includes(word) || description.includes(word))) return [];
      const score = words.filter((word) => name.includes(word)).length;
      return [{ tool, score }];
    })
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, SEARCH_LIMIT)
    .map(({ tool }) => ({
      name: tool.name,
      signature: objectType(tool.inputSchema ?? {}, 0),
      description: firstSentence(tool.description),
      writes: isCodeModeWrite(tool),
    }));
}
