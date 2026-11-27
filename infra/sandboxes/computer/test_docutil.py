"""Tests for docutil. Run: python3 -m unittest discover -s infra/sandboxes/computer -p 'test_docutil.py' -v

Office files are built here with zipfile, so the check runs without any document library. Tests
that need openpyxl, pypdf or poppler are skipped where those are absent and run in the image.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import docutil

HAS_OPENPYXL = False
try:
    import openpyxl  # type: ignore  # noqa: F401

    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False
HAS_PDF_TEXT = shutil.which("pdftotext") is not None
HAS_PDF_RENDER = shutil.which("pdftoppm") is not None

CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'


def write_zip(path: Path, files: dict[str, str], *, stored: bool = False) -> Path:
    method = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(path, "w", method) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return path


def docx_files(body: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    files = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="x" Target="word/document.xml"/></Relationships>',
        "word/document.xml": f"<w:document {W_NS}><w:body>{body}</w:body></w:document>",
    }
    files.update(extra or {})
    return files


def paragraph(text: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def pptx_files(slides: dict[int, str]) -> dict[str, str]:
    files = {
        "[Content_Types].xml": CONTENT_TYPES,
        "ppt/presentation.xml": f"<p:presentation {A_NS}/>",
    }
    for number, body in slides.items():
        files[f"ppt/slides/slide{number}.xml"] = f"<p:sld {A_NS}><p:cSld><p:spTree>{body}</p:spTree></p:cSld></p:sld>"
    return files


def slide_text(text: str) -> str:
    return f"<p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"


def minimal_pdf(stream: str = "BT /F1 18 Tf 20 80 Td (Hello PDF text) Tj ET") -> bytes:
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = "%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


def run_docutil(*argv: str) -> tuple[int, dict]:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = docutil.main(list(argv))
    return code, json.loads(buffer.getvalue())


class CheckOoxmlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-test-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def check(self, name: str, files: dict[str, str], **kwargs) -> tuple[int, dict]:
        path = write_zip(self.dir / name, files, **kwargs)
        return run_docutil("check", str(path))

    def test_valid_docx_passes_with_stats(self) -> None:
        code, report = self.check(
            "ok.docx",
            docx_files(
                '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>'
                + paragraph("Body text.")
                + "<w:tbl><w:tr><w:tc>" + paragraph("Cell") + "</w:tc></w:tr></w:tbl>"
            ),
        )
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])
        self.assertEqual(report["format"], "docx")
        self.assertEqual(report["stats"], {"paragraphs": 3, "headings": 1, "tables": 1, "media": 0})
        self.assertEqual(report["errors"], [])

    def test_template_tag_split_across_runs_is_an_error(self) -> None:
        body = "<w:p><w:r><w:t>Dear {{client</w:t></w:r><w:r><w:t>_name}},</w:t></w:r></w:p>"
        code, report = self.check("tags.docx", docx_files(body))
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])
        self.assertIn("unrendered template tag in word/document.xml: {{client_name}}", report["errors"])

    def test_placeholder_words_are_warnings_not_errors(self) -> None:
        code, report = self.check("todo.docx", docx_files(paragraph("TODO: pick a price. Lorem ipsum dolor.")))
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])
        self.assertIn("placeholder text in word/document.xml: TODO", report["warnings"])
        self.assertTrue(any("Lorem ipsum" in warning for warning in report["warnings"]))

    def test_empty_table_is_a_warning(self) -> None:
        body = paragraph("Intro") + "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>"
        code, report = self.check("empty-table.docx", docx_files(body))
        self.assertEqual(code, 0)
        self.assertIn("empty table 1", report["warnings"])

    def test_missing_media_target_is_an_error(self) -> None:
        rels = f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId9" Type="image" Target="media/image1.png"/></Relationships>'
        code, report = self.check(
            "media.docx",
            docx_files(paragraph("Logo"), extra={"word/_rels/document.xml.rels": rels}),
        )
        self.assertEqual(code, 1)
        self.assertTrue(any("missing relationship target word/media/image1.png" in e for e in report["errors"]))

    def test_present_media_target_passes_and_is_counted(self) -> None:
        rels = f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId9" Type="image" Target="media/image1.png"/></Relationships>'
        code, report = self.check(
            "media-ok.docx",
            docx_files(paragraph("Logo"), extra={"word/_rels/document.xml.rels": rels, "word/media/image1.png": "png"}),
        )
        self.assertEqual(code, 0)
        self.assertEqual(report["stats"]["media"], 1)

    def test_dtd_is_refused_as_malformed(self) -> None:
        hostile = '<!DOCTYPE w [<!ENTITY x "y">]><w:document ' + W_NS + "><w:body/></w:document>"
        code, report = self.check("dtd.docx", docx_files("", extra={"word/document.xml": hostile}))
        self.assertEqual(code, 1)
        self.assertTrue(any("malformed XML part word/document.xml" in e for e in report["errors"]))

    def test_corrupt_entry_is_detected_by_crc(self) -> None:
        path = write_zip(self.dir / "crc.docx", docx_files(paragraph("ABCDEFGHIJKLMNOP")), stored=True)
        raw = bytearray(path.read_bytes())
        index = raw.find(b"ABCDEFGHIJKLMNOP")
        self.assertGreater(index, 0)
        raw[index] = ord("Z")
        path.write_bytes(bytes(raw))
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 1)
        self.assertTrue(any(error.startswith("corrupt ZIP entry") for error in report["errors"]))

    def test_not_a_zip_is_an_error(self) -> None:
        path = self.dir / "fake.docx"
        path.write_text("plain text, not a zip")
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 1)
        self.assertEqual(report["errors"], ["not a valid ZIP archive"])

    def test_pptx_slides_are_counted_and_empty_slides_warned(self) -> None:
        files = pptx_files({1: slide_text("Hello"), 2: "<p:sp/>"})
        code, report = self.check("deck.pptx", files)
        self.assertEqual(code, 0)
        self.assertEqual(report["stats"]["slides"], 2)
        self.assertEqual(report["stats"]["empty_slides"], 1)
        self.assertIn("empty slide slide2.xml", report["warnings"])

    def test_pptx_template_tag_is_an_error(self) -> None:
        code, report = self.check("deck-tag.pptx", pptx_files({1: slide_text("Dear {{name}}")}))
        self.assertEqual(code, 1)
        self.assertIn("unrendered template tag in ppt/slides/slide1.xml: {{name}}", report["errors"])

    def test_pptx_without_slides_is_an_error(self) -> None:
        code, report = self.check("empty.pptx", pptx_files({}))
        self.assertEqual(code, 1)
        self.assertEqual(report["errors"], ["presentation has no slides"])

    def test_missing_main_part_is_an_error(self) -> None:
        code, report = self.check("nomain.docx", {"[Content_Types].xml": CONTENT_TYPES})
        self.assertEqual(code, 1)
        self.assertEqual(report["errors"], ["missing main part word/document.xml"])


@unittest.skipUnless(HAS_OPENPYXL, "openpyxl is not installed here; the image runs these")
class CheckXlsxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-xlsx-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_formula_stats_and_uncached_warning(self) -> None:
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = "Totals"
        sheet["A1"] = 2
        sheet["A2"] = 3
        sheet["A3"] = "=SUM(A1:A2)"
        path = self.dir / "totals.xlsx"
        book.save(path)
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 0)
        self.assertEqual(report["stats"]["formulas"], 1)
        self.assertEqual(report["stats"]["sheets"], 1)
        self.assertTrue(any("1 formulas have no cached value" in w for w in report["warnings"]))

    def test_error_token_and_template_tag_are_errors(self) -> None:
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = "Data"
        sheet["B2"] = "#REF!"
        sheet["C3"] = "{{total}}"
        path = self.dir / "bad.xlsx"
        book.save(path)
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 1)
        self.assertIn("spreadsheet error: Data!B2 shows #REF!", report["errors"])
        self.assertIn("unrendered template tag in Data!C3: {{total}}", report["errors"])

    def test_empty_sheet_is_a_warning(self) -> None:
        book = openpyxl.Workbook()
        book.active.title = "Blank"
        path = self.dir / "blank.xlsx"
        book.save(path)
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 0)
        self.assertIn("empty sheet Blank", report["warnings"])

    def test_unreadable_workbook_is_an_error(self) -> None:
        path = self.dir / "broken.xlsx"
        path.write_bytes(b"not a workbook")
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 1)
        self.assertTrue(report["errors"][0].startswith("unreadable workbook"))


class CheckPdfTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-pdf-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_missing_header_is_an_error(self) -> None:
        path = self.dir / "text.pdf"
        path.write_bytes(b"hello")
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 1)
        self.assertEqual(report["errors"], ["missing %PDF- header"])

    @unittest.skipUnless(HAS_PDF_TEXT, "pdftotext is not installed here; the image runs this")
    def test_valid_pdf_passes_and_blank_page_warns(self) -> None:
        path = self.dir / "one.pdf"
        path.write_bytes(minimal_pdf())
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 0)
        self.assertEqual(report["stats"]["pages"], 1)
        self.assertGreater(report["stats"]["text_chars"], 0)

    @unittest.skipUnless(HAS_PDF_TEXT, "pdftotext is not installed here; the image runs this")
    def test_text_free_page_is_reported_blank(self) -> None:
        path = self.dir / "blank.pdf"
        path.write_bytes(minimal_pdf(stream=""))
        code, report = run_docutil("check", str(path))
        self.assertEqual(code, 0)
        self.assertEqual(report["stats"]["blank_pages"], [1])


class MarkdownHelperTests(unittest.TestCase):
    def test_truncate_keeps_the_limit_and_cuts_at_a_line(self) -> None:
        text = "first line\nsecond line\n" + "x" * 200
        cut = docutil.truncate_markdown(text, 60)
        self.assertLessEqual(len(cut), 60)
        self.assertTrue(cut.endswith("[truncated]"))
        self.assertTrue(cut.startswith("first line\nsecond line"))

    def test_truncate_leaves_short_text_alone(self) -> None:
        self.assertEqual(docutil.truncate_markdown("short", 100), "short")

    def test_cell_backslash_is_escaped_before_its_pipe(self) -> None:
        table = docutil.markdown_table([["a\\b|c"]])
        self.assertEqual(table, "| a\\\\b\\|c |\n| --- |")

    def test_table_escapes_pipes_and_pads_rows(self) -> None:
        table = docutil.markdown_table([["Item", "Price"], ["A|B"]])
        self.assertEqual(table, "| Item | Price |\n| --- | --- |\n| A\\|B |  |")


class ToMarkdownTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-md-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        # Where markitdown is installed (the image), it would take the conversion first; these
        # tests exercise the fallback path, so the library is made unavailable here.
        patch = mock.patch.dict(sys.modules, {"markitdown": None})
        patch.start()
        self.addCleanup(patch.stop)

    def test_csv_becomes_a_markdown_table(self) -> None:
        source = self.dir / "sales.csv"
        source.write_text("region,sales\nnorth,10\nsouth,12\n", encoding="utf-8")
        code, payload = run_docutil("to-markdown", str(source))
        self.assertEqual(code, 0)
        self.assertEqual(payload["converter"], "csv")
        self.assertEqual(payload["markdown"], "| region | sales |\n| --- | --- |\n| north | 10 |\n| south | 12 |")
        self.assertFalse(payload["truncated"])

    def test_max_chars_truncates_and_reports_it(self) -> None:
        source = self.dir / "long.csv"
        source.write_text("a\n" + "\n".join(f"row {i}" for i in range(100)) + "\n", encoding="utf-8")
        code, payload = run_docutil("to-markdown", str(source), "--max-chars", "80")
        self.assertEqual(code, 0)
        self.assertTrue(payload["truncated"])
        self.assertLessEqual(len(payload["markdown"]), 80)

    def test_output_file_is_written_and_reported(self) -> None:
        source = self.dir / "note.csv"
        source.write_text("a,b\n1,2\n", encoding="utf-8")
        target = self.dir / "out" / "note.md"
        code, payload = run_docutil("to-markdown", str(source), "-o", str(target))
        self.assertEqual(code, 0)
        self.assertEqual(payload["output"], str(target.resolve()))
        self.assertIn("| a | b |", target.read_text(encoding="utf-8"))
        self.assertNotIn("markdown", payload)

    def test_markitdown_is_preferred_when_installed(self) -> None:
        class FakeMarkItDown:
            def convert(self, path: str):
                return type("Result", (), {"text_content": f"converted {Path(path).name}"})()

        source = self.dir / "doc.csv"
        source.write_text("a\n", encoding="utf-8")
        fake = type(sys)("markitdown")
        fake.MarkItDown = FakeMarkItDown  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"markitdown": fake}):
            code, payload = run_docutil("to-markdown", str(source))
        self.assertEqual(code, 0)
        self.assertEqual(payload["converter"], "markitdown")
        self.assertEqual(payload["markdown"], "converted doc.csv")

    def test_unsupported_extension_fails(self) -> None:
        source = self.dir / "image.png"
        source.write_bytes(b"\x89PNG")
        code, payload = run_docutil("to-markdown", str(source))
        self.assertEqual(code, 1)
        self.assertIn("does not read", payload["error"])


def stub_executable(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    path.chmod(0o755)
    return path


class RenderPagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-render-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.env = mock.patch.dict(os.environ, {"PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_pdf_pages_render_through_pdftoppm_with_range(self) -> None:
        stub_executable(
            self.bin,
            "pdftoppm",
            """
            import sys
            args = sys.argv[1:]
            first = int(args[args.index("-f") + 1]) if "-f" in args else 1
            last = int(args[args.index("-l") + 1]) if "-l" in args else 3
            prefix = args[-1]
            for number in range(first, last + 1):
                open(f"{prefix}-{number}.png", "wb").write(b"png")
            """,
        )
        source = self.dir / "report.pdf"
        source.write_bytes(minimal_pdf())
        code, payload = run_docutil("render-pages", str(source), "-o", str(self.dir / "pages"), "--first", "2", "--last", "3")
        self.assertEqual(code, 0)
        self.assertEqual(payload["page_count"], 2)
        self.assertEqual([Path(p).name for p in payload["pages"]], ["page-2.png", "page-3.png"])
        self.assertEqual(payload["dpi"], 150)

    def test_typst_pages_render_and_filter_by_range(self) -> None:
        stub_executable(
            self.bin,
            "typst",
            """
            import sys
            source, template = sys.argv[-2], sys.argv[-1]
            for number in (1, 2, 3):
                open(template.replace("{0p}", str(number)), "wb").write(b"png")
            """,
        )
        source = self.dir / "memo.typ"
        source.write_text("= Memo\n", encoding="utf-8")
        code, payload = run_docutil("render-pages", str(source), "--last", "2")
        self.assertEqual(code, 0)
        names = [Path(p).name for p in payload["pages"]]
        self.assertEqual(names, ["page-1.png", "page-2.png"])
        self.assertEqual(Path(payload["directory"]).name, "memo-pages")

    def test_rejects_unknown_input_kind(self) -> None:
        source = self.dir / "sheet.xlsx"
        source.write_bytes(b"x")
        code, payload = run_docutil("render-pages", str(source))
        self.assertEqual(code, 1)
        self.assertIn("reads .pdf or .typ", payload["error"])

    def test_rejects_inverted_range(self) -> None:
        source = self.dir / "report.pdf"
        source.write_bytes(minimal_pdf())
        code, payload = run_docutil("render-pages", str(source), "--first", "3", "--last", "1")
        self.assertEqual(code, 1)
        self.assertIn("--last must not be before --first", payload["error"])


class Html2PdfTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="docutil-html-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.record = self.dir / "record.json"
        browser = stub_executable(
            self.dir,
            "fake-browser",
            f"""
            import json, os, sys
            from pathlib import Path
            args = sys.argv[1:]
            output = next(a.split("=", 1)[1] for a in args if a.startswith("--print-to-pdf="))
            page = args[-1]
            html = Path(page[len("file://"):]).read_text(encoding="utf-8")
            Path(output).write_bytes(b"%PDF-1.4\\n%%EOF\\n")
            Path({str(self.record)!r}).write_text(json.dumps({{"args": args, "html": html, "ld_preload": os.environ.get("LD_PRELOAD")}}))
            """,
        )
        patch = mock.patch.dict(os.environ, {"DOCUTIL_BROWSER": str(browser)})
        patch.start()
        self.addCleanup(patch.stop)
        self.source = self.dir / "page.html"
        self.source.write_text("<html><head><title>T</title></head><body><img src='logo.png'>Hi</body></html>", encoding="utf-8")

    def recorded(self) -> dict:
        return json.loads(self.record.read_text(encoding="utf-8"))

    def test_prints_headless_without_header_footer_and_writes_pdf(self) -> None:
        output = self.dir / "out" / "page.pdf"
        code, payload = run_docutil("html2pdf", str(self.source), str(output))
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["bytes"], output.stat().st_size)
        args = self.recorded()["args"]
        for flag in ("--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer"):
            self.assertIn(flag, args)
        self.assertTrue(args[-1].startswith("file://"))

    def test_browser_runs_without_the_identity_shim(self) -> None:
        with mock.patch.dict(os.environ, {"LD_PRELOAD": "/usr/local/lib/libnss_wrapper.so"}):
            run_docutil("html2pdf", str(self.source), str(self.dir / "shim.pdf"))
        self.assertIsNone(self.recorded()["ld_preload"])

    def test_header_footer_flag_keeps_browser_header(self) -> None:
        run_docutil("html2pdf", str(self.source), str(self.dir / "hf.pdf"), "--header-footer")
        self.assertNotIn("--no-pdf-header-footer", self.recorded()["args"])

    def test_landscape_margin_and_background_are_printed_as_page_css(self) -> None:
        run_docutil("html2pdf", str(self.source), str(self.dir / "css.pdf"), "--landscape", "--margin", "12mm")
        html = self.recorded()["html"]
        self.assertIn("@page { size: landscape; margin: 12mm; }", html)
        self.assertIn("print-color-adjust: exact", html)
        self.assertIn("<base href=\"file://", html)

    def test_no_background_strips_backgrounds(self) -> None:
        run_docutil("html2pdf", str(self.source), str(self.dir / "nb.pdf"), "--no-background")
        self.assertIn("background: none !important", self.recorded()["html"])

    def test_rejects_margin_that_is_not_a_length(self) -> None:
        code, payload = run_docutil("html2pdf", str(self.source), str(self.dir / "x.pdf"), "--margin", "1em; } body{")
        self.assertEqual(code, 1)
        self.assertIn("--margin must be a length", payload["error"])

    def test_missing_browser_is_reported(self) -> None:
        with mock.patch.dict(os.environ, {"DOCUTIL_BROWSER": str(self.dir / "absent")}):
            code, payload = run_docutil("html2pdf", str(self.source), str(self.dir / "y.pdf"))
        self.assertEqual(code, 1)
        self.assertIn("DOCUTIL_BROWSER is not an executable", payload["error"])

    def test_output_that_is_not_a_pdf_fails(self) -> None:
        bad = stub_executable(
            self.dir,
            "bad-browser",
            "import sys\n"
            "target = next(a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--print-to-pdf='))\n"
            "open(target, 'wb').write(b'nope')\n",
        )
        with mock.patch.dict(os.environ, {"DOCUTIL_BROWSER": str(bad)}):
            code, payload = run_docutil("html2pdf", str(self.source), str(self.dir / "z.pdf"))
        self.assertEqual(code, 1)
        self.assertIn("output is not a PDF", payload["error"])


class CommandLineTests(unittest.TestCase):
    def test_help_lists_every_subcommand(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), self.assertRaises(SystemExit) as exit_info:
            docutil.main(["--help"])
        self.assertEqual(exit_info.exception.code, 0)
        for command in ("html2pdf", "render-pages", "to-markdown", "check"):
            self.assertIn(command, buffer.getvalue())

    def test_missing_input_is_json_failure(self) -> None:
        code, payload = run_docutil("check", "/definitely/not/here.docx")
        self.assertEqual(code, 1)
        self.assertFalse(payload["ok"])
        self.assertIn("input not found", payload["error"])


if __name__ == "__main__":
    unittest.main()
