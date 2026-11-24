import type { ConnectorTool } from "@rakazo/adapter-kit";
import { isCodeModeWrite } from "../runs/tools/run-tool-selection.js";
import type { CodeCommandInput, CodeCommandSummary } from "./code-commands.js";
import { CODE_COMMAND_PREFIX } from "./code-commands.js";

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
/** The name `codemode.describe` is installed under, when no real tool already has it. */
export const CODE_MODE_DESCRIBE = "describe";
/** Names one `describe` call may ask for; a schema is large and every one is read into the run. */
export const CODE_MODE_DESCRIBE_MAX_NAMES = 5;

function literal(value: unknown): string {
  return JSON.stringify(value) ?? "unknown";
}

function typeOf(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const value = schema as Record<string, unknown>;
  if ("const" in value && value.const !== undefined) {
    return literal(value.const);
  }
  if (Array.isArray(value.enum)) {
    const literals = value.enum.map(literal).join(" | ");
    return literals || "never";
  }
  const union = value.anyOf ?? value.oneOf;
  if (Array.isArray(union)) {
    const members = union.map((member) => typeOf(member, depth));
    return [...new Set(members)].join(" | ") || "unknown";
  }
  if (Array.isArray(value.type)) {
    const members = value.type.map((member) => typeOf({ ...value, type: member }, depth));
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
    case "object":
      return objectType(value, depth);
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
  if (!entries.length) {
    if (schema.additionalProperties === true) return "Record<string, unknown>";
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `Record<string, ${typeOf(schema.additionalProperties, depth + 1)}>`;
    }
    return "{}";
  }
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
  const maxChars = options.maxChars ?? INDEX_MAX_CHARS;
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
    if (named.length === 0) {
      const line = signatureLine(tool);
      if (size + line.length <= maxChars) {
        lines.push(line);
        size += line.length + 1;
        continue;
      }
    }
    named.push(isCodeModeWrite(tool) ? `${tool.name}${WRITES_MARK}` : tool.name);
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
  /** Absent for a saved command: what it writes is decided by the calls it makes. */
  writes?: boolean;
}

/**
 * The tools and saved commands matching the query, best match first (all-word matches preferred,
 * falling back to partial word matches when a multi-word query finds nothing). A command is
 * named as it is called, `cmd.<name>`.
 */
export function searchCodeModeTools(
  tools: readonly ConnectorTool[],
  query: string,
  commands: readonly CodeCommandSummary[] = [],
): CodeModeSearchHit[] {
  const trimmed = query.trim().toLowerCase();
  const words = trimmed.split(/[^a-z0-9_]+/).filter(Boolean);
  if (!words.length) return [];
  const candidates = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: String(tool.description ?? ""),
      schema: tool.inputSchema ?? {},
      writes: isCodeModeWrite(tool) as boolean | undefined,
    })),
    ...commands.map((command) => ({
      name: `${CODE_COMMAND_PREFIX}${command.name}`,
      description: command.description,
      schema: command.parameters ?? {},
      writes: undefined as boolean | undefined,
    })),
  ].map((candidate) => {
    const name = candidate.name.toLowerCase();
    const description = candidate.description.toLowerCase();
    const paramNames = Object.keys(
      (candidate.schema.properties as Record<string, unknown> | undefined) ?? {},
    )
      .join(" ")
      .toLowerCase();
    const exactMatch = name === trimmed || name === `${CODE_COMMAND_PREFIX}${trimmed}` ? 1 : 0;
    let matchedWords = 0;
    let nameMatches = 0;
    for (const word of words) {
      const inName = name.includes(word);
      if (inName) nameMatches += 1;
      if (inName || description.includes(word) || paramNames.includes(word)) {
        matchedWords += 1;
      }
    }
    return { candidate, exactMatch, matchedWords, nameMatches };
  });

  const strict = candidates.filter((entry) => entry.matchedWords === words.length);
  const ranked =
    strict.length > 0 || words.length === 1
      ? strict
      : candidates.filter((entry) => entry.matchedWords > 0);

  return ranked
    .sort(
      (a, b) =>
        b.exactMatch - a.exactMatch ||
        b.matchedWords - a.matchedWords ||
        b.nameMatches - a.nameMatches ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .slice(0, SEARCH_LIMIT)
    .map(({ candidate }) => ({
      name: candidate.name,
      signature: objectType(candidate.schema, 0),
      description: firstSentence(candidate.description),
      ...(candidate.writes === undefined ? {} : { writes: candidate.writes }),
    }));
}

/** What `codemode.describe` returns for one name: the whole definition, not the index line. */
export interface CodeModeDescription {
  name: string;
  description?: string;
  /** The tool's full JSON Schema, or a command's `args` schema. */
  inputSchema?: unknown;
  writes?: boolean;
  /** A saved command's code, so it can be read before it is run. */
  code?: string;
  error?: string;
}

export function describeCodeModeTool(tool: ConnectorTool): CodeModeDescription {
  return {
    name: tool.name,
    description: String(tool.description ?? ""),
    inputSchema: tool.inputSchema ?? {},
    writes: isCodeModeWrite(tool),
  };
}

export function describeCodeCommand(command: CodeCommandInput): CodeModeDescription {
  return {
    name: `${CODE_COMMAND_PREFIX}${command.name}`,
    description: command.description,
    inputSchema: command.parameters ?? {},
    code: command.code,
  };
}

export function undescribed(name: string): CodeModeDescription {
  return {
    name,
    error: `${name} is not a tool this run offers or a saved command. Find one with codemode.search.`,
  };
}
