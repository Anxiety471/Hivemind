// Markdown parsing for agent replies: pure functions, no DOM, so they can be tested with bun or node.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "del"; v: Inline[] }
  | { t: "link"; href: string; v: Inline[] }
  | { t: "math"; v: string }
  | { t: "br" };

export type TableAlign = "left" | "center" | "right" | null;
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export type ListItem = {
  checked: boolean | null;
  body: Block[];
};

export type Block =
  | { t: "heading"; level: number; v: Inline[] }
  | { t: "paragraph"; v: Inline[] }
  | { t: "code"; lang: string; v: string; open?: true }
  | { t: "math"; v: string }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; v: Block[] }
  | { t: "alert"; kind: AlertKind; title?: string; v: Block[] }
  | { t: "table"; align: TableAlign[]; headers: Inline[][]; rows: Inline[][][] }
  | { t: "think"; v: Block[] }
  | { t: "details"; summary: string; v: Block[] }
  | { t: "hr" };
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
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
    if (rest[0] === "\\" && /[\\`*_{}[\]()#+\-.!~>|$]/.test(rest[1] ?? "")) {
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
    } else if ((m = /^\$(?!\s)([^\$\n]+?\S|\S)\$(?!\d)/.exec(rest))) {
      if (!/^\d+(\.\d{2})?$/.test(m[1])) {
        flush();
        out.push({ t: "math", v: m[1] });
        i += m[0].length;
      } else {
        text += "$";
        i += 1;
      }
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
    if (INDENTED_CODE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (!lines[i].trim() || INDENTED_CODE.test(lines[i]))) {
        body.push(lines[i].replace(INDENTED_CODE, ""));
        i++;
      }
      while (body.length && !body.at(-1)!.trim()) body.pop();
      blocks.push({ t: "code", lang: "", v: body.join("\n") });
    } else if ((m = FENCE.exec(line))) {
      const marker = m[1];
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end, as it does while a reply is still streaming; `open`
      // tells renderers the content is still incomplete.
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      const v = body.join("\n");
      blocks.push(i >= lines.length ? { t: "code", lang: m[2], v, open: true } : { t: "code", lang: m[2], v });
      i++;
    } else if (line.startsWith("$$")) {
      const rest = line.slice(2).trim();
      if (rest.endsWith("$$") && rest.length > 2) {
        blocks.push({ t: "math", v: rest.slice(0, -2).trim() });
        i++;
      } else {
        const body: string[] = [];
        if (rest) body.push(rest);
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("$$")) {
          body.push(lines[i++]);
        }
        if (i < lines.length && lines[i].trim().startsWith("$$")) i++;
        blocks.push({ t: "math", v: body.join("\n").trim() });
      }
    } else if (/^ {0,3}<think\b[^>]*>/i.test(line)) {
      const body: string[] = [];
      let first = line.replace(/^ {0,3}<think\b[^>]*>/i, "");
      if (first.includes("</think>")) {
        const [inside] = first.split("</think>");
        blocks.push({ t: "think", v: parseBlocks(inside.trim().split("\n")) });
        i++;
      } else {
        if (first.trim()) body.push(first);
        i++;
        while (i < lines.length && !lines[i].includes("</think>")) {
          body.push(lines[i++]);
        }
        if (i < lines.length && lines[i].includes("</think>")) {
          const [inside] = lines[i].split("</think>");
          if (inside.trim()) body.push(inside);
          i++;
        }
        blocks.push({ t: "think", v: parseBlocks(body) });
      }
    } else if (/^ {0,3}<details\b[^>]*>/i.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].includes("</details>")) {
        body.push(lines[i++]);
      }
      if (i < lines.length && lines[i].includes("</details>")) i++;
      let summary = "Details";
      const full = body.join("\n");
      const sumMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(full);
      let content = full;
      if (sumMatch) {
        summary = sumMatch[1].trim();
        content = full.replace(sumMatch[0], "").trim();
      }
      blocks.push({ t: "details", summary, v: parseBlocks(content.split("\n")) });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ t: "heading", level: m[1].length, v: parseInline(m[2]) });
      i++;
    } else if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i.exec(inner[0] ?? "");
      if (alertMatch) {
        const kind = alertMatch[1].toLowerCase() as AlertKind;
        const title = alertMatch[2]?.trim() || undefined;
        const rest = inner.slice(1);
        blocks.push({ t: "alert", kind, title, v: parseBlocks(rest.length ? rest : [""]) });
      } else {
        blocks.push({ t: "quote", v: parseBlocks(inner) });
      }
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      const result = parseList(lines, i);
      blocks.push(result.block);
      i = result.next;
    } else if (isTable(lines, i)) {
      const result = parseTable(lines, i);
      blocks.push(result.block);
      i = result.next;
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !FENCE.test(lines[i]) &&
        !lines[i].startsWith("$$") &&
        !/^ {0,3}<(think|details)\b/i.test(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !HR.test(lines[i]) &&
        !QUOTE.test(lines[i]) &&
        !isTable(lines, i) &&
        !(para.length && (BULLET.test(lines[i]) || ORDERED.test(lines[i])))
      )
        para.push(lines[i++]);
      blocks.push({ t: "paragraph", v: parseInline(para.map((l) => l.trimStart()).join("\n")) });
    }
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start])!;
  const ordered = !BULLET.test(lines[start]);
  const base = first[1].length;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = (ordered ? ORDERED : BULLET).exec(lines[i]);
    if (!m || m[1].length !== base) {
      // Anything that is not another item at this level ends the list unless it is indented content.
      break;
    }
    let raw = m[3];
    let checked: boolean | null = null;
    const taskMatch = /^\[([ xX])\](?:\s+(.*))?$/.exec(raw);
    if (taskMatch) {
      checked = taskMatch[1].toLowerCase() === "x";
      raw = taskMatch[2] ?? "";
    }
    const content = [raw];
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
    items.push({ checked, body: parseBlocks(content) });
    // Skip blank lines between items of the same list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const again = (ordered ? ORDERED : BULLET).exec(lines[j] ?? "");
    if (again && again[1].length === base) i = j;
  }
  return { block: { t: "list", ordered, start: ordered ? Number(first[2]) : 1, items }, next: i };
}

const TABLE_DELIM_CELL = /^:?-+:?$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) {
    let slashes = 0;
    for (let j = s.length - 2; j >= 0 && s[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && s[i + 1] === "|") {
      current += "\\|";
      i += 2;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      i++;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  cells.push(current.trim());
  return cells;
}

function isTable(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  const header = lines[i].trim();
  if (!header || !header.includes("|")) return false;
  if (FENCE.test(header) || HEADING.test(header) || HR.test(header) || QUOTE.test(header)) {
    return false;
  }
  const delim = lines[i + 1].trim();
  if (!delim.includes("-")) return false;
  const delimCells = splitTableRow(delim);
  if (delimCells.length === 0) return false;
  if (delimCells.length === 1 && (!delim.startsWith("|") || !delim.endsWith("|"))) return false;
  if (!delimCells.every((c) => TABLE_DELIM_CELL.test(c))) return false;
  return splitTableRow(header).length > 0;
}

function parseTable(lines: string[], start: number): { block: Block; next: number } {
  const headerLine = lines[start];
  const delimLine = lines[start + 1];
  const delimCells = splitTableRow(delimLine);
  const colCount = delimCells.length;

  const align: TableAlign[] = delimCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  let rawHeaderCells = splitTableRow(headerLine);
  if (rawHeaderCells.length < colCount) {
    rawHeaderCells = rawHeaderCells.concat(new Array(colCount - rawHeaderCells.length).fill(""));
  } else if (rawHeaderCells.length > colCount) {
    rawHeaderCells = rawHeaderCells.slice(0, colCount);
  }
  const headers = rawHeaderCells.map((c) => parseInline(c));

  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) {
      break;
    }
    if (!line.includes("|")) {
      break;
    }
    let rawCells = splitTableRow(line);
    if (rawCells.length < colCount) {
      rawCells = rawCells.concat(new Array(colCount - rawCells.length).fill(""));
    } else if (rawCells.length > colCount) {
      rawCells = rawCells.slice(0, colCount);
    }
    rows.push(rawCells.map((c) => parseInline(c)));
    i++;
  }

  return {
    block: {
      t: "table",
      align,
      headers,
      rows,
    },
    next: i,
  };
}


