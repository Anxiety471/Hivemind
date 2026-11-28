import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractOfficeDocumentText,
  isExtractableOfficeMimeType,
  OFFICE_MAX_ARCHIVE_BYTES,
  OFFICE_MAX_ENTRIES,
  OFFICE_MAX_XML_BYTES,
} from "./extract-document-text.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const SHEET_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

function docx(body: string): Uint8Array {
  return zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${WORD_NS}><w:body>${body}</w:body></w:document>`,
  });
}

function para(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function xlsx(options: {
  sheets: Array<{ name: string; rId: string; target: string; xml: string }>;
  sharedStrings?: string[];
}): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook ${SHEET_NS}><sheets>${options.sheets
      .map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="${sheet.rId}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.sheets
      .map((sheet) => `<Relationship Id="${sheet.rId}" Target="${sheet.target}"/>`)
      .join("")}</Relationships>`,
  };
  if (options.sharedStrings) {
    files["xl/sharedStrings.xml"] = `<sst ${SHEET_NS}>${options.sharedStrings
      .map((text) => `<si><t>${text}</t></si>`)
      .join("")}</sst>`;
  }
  for (const sheet of options.sheets) {
    files[sheet.target.startsWith("/") ? sheet.target.slice(1) : `xl/${sheet.target}`] = sheet.xml;
  }
  return zip(files);
}

function sheetXml(rows: string): string {
  return `<worksheet ${SHEET_NS}><sheetData>${rows}</sheetData></worksheet>`;
}

function slide(paragraphs: string[], table?: string[][]): string {
  const shape = paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join("");
  const rows = (table ?? [])
    .map(
      (row) =>
        `<a:tr>${row.map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`,
    )
    .join("");
  const tableXml = table ? `<a:tbl><a:tblGrid/>${rows}</a:tbl>` : "";
  return `<p:sld ${DRAWING_NS}><p:cSld><p:spTree><p:sp><p:txBody>${shape}</p:txBody></p:sp>${tableXml}</p:spTree></p:cSld></p:sld>`;
}

function notes(text: string): string {
  return `<p:notes ${DRAWING_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
}

function pptx(files: Record<string, string>): Uint8Array {
  return zip({ "[Content_Types].xml": "<Types/>", ...files });
}

describe("isExtractableOfficeMimeType", () => {
  it("accepts the three OOXML types and nothing else", () => {
    expect(isExtractableOfficeMimeType(DOCX)).toBe(true);
    expect(isExtractableOfficeMimeType(XLSX)).toBe(true);
    expect(isExtractableOfficeMimeType(PPTX)).toBe(true);
    expect(isExtractableOfficeMimeType("application/pdf")).toBe(false);
    expect(isExtractableOfficeMimeType("application/msword")).toBe(false);
    expect(isExtractableOfficeMimeType("constructor")).toBe(false);
  });
});

describe("extractOfficeDocumentText: DOCX", () => {
  it("keeps paragraph order, maps heading styles to Markdown headings, and counts blocks", () => {
    const result = extractOfficeDocumentText(
      docx(
        para("Quarterly report", "Heading1") +
          para("Revenue grew.") +
          para("Details", "Heading2") +
          para("Costs fell."),
      ),
      DOCX,
    );
    expect(result).toEqual({
      format: "docx",
      text: "# Quarterly report\n\nRevenue grew.\n\n## Details\n\nCosts fell.",
      truncated: false,
      metadata: { paragraphs: 4, headings: 2 },
    });
  });

  it("renders tables as Markdown pipe tables with escaped pipes and padded rows", () => {
    const table =
      "<w:tbl><w:tr><w:tc>" +
      para("Item") +
      "</w:tc><w:tc>" +
      para("Price") +
      "</w:tc></w:tr><w:tr><w:tc>" +
      para("A|B") +
      "</w:tc></w:tr></w:tbl>";
    const result = extractOfficeDocumentText(docx(table), DOCX);
    expect(result?.text).toBe("| Item | Price |\n| --- | --- |\n| A\\|B |  |");
    expect(result?.metadata.tables).toBe(1);
  });

  it("escapes a cell's own backslash before its pipe, so the backslash cannot escape the pipe", () => {
    const table = `<w:tbl><w:tr><w:tc>${para("a\\b|c")}</w:tc></w:tr></w:tbl>`;
    const result = extractOfficeDocumentText(docx(table), DOCX);
    expect(result?.text).toBe("| a\\\\b\\|c |\n| --- |");
  });

  it("decodes predefined and numeric entities, and reads tabs and line breaks", () => {
    const body =
      "<w:p><w:r><w:t>Tom &amp; Jerry &lt;3 &quot;x&quot; &#65;&#x42;</w:t><w:tab/><w:t>end</w:t><w:br/><w:t>next</w:t></w:r></w:p>";
    const result = extractOfficeDocumentText(docx(body), DOCX);
    expect(result?.text).toBe('Tom & Jerry <3 "x" AB\tend\nnext');
  });

  it("reads paragraphs inside content controls and skips deleted text", () => {
    const body =
      "<w:sdt><w:sdtContent>" +
      para("Wrapped") +
      "</w:sdtContent></w:sdt><w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>";
    expect(extractOfficeDocumentText(docx(body), DOCX)?.text).toBe("Wrapped\n\nkept");
  });

  it("refuses a DTD, which is how entity-expansion attacks arrive", () => {
    const hostile = zip({
      "word/document.xml":
        '<!DOCTYPE w [<!ENTITY x "y">]><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(extractOfficeDocumentText(hostile, DOCX)).toBeNull();
  });
});

describe("extractOfficeDocumentText: XLSX", () => {
  it("resolves sheet names through the relationship targets and shared strings", () => {
    const bytes = xlsx({
      sharedStrings: ["Name", "Total"],
      sheets: [
        {
          name: "Summary",
          rId: "rId1",
          target: "worksheets/sheet1.xml",
          xml: sheetXml(
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
              '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c><c r="B2"><f>SUM(1,2)</f><v>3</v></c></row>',
          ),
        },
      ],
    });
    const result = extractOfficeDocumentText(bytes, XLSX);
    expect(result?.text).toBe("## Summary\n\n| Name | Total |\n| Ada | 3 |");
    expect(result?.metadata).toEqual({ sheets: 1, rows: 2, formulas: 1 });
  });

  it("keeps gaps inside the used range, drops trailing empty rows and cells, and maps booleans", () => {
    const bytes = xlsx({
      sheets: [
        {
          name: "Sheet A",
          rId: "rId1",
          target: "/xl/worksheets/sheet1.xml",
          xml: sheetXml(
            '<row r="1"><c r="A1"><v>1</v></c><c r="C1" t="b"><v>1</v></c></row>' +
              '<row r="2"><c r="B2" t="str"><f>"x"</f><v>text</v></c></row>' +
              '<row r="3"/><row r="4"><c r="A4"/></row>',
          ),
        },
      ],
    });
    expect(extractOfficeDocumentText(bytes, XLSX)?.text).toBe(
      "## Sheet A\n\n| 1 |  | TRUE |\n|  | text |  |",
    );
  });

  it("writes each sheet in workbook order and reads a sheet with no rows as its name only", () => {
    const bytes = xlsx({
      sheets: [
        {
          name: "First",
          rId: "rId1",
          target: "worksheets/sheet1.xml",
          xml: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>'),
        },
        { name: "Empty", rId: "rId2", target: "worksheets/sheet2.xml", xml: sheetXml("") },
      ],
    });
    expect(extractOfficeDocumentText(bytes, XLSX)?.text).toBe("## First\n\n| 7 |\n\n## Empty");
  });
});

describe("extractOfficeDocumentText: PPTX", () => {
  it("orders slides numerically, not lexically, and adds speaker notes", () => {
    const bytes = pptx({
      "ppt/slides/slide10.xml": slide(["Tenth"]),
      "ppt/slides/slide2.xml": slide(["Second"]),
      "ppt/slides/slide1.xml": slide(["First", "Opening line"]),
      "ppt/notesSlides/notesSlide2.xml": notes("Say it slowly"),
    });
    const result = extractOfficeDocumentText(bytes, PPTX);
    expect(result?.text).toBe(
      "## Slide 1\n\nFirst\n\nOpening line\n\n## Slide 2\n\nSecond\n\n### Speaker notes\n\nSay it slowly\n\n## Slide 10\n\nTenth",
    );
    expect(result?.metadata).toMatchObject({ slides: 3, notes: 1 });
  });

  it("renders slide tables as Markdown", () => {
    const bytes = pptx({
      "ppt/slides/slide1.xml": slide(
        [],
        [
          ["Region", "Sales"],
          ["North", "10"],
        ],
      ),
    });
    expect(extractOfficeDocumentText(bytes, PPTX)?.text).toBe(
      "## Slide 1\n\n| Region | Sales |\n| --- | --- |\n| North | 10 |",
    );
  });
});

describe("extractOfficeDocumentText: bounds and bad input", () => {
  it("cuts text at maxChars and says so", () => {
    const result = extractOfficeDocumentText(docx(para("abcdefghij")), DOCX, { maxChars: 4 });
    expect(result).toEqual({
      format: "docx",
      text: "abcd",
      truncated: true,
      metadata: { paragraphs: 1 },
    });
  });

  it("returns null for corrupt bytes, a missing main part, or an unsupported MIME type", () => {
    expect(extractOfficeDocumentText(strToU8("not a zip"), DOCX)).toBeNull();
    expect(extractOfficeDocumentText(zip({ "other.xml": "<a/>" }), DOCX)).toBeNull();
    expect(extractOfficeDocumentText(docx(para("x")), "text/plain")).toBeNull();
  });

  it("returns null for a document whose XML is malformed", () => {
    const broken = zip({ "word/document.xml": "<w:document><w:body><w:p></w:body>" });
    expect(extractOfficeDocumentText(broken, DOCX)).toBeNull();
  });

  it("refuses an archive over the size bound before reading it", () => {
    expect(OFFICE_MAX_ARCHIVE_BYTES).toBe(10 * 1024 * 1024);
    expect(
      extractOfficeDocumentText(new Uint8Array(OFFICE_MAX_ARCHIVE_BYTES + 1), DOCX),
    ).toBeNull();
  });

  it("refuses an archive with more entries than the bound", () => {
    const files: Record<string, Uint8Array> = { "word/document.xml": strToU8("<w:document/>") };
    for (let i = 0; i < OFFICE_MAX_ENTRIES; i++) files[`filler/${i}.txt`] = strToU8("x");
    expect(extractOfficeDocumentText(zipSync(files), DOCX)).toBeNull();
  });

  it("refuses a main part whose declared size is over the XML bound, even when it compresses well", () => {
    const huge = `<w:document ${WORD_NS}><w:body><w:p><w:r><w:t>${"a".repeat(OFFICE_MAX_XML_BYTES + 1)}</w:t></w:r></w:p></w:body></w:document>`;
    const bytes = zip({ "word/document.xml": huge });
    expect(bytes.byteLength).toBeLessThan(OFFICE_MAX_XML_BYTES / 100);
    expect(extractOfficeDocumentText(bytes, DOCX)).toBeNull();
  });

  it("still reads a part just under the XML bound", () => {
    const text = "b".repeat(1024);
    const bytes = zip({
      "word/document.xml": `<w:document ${WORD_NS}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect(extractOfficeDocumentText(bytes, DOCX)?.text).toBe(text);
  });
});
