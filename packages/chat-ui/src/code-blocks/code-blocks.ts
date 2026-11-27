/**
 * Bots sometimes answer with code and no fence: `const data = [...]`, a render call, a shell
 * line. Markdown reads that as prose, and the sanitizer drops any raw JSX with it, so the
 * answer arrives as paragraphs with holes in it.
 *
 * `codeBlockMarkdown` puts each run of lines that reads as code in a fenced block, labelled
 * with the language it looks like, before Markdown parses the message. It reads text only, in
 * one pass, and nothing it is not sure about is touched.
 */

/** A fence language the reader may guess. */
type Language = "jsx" | "tsx" | "ts" | "js" | "json" | "python" | "bash" | "html";

/** The shortest run worth a block: shorter text is a word, not code. */
const MINIMUM_RUN = 8;

/** A fenced code block, with up to three spaces of indent before its marker. */
type Fence = { start: number; end: number; closed: boolean };

type Edit = { from: number; to: number; text: string };

// --- line helpers -----------------------------------------------------------------------

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function lineEnd(text: string, at: number, limit: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 || end > limit ? limit : end;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

/** A line that begins a Markdown block: a heading, quote, list item, table row or fence. */
function opensMarkdownBlock(trimmed: string): boolean {
  const first = trimmed[0];
  if (first === "#" || first === ">" || first === "|" || first === "`" || first === "~")
    return true;
  if (trimmed.startsWith("---") || trimmed.startsWith("***") || trimmed.startsWith("___"))
    return true;
  if (first === "-" || first === "*" || first === "+")
    return trimmed[1] === " " || trimmed[1] === "\t";
  return /^\d+[.)]\s/.test(trimmed);
}

/** Punctuation no sentence carries: enough to tell a statement from a line of prose. */
function hasSyntax(text: string): boolean {
  for (const char of text) {
    if (
      char === "=" ||
      char === ";" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "[" ||
      char === "]" ||
      char === "<" ||
      char === ">" ||
      char === '"' ||
      char === "'" ||
      char === "`" ||
      char === ":"
    ) {
      return true;
    }
  }
  return text.includes("=>");
}

const STATEMENT_WORDS = [
  "const ",
  "let ",
  "var ",
  "function ",
  "async function ",
  "class ",
  "interface ",
  "type ",
  "import ",
  "export ",
  "return ",
  "await ",
  "throw ",
  "if (",
  "for (",
  "while (",
  "switch (",
  "try {",
  "} catch",
  "else ",
  "def ",
  "elif ",
  "print(",
];

/** A line that can only be the first line of code: a statement, a call, a tag, a literal. */
function startsCode(trimmed: string): boolean {
  if (trimmed.length < MINIMUM_RUN) return false;
  if (opensMarkdownBlock(trimmed)) return false;
  for (const word of STATEMENT_WORDS) {
    if (trimmed.startsWith(word) && hasSyntax(trimmed)) return true;
  }
  // A dotted call: `ReactDOM.render(…)` or `console.log(…)`.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\(/.test(trimmed)) return true;
  // A JSX or HTML tag, but not an autolinked URL, which starts `<https:`.
  if (/^<\/?[A-Za-z][\w-]*(?:\s|\/?>)/.test(trimmed)) return true;
  // A JSON-ish literal, which the run's balance check then has to confirm. An array of
  // objects starts the same way a Markdown link list does.
  if (trimmed.startsWith("[")) {
    if (/^\[[^\]]*\]\(/.test(trimmed)) return false;
    return hasSyntax(trimmed);
  }
  if (trimmed.startsWith("{") && hasSyntax(trimmed)) return true;
  // A shell line the author marked as one.
  if (trimmed.startsWith("$ ") || trimmed.startsWith("#!/")) return true;
  // A comment line belongs to the code below it.
  if (trimmed.startsWith("//") || trimmed.startsWith("/*")) return true;
  return false;
}

/** A line that continues the code above it: a close, a chain, or an indented statement. */
function continuesCode(line: string, trimmed: string, openBrackets: boolean): boolean {
  if (trimmed === "") return true;
  if (opensMarkdownBlock(trimmed)) return false;
  if (openBrackets) return true;
  const first = trimmed[0];
  if (first === ")" || first === "]" || first === "}" || first === "." || first === ",")
    return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("* ")) return true;
  if (trimmed.startsWith("=>") || trimmed.startsWith("else") || trimmed.startsWith("catch")) {
    return true;
  }
  return indentOf(line) > 0 && hasSyntax(trimmed);
}

// --- balance ----------------------------------------------------------------------------

/**
 * The bracket depth after a line, read outside strings, templates and comments. Only the
 * balance matters, so a template's own `${…}` is left inside the string.
 */
function depthAfter(line: string, depth: number): number {
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      while (i < line.length && line[i] !== quote) i += line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (char === "/" && line[i + 1] === "/") return depth;
    if (char === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) return depth;
      i = end + 2;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    i++;
  }
  return depth;
}

// --- language ---------------------------------------------------------------------------

const TYPESCRIPT = [
  "interface ",
  "enum ",
  "implements ",
  ": string",
  ": number",
  ": boolean",
  ": void",
  ": Promise<",
  ": Array<",
  " as const",
  " as ",
  "import type ",
];

/** `name: Type` and `name: Type[]`, which JavaScript has no reason to write. */
const TYPE_ANNOTATION = /:\s*[A-Z][\w.]*(?:\[\]|<|\s*=|\s*\||[,;)]|$)/;

const SHELL_WORDS = [
  "cd ",
  "ls",
  "echo ",
  "export ",
  "sudo ",
  "git ",
  "npm ",
  "pnpm ",
  "yarn ",
  "curl ",
  "chmod ",
  "chown ",
  "mkdir ",
  "cp ",
  "mv ",
  "rm ",
  "docker ",
  "systemctl ",
  "journalctl ",
  "apt ",
  "brew ",
  "ssh ",
  "cat ",
  "grep ",
  "find ",
];

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim());
}

function isJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isPython(all: string[]): boolean {
  return all.some(
    (line) =>
      line.startsWith("def ") ||
      line.startsWith("elif ") ||
      line.startsWith("print(") ||
      line.startsWith("from ") ||
      line.startsWith("self.") ||
      (line.startsWith("import ") && !line.includes(";") && !line.includes('"')),
  );
}

function isShell(all: string[]): boolean {
  const first = all[0] ?? "";
  if (first.startsWith("$ ") || first.startsWith("#!")) return true;
  if (all.some((line) => line.includes(";") || line.includes("{") || line.includes("=>")))
    return false;
  return all.every((line) => SHELL_WORDS.some((word) => line.startsWith(word)));
}

/** The language a run of code reads as, for the fence's label. */
function inferLanguage(code: string): Language {
  const all = lines(code).filter((line) => line !== "");
  const text = all.join("\n");
  const tag = /<\/?[A-Za-z][\w-]*(?:\s|\/?>)/.test(text);
  const element = /<[A-Z][\w.]*[\s/>]|<\/[A-Z][\w.]*>/.test(text);
  // Lowercase tags are JSX too when a statement carries them; alone they are markup.
  const statement = /\b(?:const|let|var|function|return|import|export)\b|=>/.test(text);
  const jsx = tag && (element || statement);
  const typescript = TYPESCRIPT.some((sign) => text.includes(sign)) || TYPE_ANNOTATION.test(text);
  if (jsx) return typescript ? "tsx" : "jsx";
  if (typescript) return "ts";
  if (isPython(all)) return "python";
  if (isShell(all)) return "bash";
  if (tag) return "html";
  if (isJson(text)) return "json";
  return "js";
}

// --- finding runs -----------------------------------------------------------------------

type Run = { start: number; end: number; code: string };

/** The common indent of a run's non-blank lines, which the fence drops. */
function commonIndent(runLines: string[]): number {
  let indent = -1;
  for (const line of runLines) {
    if (line.trim() === "") continue;
    const own = indentOf(line);
    if (indent < 0 || own < indent) indent = own;
  }
  return Math.max(indent, 0);
}

function dedent(runLines: string[]): string {
  const indent = commonIndent(runLines);
  if (indent === 0) return runLines.join("\n");
  return runLines.map((line) => (line.trim() === "" ? "" : line.slice(indent))).join("\n");
}

/**
 * The run of code that starts at `at`, or nothing when that line does not start code. Lines
 * continue while they read as code, or while a bracket they are inside is still open.
 */
function readRun(text: string, at: number, limit: number): Run | undefined {
  const first = text.slice(at, lineEnd(text, at, limit));
  const firstTrimmed = first.trim();
  if (!startsCode(firstTrimmed)) return undefined;

  const kept: { line: string; end: number }[] = [];
  let depth = 0;
  let at2 = at;
  while (at2 < limit) {
    const lineStop = lineEnd(text, at2, limit);
    const line = text.slice(at2, lineStop);
    const trimmed = line.trim();
    const continues =
      kept.length > 0 && (startsCode(trimmed) || continuesCode(line, trimmed, depth > 0));
    if (kept.length > 0 && !continues) break;
    kept.push({ line, end: lineStop });
    if (trimmed !== "") depth = depthAfter(line, depth);
    at2 = lineStop + 1;
  }
  // Blank lines belong between statements, not after the last one.
  while (kept.length > 0 && (kept[kept.length - 1]?.line ?? "").trim() === "") kept.pop();
  if (kept.length === 0) return undefined;
  const runLines = kept.map((entry) => entry.line);
  const end = kept[kept.length - 1]?.end ?? at;
  const code = dedent(runLines);
  if (code.trim().length < MINIMUM_RUN) return undefined;
  // Code still arriving has not closed its brackets yet; a finished run must.
  const atTextEnd = end >= text.length || text.slice(end).trim() === "";
  if (depth !== 0 && !atTextEnd) return undefined;
  if (depth !== 0 && !/[[({,=>]$/.test(runLines.join("\n").trimEnd())) return undefined;
  if (runLines.length === 1 && !hasSyntax(code)) return undefined;
  return { start: at, end, code };
}

/** Every fenced code block in the text, the one that never closed running to the end. */
function fences(text: string): Fence[] {
  const blocks: Fence[] = [];
  let at = 0;
  while (at < text.length) {
    const end = lineEnd(text, at, text.length);
    const trimmed = text.slice(at, end).trimStart();
    const marker = trimmed[0];
    let count = 0;
    while (trimmed[count] === marker && (marker === "`" || marker === "~")) count++;
    if (count < 3 || indentOf(text.slice(at, end)) > 3) {
      at = end + 1;
      continue;
    }
    let searchAt = end + 1;
    let close: number | undefined;
    while (searchAt < text.length) {
      const closeEnd = lineEnd(text, searchAt, text.length);
      const closeLine = text.slice(searchAt, closeEnd).trim();
      let run = 0;
      while (closeLine[run] === marker) run++;
      if (run >= count && closeLine.slice(run).trim() === "") {
        close = closeEnd + 1;
        break;
      }
      searchAt = closeEnd + 1;
    }
    if (close === undefined) {
      blocks.push({ start: at, end: text.length, closed: false });
      break;
    }
    blocks.push({ start: at, end: close, closed: true });
    at = close;
  }
  return blocks;
}

// --- writing the message ----------------------------------------------------------------

/** A fence one backtick longer than any run of backticks in the code, so it always closes. */
function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function fencedCode(code: string): string {
  const fence = fenceFor(code);
  return `${fence}${inferLanguage(code)}\n${code}\n${fence}`;
}

/** Where the whitespace around a replaced run ends, so its blank lines are not doubled. */
function regionStart(text: string, at: number, floor: number): number {
  let i = at;
  while (i > floor && isSpace(text[i - 1])) i--;
  return i;
}

function regionEnd(text: string, at: number, ceiling: number): number {
  let i = at;
  while (i < ceiling && isSpace(text[i])) i++;
  return i;
}

/** Markdown between `from` and `to`: each run of code replaced by a fenced block. */
function blockEdits(text: string, from: number, to: number, edits: Edit[]): void {
  let at = from;
  while (at < to) {
    const run = readRun(text, at, to);
    if (run) {
      edits.push({
        from: regionStart(text, run.start, from),
        to: regionEnd(text, run.end, to),
        text: fencedCode(run.code),
      });
      at = run.end < to ? lineEnd(text, run.end, to) + 1 : to;
      continue;
    }
    at = lineEnd(text, at, to) + 1;
  }
}

/** The block, on its own lines, after whatever came before it. */
function appendBlock(out: string, block: string, after: boolean): string {
  const end = after ? "\n\n" : "\n";
  if (out.length === 0) return `${block}${end}`;
  if (out.endsWith("\n\n")) return `${out}${block}${end}`;
  if (out.endsWith("\n")) return `${out}\n${block}${end}`;
  return `${out}\n\n${block}${end}`;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    const from = Math.max(edit.from, cursor);
    const to = Math.max(edit.to, from);
    out += text.slice(cursor, from);
    out = appendBlock(out, edit.text, to < text.length);
    cursor = to;
  }
  return out + text.slice(cursor);
}

/**
 * The message with each run of unfenced code in a fenced block, or the message unchanged when
 * it carries no such run. A line already in a fence is never read again.
 */
export function codeBlockMarkdown(text: string): string {
  if (text.length < MINIMUM_RUN) return text;
  // The fastest thing to rule out: no line can start a statement without one of these.
  if (
    !text.includes("=") &&
    !text.includes("(") &&
    !text.includes("{") &&
    !text.includes("[") &&
    !text.includes("<") &&
    !text.includes(";") &&
    !text.includes("$")
  ) {
    return text;
  }
  const edits: Edit[] = [];
  let cursor = 0;
  for (const fence of fences(text)) {
    blockEdits(text, cursor, fence.start, edits);
    // A fence that is still open (a streamed reply) is left alone to the end.
    cursor = fence.end;
    if (!fence.closed) return text;
  }
  blockEdits(text, cursor, text.length, edits);
  return applyEdits(text, edits);
}
