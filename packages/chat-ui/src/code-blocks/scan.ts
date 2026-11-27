/**
 * What a line of a message is, and whether a message could hold unfenced code at all.
 *
 * `codeBlockMarkdown` in `code-blocks.ts` reads the code and rewrites the message, and weighs
 * enough that it is loaded with `import()` only when a message may need it. This module is the
 * cheap part both sides share: the line tests the reader decides with, and the scan that decides
 * whether to load it. Everything here stays in the startup code, so it may not import the reader.
 */

/** The shortest run worth a block: shorter text is a word, not code. */
export const MINIMUM_RUN = 8;

export function lineEnd(text: string, at: number, limit: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 || end > limit ? limit : end;
}

/** A line that begins a Markdown block: a heading, quote, list item, table row or fence. */
export function opensMarkdownBlock(trimmed: string): boolean {
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
const SYNTAX = /[[\]{}()<>"'`;:=]/;

export function hasSyntax(text: string): boolean {
  return SYNTAX.test(text);
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
export function startsCode(trimmed: string): boolean {
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

/**
 * Whether the message could hold a run of code the reader would fence, in one cheap pass. Every
 * run starts at a line `startsCode` accepts, so false means the reader is never loaded for this
 * text and never misses one; true only means the full reader gets a look, so it may also be said
 * of prose (a line of it that opens like code), which costs the chunk and nothing else.
 */
export function mayHaveCodeBlock(text: string): boolean {
  if (text.length < MINIMUM_RUN) return false;
  let at = 0;
  while (at < text.length) {
    const end = lineEnd(text, at, text.length);
    if (startsCode(text.slice(at, end).trim())) return true;
    at = end + 1;
  }
  return false;
}
