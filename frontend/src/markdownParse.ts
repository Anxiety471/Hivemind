// Markdown parsing for agent replies: pure functions, no DOM, so they can be tested with node.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "del"; v: Inline[] }
  | { t: "link"; href: string; v: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: number; v: Inline[] }
  | { t: "paragraph"; v: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; v: Block[] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : null);

/** Inline spans: code, bold, italic, strikethrough, links. Unmatched markers stay literal. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === "\\" && /[\\`*_{}[\]()#+\-.!~>|]/.test(rest[1] ?? "")) {
      text += rest[1];
      i += 2;
    } else if ((m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      flush();
      out.push({ t: "code", v: m[2].replace(/^ (.*) $/, "$1") });
      i += m[0].length;
    } else if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      flush();
      out.push({ t: "strong", v: parseInline(m[2]) });
      i += m[0].length;
    } else if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush();
      out.push({ t: "del", v: parseInline(m[1]) });
      i += m[0].length;
    } else if (
      (m = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest)) ||
      (m = /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9_])/.exec(rest))
    ) {
      // `_` only opens an emphasis at a word start, so snake_case stays intact.
      if (m[0][0] === "_" && /[A-Za-z0-9]$/.test(text)) {
        text += rest[0];
        i += 1;
      } else {
        flush();
        out.push({ t: "em", v: parseInline(m[1]) });
        i += m[0].length;
      }
    } else if ((m = /^\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      const href = safeHref(m[2]);
      if (href) {
        flush();
        out.push({ t: "link", href, v: parseInline(m[1]) });
      } else text += m[0];
      i += m[0].length;
    } else if ((m = /^<(https?:\/\/[^\s>]+)>/.exec(rest))) {
      flush();
      out.push({ t: "link", href: m[1], v: [{ t: "text", v: m[1] }] });
      i += m[0].length;
    } else if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && !/[A-Za-z0-9]$/.test(text)) {
      flush();
      out.push({ t: "link", href: m[0], v: [{ t: "text", v: m[0] }] });
      i += m[0].length;
    } else if (rest.startsWith("  \n") || (rest[0] === "\\" && rest[1] === "\n")) {
      flush();
      out.push({ t: "br" });
      i += rest.startsWith("  \n") ? 3 : 2;
    } else {
      text += rest[0];
      i += 1;
    }
  }
  flush();
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Block structure: headings, fenced code, lists (nested by indentation), quotes, rules, paragraphs. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      const marker = m[1];
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end, as it does while a reply is still streaming.
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang: m[2], v: body.join("\n") });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ t: "heading", level: m[1].length, v: parseInline(m[2]) });
      i++;
    } else if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ t: "quote", v: parseBlocks(inner) });
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      const result = parseList(lines, i);
      blocks.push(result.block);
      i = result.next;
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !FENCE.test(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !HR.test(lines[i]) &&
        !QUOTE.test(lines[i]) &&
        !(para.length && (BULLET.test(lines[i]) || ORDERED.test(lines[i])))
      )
        para.push(lines[i++]);
      blocks.push({ t: "paragraph", v: parseInline(para.map((l) => l.trim()).join("\n")) });
    }
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start])!;
  const ordered = !BULLET.test(lines[start]);
  const base = first[1].length;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = (ordered ? ORDERED : BULLET).exec(lines[i]);
    if (!m || m[1].length !== base) {
      // Anything that is not another item at this level ends the list unless it is indented content.
      break;
    }
    const content = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line continues the item only when more indented content follows.
        const nextLine = lines.slice(i + 1).find((l) => l.trim());
        if (nextLine !== undefined && indentOf(nextLine) > base) {
          content.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(line) > base) {
        content.push(line.slice(Math.min(indentOf(line), base + 2)));
        i++;
      } else break;
    }
    items.push(parseBlocks(content));
    // Skip blank lines between items of the same list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const again = (ordered ? ORDERED : BULLET).exec(lines[j] ?? "");
    if (again && again[1].length === base) i = j;
  }
  return { block: { t: "list", ordered, start: ordered ? Number(first[2]) : 1, items }, next: i };
}

