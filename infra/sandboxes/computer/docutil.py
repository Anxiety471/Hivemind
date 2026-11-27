#!/usr/bin/env python3
"""docutil: render, convert, extract and check office documents and PDFs in the computer workspace.

Subcommands: html2pdf, render-pages, to-markdown, check. Each prints one JSON object on stdout
and exits 0 on success or 1 on failure. Third-party libraries are optional: each subcommand uses
the library when it is installed and otherwise a command-line tool from the image. Nothing here
fetches anything from the network, and no XML part is read if it declares a DTD.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import Any

try:  # The image installs defusedxml; the standard parser is safe here too, once DTDs are refused.
    import defusedxml.ElementTree as _defused_xml  # type: ignore
except ImportError:  # pragma: no cover - depends on the environment
    _defused_xml = None

TOOL_TIMEOUT_SECONDS = 120
BROWSER_NAMES = ("chromium", "google-chrome", "google-chrome-stable", "brave-browser")
SPREADSHEET_ERRORS = frozenset(("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!"))
PLACEHOLDER = re.compile(r"\bTODO\b|\bTBD\b|(?i:lorem ipsum)")
TEMPLATE_TAG = re.compile(r"\{\{[^{}]*\}\}")
CSS_LENGTH = re.compile(r"^\d+(\.\d+)?(mm|cm|in|px|pt)$")
MAX_REPORTED = 20
OOXML_FORMATS = {".docx": "docx", ".pptx": "pptx"}
MARKDOWN_PAGE_BREAK = "\n\n---\n\n"
TRUNCATED_MARKER = "\n\n[truncated]"
PANDOC_INPUTS = {".docx": "docx", ".odt": "odt", ".rtf": "rtf", ".html": "html", ".htm": "html"}


class DocutilError(Exception):
    """A failure the caller can act on; reported as JSON with exit status 1."""


def emit(payload: dict[str, Any], code: int = 0) -> int:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


def run_tool(
    args: list[str],
    *,
    timeout: int = TOOL_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Runs a tool without a shell. Arguments are a list, so a file name cannot add options."""
    try:
        completed = subprocess.run(args, capture_output=True, timeout=timeout, check=False, env=env)
    except FileNotFoundError as error:
        raise DocutilError(f"{args[0]} is not installed") from error
    except subprocess.TimeoutExpired as error:
        raise DocutilError(f"{args[0]} timed out after {timeout} seconds") from error
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()[-800:]
        raise DocutilError(f"{args[0]} exited with status {completed.returncode}: {detail}")
    return completed


def resolve_input(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise DocutilError(f"input not found: {value}")
    return path


def parse_xml(data: bytes) -> ElementTree.Element:
    """Parses one XML part. A DTD is refused before parsing, so no entity is ever declared."""
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML declares a DTD or entities, which are not accepted")
    if _defused_xml is not None:
        return _defused_xml.fromstring(data)
    return ElementTree.fromstring(data)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def truncate_markdown(text: str, limit: int) -> str:
    """Cuts at a line break when one is near the limit, and never returns more than `limit` characters."""
    if len(text) <= limit:
        return text
    if limit <= len(TRUNCATED_MARKER):
        return text[:limit]
    budget = limit - len(TRUNCATED_MARKER)
    cut = text[:budget]
    line_break = cut.rfind("\n")
    if line_break > budget // 2:
        cut = cut[:line_break]
    return cut.rstrip() + TRUNCATED_MARKER


def markdown_table(rows: list[list[str]]) -> str:
    width = max((len(row) for row in rows), default=0)
    if width == 0:
        return ""
    lines = []
    for row in rows:
        cells = [(row[i] if i < len(row) else "").replace("|", "\\|").replace("\n", " ").strip() for i in range(width)]
        lines.append("| " + " | ".join(cells) + " |")
    lines.insert(1, "| " + " | ".join("---" for _ in range(width)) + " |")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# html2pdf
# --------------------------------------------------------------------------------------------


def find_browser() -> str:
    configured = os.environ.get("DOCUTIL_BROWSER", "").strip()
    if configured:
        found = shutil.which(configured) or (configured if os.access(configured, os.X_OK) else None)
        if not found:
            raise DocutilError(f"DOCUTIL_BROWSER is not an executable: {configured}")
        return found
    for name in BROWSER_NAMES:
        found = shutil.which(name)
        if found:
            return found
    raise DocutilError("no headless browser found; set DOCUTIL_BROWSER or install chromium")


def print_stylesheet(landscape: bool, margin: str | None, background: bool) -> str:
    page_rules = [part for part in ("size: landscape" if landscape else "", f"margin: {margin}" if margin else "") if part]
    rules = []
    if page_rules:
        rules.append("@page { " + "; ".join(page_rules) + "; }")
    if background:
        rules.append("* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }")
    else:
        rules.append("* { background: none !important; }")
    return "<style>" + " ".join(rules) + "</style>"


def html_with_stylesheet(source: Path, style: str) -> str:
    """The HTML with the print style and a base URL, so relative images and links still resolve."""
    text = source.read_text(encoding="utf-8", errors="replace")
    injected = f'<base href="{source.parent.as_uri()}/">{style}'
    head = re.search(r"<head[^>]*>", text, re.IGNORECASE)
    if head:
        return text[: head.end()] + injected + text[head.end() :]
    return injected + text


def pdf_page_count(path: Path) -> int | None:
    """The page count is informational: when a reader cannot parse the file, the count is null."""
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        PdfReader = None  # type: ignore[assignment]
    if PdfReader is not None:
        try:
            return len(PdfReader(str(path)).pages)
        except Exception:  # noqa: BLE001 - any parse failure here means "unknown", not a failed conversion.
            return None
    try:
        completed = run_tool(["pdfinfo", str(path)])
    except DocutilError:
        return None
    match = re.search(r"^Pages:\s+(\d+)", completed.stdout.decode("utf-8", errors="replace"), re.MULTILINE)
    return int(match.group(1)) if match else None


def validate_pdf(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise DocutilError(f"no PDF was written to {path}")
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise DocutilError(f"output is not a PDF: {path}")


def cmd_html2pdf(args: argparse.Namespace) -> int:
    source = resolve_input(args.input)
    output = Path(args.output).expanduser().resolve()
    if args.margin is not None and not CSS_LENGTH.match(args.margin):
        raise DocutilError("--margin must be a length such as 12mm, 0.5in, 10px or 1cm")
    browser = find_browser()
    output.parent.mkdir(parents=True, exist_ok=True)
    style = print_stylesheet(args.landscape, args.margin, not args.no_background)
    with tempfile.TemporaryDirectory(prefix="docutil-") as scratch:
        page = Path(scratch) / "page.html"
        page.write_text(html_with_stylesheet(source, style), encoding="utf-8")
        command = [
            browser,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={Path(scratch) / 'profile'}",
            f"--print-to-pdf={output}",
        ]
        if not args.header_footer:
            command.append("--no-pdf-header-footer")
        command.append(page.as_uri())
        # The image preloads an identity shim for the bot's shell. Chromium hangs under it when
        # its files are missing, and it does not need the shim: the user is in the system's passwd.
        run_tool(command, env={key: value for key, value in os.environ.items() if key != "LD_PRELOAD"})
    validate_pdf(output)
    return emit({"ok": True, "input": str(source), "output": str(output), "bytes": output.stat().st_size, "pages": pdf_page_count(output)})


# --------------------------------------------------------------------------------------------
# render-pages
# --------------------------------------------------------------------------------------------


def page_number(path: Path) -> int:
    match = re.search(r"(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 0


def cmd_render_pages(args: argparse.Namespace) -> int:
    source = resolve_input(args.input)
    if not 36 <= args.dpi <= 1200:
        raise DocutilError("--dpi must be between 36 and 1200")
    if args.first is not None and args.first < 1:
        raise DocutilError("--first must be 1 or more")
    if args.first and args.last and args.last < args.first:
        raise DocutilError("--last must not be before --first")
    directory = Path(args.output).expanduser().resolve() if args.output else source.with_name(f"{source.stem}-pages")
    directory.mkdir(parents=True, exist_ok=True)
    for stale in directory.glob("page*.png"):
        stale.unlink()
    suffix = source.suffix.lower()
    if suffix == ".typ":
        run_tool(["typst", "compile", "--format", "png", "--ppi", str(args.dpi), str(source), str(directory / "page-{0p}.png")])
        images = sorted(directory.glob("page-*.png"), key=page_number)
        images = [image for image in images if (args.first or 1) <= page_number(image) and (args.last is None or page_number(image) <= args.last)]
    elif suffix == ".pdf":
        command = ["pdftoppm", "-png", "-r", str(args.dpi)]
        if args.first:
            command += ["-f", str(args.first)]
        if args.last:
            command += ["-l", str(args.last)]
        run_tool(command + [str(source), str(directory / "page")])
        images = sorted(directory.glob("page*.png"), key=page_number)
    else:
        raise DocutilError("render-pages reads .pdf or .typ files")
    return emit({"ok": True, "input": str(source), "directory": str(directory), "dpi": args.dpi, "page_count": len(images), "pages": [str(image) for image in images]})


# --------------------------------------------------------------------------------------------
# to-markdown
# --------------------------------------------------------------------------------------------


def markitdown_text(source: Path) -> str | None:
    try:
        from markitdown import MarkItDown  # type: ignore
    except ImportError:
        return None
    try:
        return MarkItDown().convert(str(source)).text_content
    except Exception:  # noqa: BLE001 - markitdown has no narrower error type; fall back to the native tool.
        return None


def pdf_markdown(source: Path) -> str:
    text = run_tool(["pdftotext", "-layout", "-enc", "UTF-8", str(source), "-"]).stdout.decode("utf-8", errors="replace")
    pages = [page.strip() for page in text.split("\f")]
    return MARKDOWN_PAGE_BREAK.join(page for page in pages if page)


def pandoc_markdown(source: Path, reader: str) -> str:
    return run_tool(["pandoc", "-f", reader, "-t", "gfm", "--wrap=none", str(source)]).stdout.decode("utf-8", errors="replace")


def pptx_markdown(source: Path) -> str:
    try:
        from pptx import Presentation  # type: ignore
    except ImportError as error:
        raise DocutilError("python-pptx is not installed") from error
    deck = Presentation(str(source))
    sections = []
    for index, slide in enumerate(deck.slides, start=1):
        lines = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                lines.extend(p.text for p in shape.text_frame.paragraphs if p.text.strip())
            if getattr(shape, "has_table", False) and shape.has_table:
                rows = [[cell.text for cell in row.cells] for row in shape.table.rows]
                lines.append(markdown_table(rows))
        sections.append(f"## Slide {index}\n\n" + "\n\n".join(line for line in lines if line))
    return "\n\n".join(sections)


def xlsx_markdown(source: Path) -> str:
    try:
        import openpyxl  # type: ignore
    except ImportError as error:
        raise DocutilError("openpyxl is not installed") from error
    workbook = openpyxl.load_workbook(str(source), data_only=True, read_only=True)
    sections = []
    for sheet in workbook.worksheets:
        rows = [["" if value is None else str(value) for value in row] for row in sheet.iter_rows(values_only=True)]
        while rows and not any(rows[-1]):
            rows.pop()
        table = markdown_table(rows) if rows else ""
        sections.append(f"## {sheet.title}\n\n{table}".rstrip())
    return "\n\n".join(sections)


def csv_markdown(source: Path) -> str:
    with source.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return markdown_table([row for row in csv.reader(handle)])


def convert_to_markdown(source: Path) -> tuple[str, str]:
    suffix = source.suffix.lower()
    if suffix not in {".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".odt", ".rtf", ".csv"}:
        raise DocutilError(f"to-markdown does not read {suffix or 'files without an extension'}")
    text = markitdown_text(source)
    if text is not None:
        return "markitdown", text
    if suffix == ".pdf":
        return "pdftotext", pdf_markdown(source)
    if suffix in PANDOC_INPUTS:
        return "pandoc", pandoc_markdown(source, PANDOC_INPUTS[suffix])
    if suffix == ".pptx":
        return "python-pptx", pptx_markdown(source)
    if suffix == ".xlsx":
        return "openpyxl", xlsx_markdown(source)
    return "csv", csv_markdown(source)


def cmd_to_markdown(args: argparse.Namespace) -> int:
    source = resolve_input(args.input)
    converter, markdown = convert_to_markdown(source)
    truncated = False
    if args.max_chars is not None:
        if args.max_chars < 1:
            raise DocutilError("--max-chars must be 1 or more")
        cut = truncate_markdown(markdown, args.max_chars)
        truncated = len(cut) < len(markdown)
        markdown = cut
    payload: dict[str, Any] = {
        "ok": True,
        "input": str(source),
        "format": source.suffix.lower().lstrip("."),
        "converter": converter,
        "chars": len(markdown),
        "truncated": truncated,
    }
    if args.output:
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(markdown, encoding="utf-8")
        payload["output"] = str(output)
    else:
        payload["markdown"] = markdown
    return emit(payload)


# --------------------------------------------------------------------------------------------
# check
# --------------------------------------------------------------------------------------------


class Report:
    def __init__(self, path: Path, file_format: str) -> None:
        self.data: dict[str, Any] = {
            "ok": False,
            "format": file_format,
            "path": str(path),
            "bytes": path.stat().st_size,
            "stats": {},
            "warnings": [],
            "errors": [],
        }

    def error(self, message: str) -> None:
        self.data["errors"].append(message)

    def warn(self, message: str) -> None:
        self.data["warnings"].append(message)

    def finish(self) -> dict[str, Any]:
        self.data["ok"] = not self.data["errors"]
        return self.data


def cap(items: list[str]) -> list[str]:
    if len(items) <= MAX_REPORTED:
        return items
    return items[:MAX_REPORTED] + [f"and {len(items) - MAX_REPORTED} more"]


def text_findings(report: Report, label: str, text: str) -> None:
    """Records unrendered template tags (errors) and placeholder words (warnings) found in one block of text."""
    for tag in TEMPLATE_TAG.findall(text):
        report.error(f"unrendered template tag in {label}: {tag}")
    for marker in sorted(set(match.group(0) for match in PLACEHOLDER.finditer(text))):
        report.warn(f"placeholder text in {label}: {marker}")


def paragraph_texts(root: ElementTree.Element) -> list[str]:
    """Text of each paragraph (w:p or a:p), joined across runs so split template tags are found."""
    texts = []
    for element in root.iter():
        if local_name(element.tag) != "p":
            continue
        texts.append("".join(node.text or "" for node in element.iter() if local_name(node.tag) == "t"))
    return texts


def check_relationships(report: Report, archive: zipfile.ZipFile, names: set[str]) -> None:
    missing: list[str] = []
    for name in sorted(n for n in names if n.endswith(".rels")):
        if name.startswith("_rels/"):
            base, source_part = "", "package"
        else:
            folder, _, rels_file = name.rpartition("/_rels/")
            base = f"{folder}/" if folder else ""
            source_part = base + rels_file[: -len(".rels")]
        root = parse_xml(archive.read(name))
        for relation in root:
            if local_name(relation.tag) != "Relationship" or relation.get("TargetMode") == "External":
                continue
            target = relation.get("Target", "")
            resolved = target[1:] if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            if resolved not in names:
                missing.append(f"missing relationship target {resolved} (from {source_part})")
    for message in cap(sorted(set(missing))):
        report.error(message)


def check_ooxml(path: Path, report: Report) -> None:
    file_format = OOXML_FORMATS[path.suffix.lower()]
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        report.error("not a valid ZIP archive")
        return
    with archive:
        corrupt = archive.testzip()
        if corrupt is not None:
            report.error(f"corrupt ZIP entry: {corrupt}")
            return
        names = set(archive.namelist())
        if "[Content_Types].xml" not in names:
            report.error("missing [Content_Types].xml")
            return
        main_part = "word/document.xml" if file_format == "docx" else "ppt/presentation.xml"
        if main_part not in names:
            report.error(f"missing main part {main_part}")
            return
        for name in sorted(n for n in names if n.endswith((".xml", ".rels"))):
            try:
                parse_xml(archive.read(name))
            except (ElementTree.ParseError, ValueError) as error:
                report.error(f"malformed XML part {name}: {error}")
        if report.data["errors"]:
            return
        check_relationships(report, archive, names)
        media = sorted(n for n in names if n.startswith(("word/media/", "ppt/media/")))
        if file_format == "docx":
            check_docx_parts(report, archive, names, media)
        else:
            check_pptx_parts(report, archive, names, media)


def check_docx_parts(report: Report, archive: zipfile.ZipFile, names: set[str], media: list[str]) -> None:
    root = parse_xml(archive.read("word/document.xml"))
    paragraphs = [text for text in paragraph_texts(root) if text.strip()]
    headings = sum(1 for node in root.iter() if local_name(node.tag) == "pStyle" and re.match(r"(?i)heading\s?\d", node.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val", "")))
    tables = [node for node in root.iter() if local_name(node.tag) == "tbl"]
    for index, table in enumerate(tables, start=1):
        if not any((node.text or "").strip() for node in table.iter() if local_name(node.tag) == "t"):
            report.warn(f"empty table {index}")
    report.data["stats"] = {"paragraphs": len(paragraphs), "headings": headings, "tables": len(tables), "media": len(media)}
    for name in sorted(n for n in names if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n)):
        for text in paragraph_texts(parse_xml(archive.read(name))):
            if text.strip():
                text_findings(report, name, text)
    if not paragraphs and not tables:
        report.warn("document has no text")


def check_pptx_parts(report: Report, archive: zipfile.ZipFile, names: set[str], media: list[str]) -> None:
    slides = sorted(
        (n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)),
        key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)),  # type: ignore[union-attr]
    )
    if not slides:
        report.error("presentation has no slides")
        return
    empty = 0
    for name in slides:
        root = parse_xml(archive.read(name))
        texts = [text for text in paragraph_texts(root) if text.strip()]
        visual = any(local_name(node.tag) in {"pic", "graphicFrame"} for node in root.iter())
        if not texts and not visual:
            empty += 1
            report.warn(f"empty slide {name.rsplit('/', 1)[-1]}")
        for text in texts:
            text_findings(report, name, text)
    for name in sorted(n for n in names if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", n)):
        for text in paragraph_texts(parse_xml(archive.read(name))):
            if text.strip():
                text_findings(report, name, text)
    report.data["stats"] = {"slides": len(slides), "empty_slides": empty, "media": len(media)}


def check_xlsx(path: Path, report: Report) -> None:
    try:
        import openpyxl  # type: ignore
    except ImportError:
        report.error("openpyxl is not installed")
        return
    try:
        formulas_book = openpyxl.load_workbook(str(path), data_only=False)
        values_book = openpyxl.load_workbook(str(path), data_only=True)
    except Exception as error:  # noqa: BLE001 - any failure to open the workbook is the finding itself.
        report.error(f"unreadable workbook: {error}")
        return
    formula_count = 0
    uncached = 0
    error_cells: list[str] = []
    cells_with_values = 0
    empty_sheets: list[str] = []
    for sheet in formulas_book.worksheets:
        cached_sheet = values_book[sheet.title]
        sheet_has_value = False
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                if value is None:
                    continue
                sheet_has_value = True
                cells_with_values += 1
                reference = f"{sheet.title}!{cell.coordinate}"
                if isinstance(value, str) and value.startswith("="):
                    formula_count += 1
                    cached = cached_sheet[cell.coordinate].value
                    if cached is None:
                        uncached += 1
                    elif isinstance(cached, str) and cached.strip() in SPREADSHEET_ERRORS:
                        error_cells.append(f"{reference} shows {cached.strip()}")
                    continue
                if isinstance(value, str):
                    if value.strip() in SPREADSHEET_ERRORS:
                        error_cells.append(f"{reference} shows {value.strip()}")
                    text_findings(report, reference, value)
        if not sheet_has_value:
            empty_sheets.append(sheet.title)
    for message in cap(error_cells):
        report.error(f"spreadsheet error: {message}")
    for name in empty_sheets:
        report.warn(f"empty sheet {name}")
    if uncached:
        report.warn(f"{uncached} formulas have no cached value; open and save the workbook to calculate them")
    report.data["stats"] = {
        "sheets": len(formulas_book.worksheets),
        "formulas": formula_count,
        "cells_with_values": cells_with_values,
        "empty_sheets": len(empty_sheets),
    }


def pdf_pages(path: Path) -> tuple[list[dict[str, Any]], str | None]:
    """Per-page text and image counts (images None when unknown). The second value is a problem, if any."""
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        PdfReader = None  # type: ignore[assignment]
    if PdfReader is not None:
        try:
            reader = PdfReader(str(path))
            if reader.is_encrypted and not reader.decrypt(""):
                return [], "PDF is encrypted with a password"
            pages = []
            for page in reader.pages:
                try:
                    images: int | None = len(page.images)
                except Exception:  # noqa: BLE001 - image listing needs Pillow; an unknown count is not a blank page.
                    images = None
                pages.append({"text": page.extract_text() or "", "images": images})
            return pages, None
        except Exception as error:  # noqa: BLE001 - the parser's own error types are the finding.
            return [], f"unreadable PDF: {error}"
    try:
        text = run_tool(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"]).stdout.decode("utf-8", errors="replace")
    except DocutilError as error:
        return [], f"unreadable PDF: {error}"
    pages = text.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return [{"text": page, "images": None} for page in pages], None


def check_pdf(path: Path, report: Report) -> None:
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            report.error("missing %PDF- header")
            return
    pages, problem = pdf_pages(path)
    if problem:
        report.error(problem)
        return
    if not pages:
        report.error("PDF has no pages")
        return
    blank = []
    for number, page in enumerate(pages, start=1):
        if not page["text"].strip() and page["images"] == 0:
            blank.append(number)
            report.warn(f"page {number} has no text or images")
    report.data["stats"] = {
        "pages": len(pages),
        "text_chars": sum(len(page["text"]) for page in pages),
        "blank_pages": blank,
    }


def cmd_check(args: argparse.Namespace) -> int:
    path = resolve_input(args.input)
    suffix = path.suffix.lower()
    report = Report(path, suffix.lstrip("."))
    if suffix == ".pdf":
        check_pdf(path, report)
    elif suffix in OOXML_FORMATS:
        check_ooxml(path, report)
    elif suffix == ".xlsx":
        check_xlsx(path, report)
    else:
        report.error(f"unsupported format: {suffix or 'no extension'} (check reads .pdf, .docx, .xlsx and .pptx)")
    result = report.finish()
    return emit(result, 0 if result["ok"] else 1)


# --------------------------------------------------------------------------------------------
# command line
# --------------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docutil",
        description="Render, convert, extract and check office documents and PDFs. Prints JSON.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    html = commands.add_parser("html2pdf", help="print an HTML file to PDF with a headless browser")
    html.add_argument("input")
    html.add_argument("output")
    html.add_argument("--landscape", action="store_true")
    html.add_argument("--margin", help="page margin, e.g. 12mm, 0.5in or 10px")
    html.add_argument("--no-background", action="store_true", help="drop background colours and images")
    html.add_argument("--header-footer", action="store_true", help="keep the browser's date and URL header and footer")
    html.set_defaults(handler=cmd_html2pdf)

    pages = commands.add_parser("render-pages", help="render PDF or Typst pages to PNG images")
    pages.add_argument("input")
    pages.add_argument("-o", "--output", help="directory for the PNG files (default: <name>-pages beside the input)")
    pages.add_argument("--dpi", type=int, default=150)
    pages.add_argument("--first", type=int)
    pages.add_argument("--last", type=int)
    pages.set_defaults(handler=cmd_render_pages)

    markdown = commands.add_parser("to-markdown", help="convert a document to Markdown")
    markdown.add_argument("input")
    markdown.add_argument("-o", "--output")
    markdown.add_argument("--max-chars", type=int)
    markdown.set_defaults(handler=cmd_to_markdown)

    check = commands.add_parser("check", help="check a PDF, DOCX, XLSX or PPTX file for corruption and QA problems")
    check.add_argument("input")
    check.set_defaults(handler=cmd_check)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except DocutilError as error:
        return emit({"ok": False, "error": str(error)}, 1)


if __name__ == "__main__":
    sys.exit(main())
