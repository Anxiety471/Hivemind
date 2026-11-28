import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { driveTools } from "./run-tools-drive.js";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    name,
    args,
    executionId: "exec-1",
    finish: (result: unknown) => result,
  } as unknown as ToolCall;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** A deflated ZIP archive, written here so the adapters package needs no ZIP library. */
function makeZip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, nameBuffer, data]);
    locals.push(entry);
    centrals.push(Buffer.concat([central, nameBuffer]));
    offset += entry.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const SHEET_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** A one-page PDF whose content stream is `stream` (empty for an image-only page). */
function makePdf(stream: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function driveDocumentContext(
  file: { mimeType: string; size: number; bytes: Uint8Array },
  secrets: string[] = [],
) {
  const findFirst = vi.fn().mockResolvedValue({
    id: "f-doc",
    name: "report",
    slug: "report",
    description: null,
    mimeType: file.mimeType,
    size: file.size,
    storageKey: "blob-doc",
    folderId: null,
    version: 1,
  });
  const get = vi.fn().mockResolvedValue(file.bytes);
  const ctx = {
    bot: { id: "bot-1" },
    run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
    secrets,
    computer: { mode: "team", get: vi.fn() },
    context: { signal: new AbortController().signal },
    deps: {
      prisma: { artifact: { findFirst } },
      artifacts: { get },
      sandbox: { writeFile: vi.fn() },
    },
  } as unknown as RunContext;
  return { ctx, get };
}

async function readDocument(
  file: { mimeType: string; size: number; bytes: Uint8Array },
  args: Record<string, unknown> = {},
  secrets: string[] = [],
): Promise<Record<string, unknown>> {
  const { ctx } = driveDocumentContext(file, secrets);
  return (await driveTools.drive_read!(
    ctx,
    makeCall("drive_read", { file_id: "f-doc", ...args }),
  )) as Record<string, unknown>;
}

describe("drive_read document text", () => {
  it("returns headings, tables and text from a DOCX", async () => {
    const bytes = makeZip({
      "word/document.xml": `<w:document ${WORD_NS}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue &amp; costs rose.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
    });
    const result = await readDocument({ mimeType: DOCX_MIME, size: bytes.byteLength, bytes });
    expect(result).toMatchObject({
      fileId: "f-doc",
      extractedFormat: "docx",
      truncated: false,
      paragraphs: 4,
      tables: 1,
    });
    expect(result.binary).toBeUndefined();
    expect(result.content).toBe(
      "# Quarterly report\n\nRevenue & costs rose.\n\n| Region | Sales |\n| --- | --- |",
    );
  });

  it("returns sheets with their rows from an XLSX", async () => {
    const bytes = makeZip({
      "xl/workbook.xml": `<workbook ${SHEET_NS}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": `<sst ${SHEET_NS}><si><t>Item</t></si><si><t>Cost</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${SHEET_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>7</v></c><c r="B2"><f>A2*2</f><v>14</v></c></row></sheetData></worksheet>`,
    });
    const result = await readDocument({ mimeType: XLSX_MIME, size: bytes.byteLength, bytes });
    expect(result).toMatchObject({ extractedFormat: "xlsx", sheets: 1, formulas: 1 });
    expect(result.content).toBe("## Budget\n\n| Item | Cost |\n| 7 | 14 |");
  });

  it("returns numbered slides and their speaker notes from a PPTX", async () => {
    const slide = (text: string) =>
      `<p:sld ${DRAWING_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const bytes = makeZip({
      "ppt/slides/slide2.xml": slide("Second"),
      "ppt/slides/slide1.xml": slide("Opening"),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes ${DRAWING_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Pause here</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    });
    const result = await readDocument({ mimeType: PPTX_MIME, size: bytes.byteLength, bytes });
    expect(result).toMatchObject({ extractedFormat: "pptx", slides: 2, notes: 1 });
    expect(result.content).toBe(
      "## Slide 1\n\nOpening\n\n### Speaker notes\n\nPause here\n\n## Slide 2\n\nSecond",
    );
  });

  it("returns the text of a PDF that has a text layer", async () => {
    const bytes = makePdf("BT /F1 18 Tf 20 80 Td (Hello PDF text) Tj ET");
    const result = await readDocument({
      mimeType: "application/pdf",
      size: bytes.byteLength,
      bytes,
    });
    expect(result).toMatchObject({ extractedFormat: "pdf", pages: 1, truncated: false });
    expect(result.content).toBe("Hello PDF text");
    expect(result.binary).toBeUndefined();
  });

  it("falls back to a binary note for a scanned PDF with no text layer", async () => {
    const bytes = makePdf("");
    const result = await readDocument({
      mimeType: "application/pdf",
      size: bytes.byteLength,
      bytes,
    });
    expect(result).toMatchObject({ binary: true, mimeType: "application/pdf" });
    expect(String(result.note)).toContain("No readable text");
    expect(result.content).toBeUndefined();
  });

  it("falls back to a binary note for a document declared over the 10 MiB bound", async () => {
    const bytes = makePdf("BT /F1 18 Tf 20 80 Td (Not extracted) Tj ET");
    const result = await readDocument({
      mimeType: "application/pdf",
      size: 11 * 1024 * 1024,
      bytes,
    });
    expect(result).toMatchObject({ binary: true, size: 11 * 1024 * 1024 });
    expect(result.content).toBeUndefined();
  });

  it("falls back to a binary note when the stored bytes outgrow the declared size", async () => {
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(new TextEncoder().encode("%PDF-1.4"));
    const result = await readDocument({ mimeType: "application/pdf", size: 1024, bytes: huge });
    expect(result).toMatchObject({ binary: true });
  });

  it("falls back to a binary note for a corrupt DOCX", async () => {
    const result = await readDocument({
      mimeType: DOCX_MIME,
      size: 12,
      bytes: new TextEncoder().encode("not a zip!!"),
    });
    expect(result).toMatchObject({ binary: true });
  });

  it("redacts secrets from extracted document text", async () => {
    const bytes = makeZip({
      "word/document.xml": `<w:document ${WORD_NS}><w:body><w:p><w:r><w:t>Token SECRET_TOKEN_123 here</w:t></w:r></w:p></w:body></w:document>`,
    });
    const result = await readDocument({ mimeType: DOCX_MIME, size: bytes.byteLength, bytes }, {}, [
      "SECRET_TOKEN_123",
    ]);
    expect(String(result.content)).not.toContain("SECRET_TOKEN_123");
    expect(String(result.content)).toContain("Token");
  });

  it("cuts extracted text to max_bytes of UTF-8 and marks it truncated", async () => {
    const bytes = makeZip({
      "word/document.xml": `<w:document ${WORD_NS}><w:body><w:p><w:r><w:t>${"é".repeat(40)}</w:t></w:r></w:p></w:body></w:document>`,
    });
    const result = await readDocument(
      { mimeType: DOCX_MIME, size: bytes.byteLength, bytes },
      { max_bytes: 25 },
    );
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(String(result.content)).byteLength).toBeLessThanOrEqual(25);
    expect(String(result.content)).not.toContain("\uFFFD");
  });
});

describe("driveTools", () => {
  it("lists non-trashed folders and deduplicates latest file versions", async () => {
    const findFolders = vi.fn().mockResolvedValue([
      {
        id: "fold-1",
        parentId: null,
        name: "Videos",
        updatedAt: new Date("2026-11-22T00:00:00Z"),
      },
    ]);
    const findArtifacts = vi.fn().mockResolvedValue([
      {
        id: "art-v2",
        folderId: null,
        botId: "bot-1",
        source: "bot",
        name: "deploy.sh",
        description: null,
        mimeType: "application/x-sh",
        size: 40,
        version: 2,
        rootArtifactId: "art-v1",
        updatedAt: new Date("2026-11-22T01:00:00Z"),
      },
      {
        id: "art-v1",
        folderId: null,
        botId: "bot-1",
        source: "bot",
        name: "deploy.sh",
        description: null,
        mimeType: "application/x-sh",
        size: 20,
        version: 1,
        rootArtifactId: null,
        updatedAt: new Date("2026-11-22T00:00:00Z"),
      },
    ]);
    const ctx = {
      bot: { id: "bot-1" },
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma: {
          fileFolder: { findMany: findFolders },
          artifact: { findMany: findArtifacts },
        },
      },
    } as unknown as RunContext;

    const result = (await driveTools.drive_list!(
      ctx,
      makeCall("drive_list", { category: "code" }),
    )) as {
      folders: unknown[];
      files: Array<{ id: string; version: number }>;
    };
    expect(result.folders).toHaveLength(1);
    expect(result.files).toEqual([expect.objectContaining({ id: "art-v2", version: 2 })]);
  });

  it("reads text preview with redaction and copies large binary files to workspace", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "f-sh",
        name: "setup.sh",
        mimeType: "application/x-sh",
        size: 28,
        storageKey: "blob-sh",
        folderId: null,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "f-mp4",
        name: "clip.mp4",
        mimeType: "video/mp4",
        size: 30_000_000,
        storageKey: "blob-mp4",
        folderId: null,
        version: 1,
      });
    const get = vi
      .fn()
      .mockResolvedValueOnce(new TextEncoder().encode("echo SECRET_TOKEN_123"))
      .mockResolvedValueOnce(new Uint8Array([0, 0, 0, 24]));
    const ctx = {
      bot: { id: "bot-1" },
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: ["SECRET_TOKEN_123"],
      computer: { mode: "team", get: vi.fn().mockResolvedValue({ providerRef: "sb-1" }) },
      context: { signal: new AbortController().signal },
      deps: {
        prisma: { artifact: { findFirst } },
        artifacts: { get },
        sandbox: { writeFile },
      },
    } as unknown as RunContext;

    const preview = (await driveTools.drive_read!(
      ctx,
      makeCall("drive_read", { file_id: "f-sh" }),
    )) as {
      content: string;
    };
    expect(preview.content).not.toContain("SECRET_TOKEN_123");

    const copied = (await driveTools.drive_read!(
      ctx,
      makeCall("drive_read", { file_id: "f-mp4", save_to_workspace: "videos/clip.mp4" }),
    )) as { ok: boolean; savedTo: string };
    expect(copied).toMatchObject({ ok: true, savedTo: "videos/clip.mp4" });
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("saves inline text scripts into Space Drive with version resolution", async () => {
    const put = vi.fn().mockResolvedValue({ id: "blob-new", hash: "abc" });
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: "art-new",
      ...data,
    }));
    const publishSpaceChange = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    };
    const ctx = {
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      source: {},
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma: {
          $transaction: vi.fn().mockImplementation(async (fn) => fn(tx)),
        },
        artifacts: { put, remove: vi.fn() },
        events: { publishSpaceChange },
      },
    } as unknown as RunContext;

    const saved = (await driveTools.drive_save!(
      ctx,
      makeCall("drive_save", { name: "build.sh", content: "#!/bin/sh\necho hi\n" }),
    )) as { ok: boolean; fileId: string; mimeType: string };
    expect(saved).toMatchObject({ ok: true, fileId: "art-new", mimeType: "application/x-sh" });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      source: "bot",
      mimeType: "application/x-sh",
    });
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "files");
  });

  it("auto-places drive_save in the bot folder with a slug and supports drive_create_folder, drive_move, and drive_update", async () => {
    const publishSpaceChange = vi.fn();
    const put = vi.fn().mockResolvedValue({ id: "blob-2", hash: "hash-2" });
    const createFolder = vi
      .fn()
      .mockResolvedValueOnce({ id: "bot-folder-1", name: "Ops Bot" })
      .mockResolvedValueOnce({
        id: "folder-dest",
        name: "Specs",
        parentId: null,
      });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "file-2",
      name: "deploy-notes.md",
      slug: "deploy-notes",
      description: "Deploy checklist",
      folderId: "bot-folder-1",
      mimeType: "text/markdown",
      size: 12,
      version: 1,
      updatedAt: new Date("2026-11-23T00:00:00.000Z"),
    });
    const updateManyArtifact = vi.fn().mockResolvedValue({ count: 1 });
    const fileFolder = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "folder-dest", trashedAt: null }),
      updateMany: vi.fn(),
      create: createFolder,
    };
    const botModel = {
      findFirst: vi.fn().mockResolvedValue({ name: "Ops Bot", userId: "user-1" }),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "file-2", rootArtifactId: null, trashedAt: null })
          .mockResolvedValueOnce({
            id: "file-2",
            name: "deploy-renamed.md",
            slug: "deploy-v2",
            description: "Updated checklist",
            folderId: "folder-dest",
            version: 1,
          }),
        updateMany: updateManyArtifact,
        create: createArtifact,
      },
      fileFolder,
      bot: botModel,
    };
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      artifact: {
        findMany,
        findFirst: tx.artifact.findFirst,
        updateMany: updateManyArtifact,
      },
      fileFolder,
      bot: botModel,
      $transaction: vi.fn().mockImplementation(async (fn) => fn(tx)),
    };
    const ctx = {
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      source: {},
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma,
        artifacts: { put, remove: vi.fn() },
        events: { publishSpaceChange },
      },
    } as unknown as RunContext;

    const saved = (await driveTools.drive_save!(
      ctx,
      makeCall("drive_save", {
        name: "deploy-notes.md",
        description: "Deploy checklist",
        content: "# Checklist",
      }),
    )) as { folderId: string | null; slug: string | null };
    expect(saved).toMatchObject({ folderId: "bot-folder-1", slug: "deploy-notes" });
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-1", name: "Ops Bot" }),
      }),
    );

    const createdFolder = (await driveTools.drive_create_folder!(
      ctx,
      makeCall("drive_create_folder", { name: "Specs" }),
    )) as { ok: boolean; created: boolean; folder: { id: string; name: string } };
    expect(createdFolder).toMatchObject({
      ok: true,
      created: true,
      folder: { id: "folder-dest", name: "Specs" },
    });

    const moved = (await driveTools.drive_move!(
      ctx,
      makeCall("drive_move", { file_id: "file-2", destination_folder_id: "folder-dest" }),
    )) as { ok: boolean; fileId: string; folderId: string | null };
    expect(moved).toMatchObject({ ok: true, fileId: "file-2", folderId: "folder-dest" });

    const updated = (await driveTools.drive_update!(
      ctx,
      makeCall("drive_update", {
        file_id: "file-2",
        name: "deploy-renamed.md",
        slug: "Deploy v2",
        description: "Updated checklist",
      }),
    )) as { ok: boolean; name: string; slug: string | null; description: string | null };
    expect(updated).toMatchObject({
      ok: true,
      name: "deploy-renamed.md",
      slug: "deploy-v2",
      description: "Updated checklist",
    });

    await driveTools.drive_list!(
      ctx,
      makeCall("drive_list", { query: "deploy-v2", bot_id: "bot-2" }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-2",
          OR: expect.arrayContaining([
            expect.objectContaining({ slug: { contains: "deploy-v2", mode: "insensitive" } }),
          ]),
        }),
      }),
    );
  });
});
