import { unzipSync } from "fflate";
import type { XmlElement } from "./xml-tree.js";
import {
  attributeNamed,
  childElements,
  descendantElements,
  localName,
  parseXmlTree,
  textOf,
} from "./xml-tree.js";

export type ExtractedOfficeFormat = "docx" | "xlsx" | "pptx";

export type ExtractedDocument = {
  format: ExtractedOfficeFormat;
  text: string;
  truncated: boolean;
  metadata: Record<string, number>;
};

/** Bounds for reading an office file: the archive, its entry count, and the XML read from it. */
export const OFFICE_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const OFFICE_MAX_ENTRIES = 500;
export const OFFICE_MAX_XML_BYTES = 4 * 1024 * 1024;

const MIME_FORMATS: Record<string, ExtractedOfficeFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function isExtractableOfficeMimeType(mimeType: string): boolean {
  return Object.hasOwn(MIME_FORMATS, mimeType.toLowerCase());
}

/** A file that is over one of the bounds above; it is reported as unreadable, not truncated. */
class OfficeLimitError extends Error {}

/**
 * Reads only the named parts of an office ZIP. The filter sees every central-directory entry
 * before any data is inflated, so entry count and declared sizes are checked first; fflate sizes
 * each output buffer from the declared size, so a bounded declaration bounds the memory too.
 */
function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, string> {
  if (bytes.byteLength > OFFICE_MAX_ARCHIVE_BYTES) throw new OfficeLimitError("archive too large");
  let entries = 0;
  let declaredTotal = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      entries += 1;
      if (entries > OFFICE_MAX_ENTRIES) throw new OfficeLimitError("too many entries");
      if (!wanted(file.name)) return false;
      if (file.compression !== 0 && file.compression !== 8) throw new OfficeLimitError("codec");
      declaredTotal += file.originalSize;
      if (declaredTotal > OFFICE_MAX_XML_BYTES) throw new OfficeLimitError("xml too large");
      return true;
    },
  });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parts = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    parts.set(name, decoder.decode(data));
  }
  return parts;
}

function parsePart(parts: Map<string, string>, name: string): XmlElement | null {
  const xml = parts.get(name);
  return xml === undefined ? null : parseXmlTree(xml);
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Markdown pipe table from rows of cell text; ragged rows are padded to the widest row. */
function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const lines = rows.map((row) => {
    const cells = Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ""));
    return `| ${cells.join(" | ")} |`;
  });
  lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  return lines.join("\n");
}

type Counter = Record<string, number>;

function bump(counter: Counter, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

// ---------------------------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------------------------

const HEADING_STYLE = /^heading\s?([1-6])$/i;

function docxParagraph(paragraph: XmlElement, counter: Counter): string {
  let text = "";
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      const local = localName(child.name);
      if (local === "del" || local === "instrText") continue;
      if (local === "t") text += textOf(child);
      else if (local === "tab") text += "\t";
      else if (local === "br" || local === "cr") text += "\n";
      else visit(child);
    }
  };
  visit(paragraph);
  const style = descendantElements(paragraph, "pStyle")[0];
  const styleId = style ? (attributeNamed(style, "val") ?? "") : "";
  const heading = HEADING_STYLE.exec(styleId.replace(/\s/g, ""));
  const trimmed = text.trim();
  if (!trimmed) return "";
  bump(counter, "paragraphs");
  if (heading) {
    bump(counter, "headings");
    return `${"#".repeat(Number(heading[1]))} ${trimmed}`;
  }
  return trimmed;
}

function docxCellText(cell: XmlElement, counter: Counter): string {
  return descendantElements(cell, "p")
    .map((paragraph) => docxParagraph(paragraph, counter))
    .filter(Boolean)
    .join(" ");
}

function docxTable(table: XmlElement, counter: Counter): string {
  bump(counter, "tables");
  const rows = childElements(table, "tr").map((row) =>
    childElements(row, "tc").map((cell) => docxCellText(cell, counter)),
  );
  return markdownTable(rows.filter((row) => row.length > 0));
}

/** Body blocks in document order; content controls (sdt) wrap them, so they are entered. */
function docxBlocks(node: XmlElement, counter: Counter, out: string[]): void {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    const local = localName(child.name);
    if (local === "p") {
      const block = docxParagraph(child, counter);
      if (block) out.push(block);
    } else if (local === "tbl") {
      const block = docxTable(child, counter);
      if (block) out.push(block);
    } else if (local === "sdt" || local === "sdtContent" || local === "body") {
      docxBlocks(child, counter, out);
    }
  }
}

function extractDocx(parts: Map<string, string>): ExtractedDocument | null {
  const root = parsePart(parts, "word/document.xml");
  if (!root) return null;
  const counter: Counter = {};
  const body = descendantElements(root, "body")[0] ?? root;
  const blocks: string[] = [];
  docxBlocks(body, counter, blocks);
  return { format: "docx", text: blocks.join("\n\n"), truncated: false, metadata: counter };
}

// ---------------------------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------------------------

function resolvePartPath(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function sharedStrings(parts: Map<string, string>): string[] {
  const root = parsePart(parts, "xl/sharedStrings.xml");
  if (!root) return [];
  return childElements(root, "si").map((item) => {
    let text = "";
    const visit = (node: XmlElement) => {
      for (const child of node.children) {
        if (typeof child === "string") continue;
        const local = localName(child.name);
        if (local === "rPh") continue;
        if (local === "t") text += textOf(child);
        else visit(child);
      }
    };
    visit(item);
    return text;
  });
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function rowIndex(reference: string): number {
  const digits = reference.replace(/^[A-Za-z]+/, "");
  return Math.max(0, Number(digits) - 1);
}

function cellValue(cell: XmlElement, strings: string[]): string {
  const type = cell.attributes.t ?? "n";
  const valueElement = childElements(cell, "v")[0];
  if (type === "inlineStr") {
    return descendantElements(cell, "t")
      .map((node) => textOf(node))
      .join("");
  }
  const value = valueElement ? textOf(valueElement) : "";
  if (type === "s") return strings[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
  return value;
}

function sheetTable(sheet: XmlElement, strings: string[], counter: Counter): string {
  const grid: string[][] = [];
  for (const row of descendantElements(sheet, "row")) {
    const index = rowIndex(row.attributes.r ?? String(grid.length + 1));
    const cells = grid[index] ?? [];
    let nextColumn = 0;
    for (const cell of childElements(row, "c")) {
      const reference = cell.attributes.r;
      const column = reference === undefined ? nextColumn : columnIndex(reference);
      nextColumn = column + 1;
      if (descendantElements(cell, "f").length > 0) bump(counter, "formulas");
      const value = cellValue(cell, strings);
      if (value !== "") cells[column] = value;
    }
    grid[index] = cells;
    bump(counter, "rows");
  }
  // Trailing empty rows and cells are dropped; gaps inside the used range keep their place.
  const rows: string[][] = [];
  for (let r = 0; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    let width = cells.length;
    while (width > 0 && !cells[width - 1]) width -= 1;
    rows.push(Array.from({ length: width }, (_, c) => cells[c] ?? ""));
  }
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  return rows
    .map((row) => {
      const padded = Array.from({ length: width }, (_, c) => escapeCell(row[c] ?? ""));
      return `| ${padded.join(" | ")} |`;
    })
    .join("\n");
}

function extractXlsx(parts: Map<string, string>): ExtractedDocument | null {
  const workbook = parsePart(parts, "xl/workbook.xml");
  if (!workbook) return null;
  const relations = new Map<string, string>();
  const rels = parsePart(parts, "xl/_rels/workbook.xml.rels");
  for (const relation of rels ? descendantElements(rels, "Relationship") : []) {
    const id = relation.attributes.Id;
    const target = relation.attributes.Target;
    if (id && target) relations.set(id, resolvePartPath(target));
  }
  const strings = sharedStrings(parts);
  const counter: Counter = {};
  const sections: string[] = [];
  for (const sheet of descendantElements(workbook, "sheet")) {
    const name = sheet.attributes.name ?? `Sheet${sections.length + 1}`;
    const relationId = Object.entries(sheet.attributes).find(
      ([key]) => key === "r:id" || key.endsWith(":id"),
    )?.[1];
    const path = relationId ? relations.get(relationId) : undefined;
    const worksheet = path ? parsePart(parts, path) : null;
    if (!worksheet) continue;
    bump(counter, "sheets");
    const table = sheetTable(worksheet, strings, counter);
    sections.push(table ? `## ${name}\n\n${table}` : `## ${name}`);
  }
  return { format: "xlsx", text: sections.join("\n\n"), truncated: false, metadata: counter };
}

// ---------------------------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------------------------

/** Paragraph text of a DrawingML element (a:p), skipping slide-number and date fields. */
function drawingParagraphs(node: XmlElement, out: string[], counter: Counter): void {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    const local = localName(child.name);
    if (local === "tbl") {
      bump(counter, "tables");
      const rows = descendantElements(child, "tr").map((row) =>
        childElements(row, "tc").map((cell) => {
          const paragraphs: string[] = [];
          drawingParagraphs(cell, paragraphs, {});
          return paragraphs.join(" ");
        }),
      );
      const table = markdownTable(rows.filter((row) => row.length > 0));
      if (table) out.push(table);
    } else if (local === "p") {
      let text = "";
      const visit = (run: XmlElement) => {
        for (const piece of run.children) {
          if (typeof piece === "string") continue;
          const name = localName(piece.name);
          if (name === "fld") continue;
          if (name === "t") text += textOf(piece);
          else if (name === "br") text += "\n";
          else visit(piece);
        }
      };
      visit(child);
      const trimmed = text.trim();
      if (trimmed) out.push(trimmed);
    } else {
      drawingParagraphs(child, out, counter);
    }
  }
}

function slideNumber(name: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d+)\\.xml$`).exec(name);
  return match ? Number(match[1]) : null;
}

function extractPptx(parts: Map<string, string>): ExtractedDocument | null {
  const slides = [...parts.keys()]
    .map((name) => ({ name, number: slideNumber(name, "ppt/slides/slide") }))
    .filter((entry): entry is { name: string; number: number } => entry.number !== null)
    .sort((a, b) => a.number - b.number);
  if (slides.length === 0) return null;
  const notes = new Map<number, string>();
  for (const name of parts.keys()) {
    const number = slideNumber(name, "ppt/notesSlides/notesSlide");
    if (number === null) continue;
    const root = parsePart(parts, name);
    if (!root) continue;
    const paragraphs: string[] = [];
    drawingParagraphs(root, paragraphs, {});
    if (paragraphs.length > 0) notes.set(number, paragraphs.join("\n"));
  }
  const counter: Counter = { slides: slides.length };
  const sections: string[] = [];
  for (const slide of slides) {
    const root = parsePart(parts, slide.name);
    if (!root) return null;
    const paragraphs: string[] = [];
    drawingParagraphs(root, paragraphs, counter);
    const body = [`## Slide ${slide.number}`];
    if (paragraphs.length > 0) body.push(paragraphs.join("\n\n"));
    const note = notes.get(slide.number);
    if (note) {
      bump(counter, "notes");
      body.push(`### Speaker notes\n\n${note}`);
    }
    sections.push(body.join("\n\n"));
  }
  return { format: "pptx", text: sections.join("\n\n"), truncated: false, metadata: counter };
}

// ---------------------------------------------------------------------------------------------

/**
 * Extracts readable text from a DOCX, XLSX or PPTX file. Returns null when the MIME type is not
 * one of those, or when the file is corrupt, over a bound, or missing its main part. Never
 * throws for bad input. Text is cut at `maxChars` (default: no cut) and `truncated` says so.
 */
export function extractOfficeDocumentText(
  bytes: Uint8Array,
  mimeType: string,
  options: { maxChars?: number } = {},
): ExtractedDocument | null {
  const format = MIME_FORMATS[mimeType.toLowerCase()];
  if (!format) return null;
  let parts: Map<string, string>;
  try {
    parts = readParts(bytes, (name) => isMainPart(format, name));
  } catch {
    // Corrupt ZIPs, bound breaches (OfficeLimitError) and unsupported codecs all end here.
    return null;
  }
  const extracted =
    format === "docx"
      ? extractDocx(parts)
      : format === "xlsx"
        ? extractXlsx(parts)
        : extractPptx(parts);
  if (!extracted) return null;
  const limit = options.maxChars;
  if (limit !== undefined && extracted.text.length > limit) {
    return { ...extracted, text: extracted.text.slice(0, Math.max(0, limit)), truncated: true };
  }
  return extracted;
}

function isMainPart(format: ExtractedOfficeFormat, name: string): boolean {
  if (format === "docx") return name === "word/document.xml";
  if (format === "xlsx") {
    return (
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name)
    );
  }
  return (
    /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)
  );
}
