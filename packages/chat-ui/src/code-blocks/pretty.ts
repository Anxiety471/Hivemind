/**
 * One long line of code is unreadable in a bubble: the sample's row array is a single line of
 * several hundred characters that must be scrolled sideways.
 *
 * `prettyCode` reprints such a line for display only, one property per line, and only when the
 * whole line reads as a declaration of a plain literal. It keeps each value exactly as written
 * — quotes, escapes and all — and inserts nothing but indentation and line breaks. A line it
 * does not fully understand is returned unchanged, and copying always copies the original.
 */

/** Past this a line is worth breaking, and short enough that breaking stays cheap. */
const LONG_LINE = 120;

/** The width a line aims for before it breaks, in characters. */
const WIDTH = 88;

/** A literal as written, with its own text kept for reprinting. */
type Value =
  | { kind: "raw"; text: string }
  | { kind: "array"; items: Value[]; trailing: boolean }
  | { kind: "object"; entries: { key: string; value: Value }[]; trailing: boolean };

/** Where a value ends, or nothing when the text is not a plain literal. */
type Read = { value: Value; next: number };

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function skipSpace(text: string, at: number): number {
  let i = at;
  while (isSpace(text[i])) i++;
  return i;
}

function readString(text: string, at: number): Read | undefined {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote)
      return { value: { kind: "raw", text: text.slice(at, i + 1) }, next: i + 1 };
    if (text[i] === "\n") return undefined;
    i++;
  }
  return undefined;
}

function readPrimitive(text: string, at: number): Read | undefined {
  let i = at;
  while (i < text.length && /[\w.+-]/.test(text[i] ?? "")) i++;
  if (i === at) return undefined;
  const raw = text.slice(at, i);
  if (!/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+))$/i.test(raw)) {
    return undefined;
  }
  return { value: { kind: "raw", text: raw }, next: i };
}

function readValue(text: string, at: number): Read | undefined {
  const i = skipSpace(text, at);
  const char = text[i];
  if (char === '"' || char === "'") return readString(text, i);
  if (char === "[") return readArray(text, i);
  if (char === "{") return readObject(text, i);
  return readPrimitive(text, i);
}

function readArray(text: string, at: number): Read | undefined {
  const items: Value[] = [];
  let i = skipSpace(text, at + 1);
  let trailing = false;
  while (i < text.length) {
    if (text[i] === "]") return { value: { kind: "array", items, trailing }, next: i + 1 };
    const item = readValue(text, i);
    if (!item) return undefined;
    items.push(item.value);
    trailing = false;
    i = skipSpace(text, item.next);
    if (text[i] === ",") {
      trailing = true;
      i = skipSpace(text, i + 1);
    } else if (text[i] !== "]") return undefined;
  }
  return undefined;
}

function readObject(text: string, at: number): Read | undefined {
  const entries: { key: string; value: Value }[] = [];
  let i = skipSpace(text, at + 1);
  let trailing = false;
  while (i < text.length) {
    if (text[i] === "}") return { value: { kind: "object", entries, trailing }, next: i + 1 };
    let key: string;
    let next: number;
    if (text[i] === '"' || text[i] === "'") {
      const read = readString(text, i);
      if (read?.value.kind !== "raw") return undefined;
      key = read.value.text;
      next = read.next;
    } else {
      const start = i;
      if (!/[A-Za-z_$]/.test(text[i] ?? "")) return undefined;
      while (i < text.length && /[\w$]/.test(text[i] ?? "")) i++;
      key = text.slice(start, i);
      next = i;
    }
    i = skipSpace(text, next);
    if (text[i] !== ":") return undefined;
    const value = readValue(text, i + 1);
    if (!value) return undefined;
    entries.push({ key, value: value.value });
    trailing = false;
    i = skipSpace(text, value.next);
    if (text[i] === ",") {
      trailing = true;
      i = skipSpace(text, i + 1);
    } else if (text[i] !== "}") return undefined;
  }
  return undefined;
}

/** The value on one line, with the spacing a reader expects. */
function inline(value: Value): string {
  if (value.kind === "raw") return value.text;
  const comma = value.trailing ? "," : "";
  if (value.kind === "array") return `[${value.items.map(inline).join(", ")}${comma}]`;
  const entries = value.entries.map((entry) => `${entry.key}: ${inline(entry.value)}`);
  return `{ ${entries.join(", ")}${comma} }`;
}

/** The value with entries on their own lines once it no longer fits, indented under `indent`. */
function block(value: Value, indent: number): string {
  const oneLine = inline(value);
  if (oneLine.length + indent <= WIDTH) return oneLine;
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const trailing = value.kind === "raw" ? false : value.trailing;
  const commaAt = (index: number, count: number) => (index < count - 1 || trailing ? "," : "");
  if (value.kind === "array") {
    const count = value.items.length;
    const items = value.items.map(
      (item, index) => `${inner}${block(item, indent + 2)}${commaAt(index, count)}`,
    );
    return `[\n${items.join("\n")}\n${pad}]`;
  }
  if (value.kind === "object") {
    const count = value.entries.length;
    const entries = value.entries.map(
      (entry, index) =>
        `${inner}${entry.key}: ${block(entry.value, indent + 2)}${commaAt(index, count)}`,
    );
    return `{\n${entries.join("\n")}\n${pad}}`;
  }
  return oneLine;
}

/** `const name = ` (or `export const`), the literal, and the semicolon that may follow. */
const DECLARATION = /^(\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)/;

/** A line as its indentation and head, its literal and what closes it, when it is one. */
function readLine(text: string): { head: string; value: Value; tail: string } | undefined {
  const declared = DECLARATION.exec(text);
  if (declared?.[1]) {
    const value = readValue(text, declared[1].length);
    if (!value) return undefined;
    const tail = text.slice(value.next);
    if (!/^\s*;?\s*$/.test(tail)) return undefined;
    return { head: declared[1], value: value.value, tail: tail.trim() === ";" ? ";" : "" };
  }
  // An element on its own line, as a row array is written out: `  { … },`.
  const indent = text.length - text.trimStart().length;
  const value = readValue(text, indent);
  if (!value) return undefined;
  const tail = text.slice(value.next);
  const closing = tail.trim();
  if (!/^[,;]?$/.test(closing)) return undefined;
  return { head: text.slice(0, indent), value: value.value, tail: closing };
}

/**
 * A line reprinted one property per line when it is a long declaration of a plain literal;
 * every other line comes back exactly as it was.
 */
function prettyLine(line: string): string {
  if (line.length <= LONG_LINE) return line;
  const read = readLine(line);
  if (!read) return line;
  const indent = read.head.length - read.head.trimStart().length;
  return `${read.head}${block(read.value, indent)}${read.tail}`;
}

/**
 * The code as a reader wants it: long literal lines broken up, and every other line untouched.
 * Its meaning is unchanged, so it is safe to show; copying still copies the original text.
 */
export function prettyCode(code: string): string {
  if (!code.includes("\n") && !code.includes("[")) return prettyLine(code);
  return code
    .split("\n")
    .map((line) => prettyLine(line))
    .join("\n");
}
