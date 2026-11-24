import type { MirrorContext } from "./context.js";
import type { DocumentEntry } from "./documents.js";
import { serveArtifact, serveDocument } from "./documents.js";
import { BadRequestError, IntegrityError, UpstreamError } from "./errors.js";
import { isRecord } from "./json.js";
import type { PyPiFile } from "./pypi-files.js";
import type { MirrorResponse } from "./response.js";

const PROJECT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+!~-]*$/;
const HREF = /(href\s*=\s*)(["'])([^"']+)\2/gi;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const INDEX_ACCEPT = "application/vnd.pypi.simple.v1+json, text/html;q=0.9";

/** `/pypi/simple/<project>/` indexes and `/pypi/files/<sha256>/<filename>` artifacts. */
export async function handlePyPi(context: MirrorContext, suffix: string): Promise<MirrorResponse> {
  if (suffix.includes("\\") || suffix.includes("\0"))
    throw new BadRequestError("invalid PyPI path");
  if (suffix === "simple" || suffix === "simple/" || suffix.startsWith("simple/"))
    return simpleIndex(context, suffix);
  if (suffix.startsWith("files/")) return file(context, suffix.slice("files/".length));
  throw new UpstreamError("not found", 404);
}

async function simpleIndex(context: MirrorContext, suffix: string): Promise<MirrorResponse> {
  const rest = suffix.startsWith("simple/") ? suffix.slice("simple/".length) : "";
  const raw = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  if (!raw) throw new UpstreamError("not found", 404);
  if (raw.includes("/")) throw new BadRequestError("invalid PyPI project name");
  const project = decodePart(raw).toLowerCase();
  if (project.length > 200 || !PROJECT.test(project))
    throw new BadRequestError("invalid PyPI project name");
  return serveDocument(context, {
    key: `pypi/index/${project}.json`,
    url: `${context.config.pypiUpstream}/simple/${encodeURIComponent(project)}/`,
    hosts: context.hosts.pypi,
    accept: INDEX_ACCEPT,
    maxBytes: MAX_INDEX_BYTES,
    contentType: "application/vnd.pypi.simple.v1+json",
    ttlMs: context.config.indexTtlMs,
    prepare: (entry) => {
      entry.files = publishedFiles(context, entry);
      context.pypiFiles.set(project, entry.files);
    },
    rewrite: (entry) => rewriteIndex(context, entry),
  });
}

async function file(context: MirrorContext, rest: string): Promise<MirrorResponse> {
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new BadRequestError("invalid PyPI file path");
  const hash = rest.slice(0, slash).toLowerCase();
  const raw = rest.slice(slash + 1);
  if (raw.includes("/")) throw new BadRequestError("invalid PyPI file path");
  const filename = decodePart(raw);
  if (!SHA256.test(hash) || !FILENAME.test(filename))
    throw new BadRequestError("invalid PyPI file path");
  const published = context.pypiFiles.get(hash);
  if (!published || published.filename !== filename)
    throw new UpstreamError("unknown PyPI file", 404);
  return serveArtifact(context, {
    key: `pypi/files/${hash}/${filename}`,
    url: published.url,
    hosts: context.hosts.pypiFiles,
    maxBytes: MAX_FILE_BYTES,
    contentType: "application/octet-stream",
    verify: (digests) => {
      if (digests.sha256 !== hash)
        throw new IntegrityError("PyPI file does not match its published sha256");
    },
  });
}

function decodePart(raw: string): string {
  if (!raw || raw.includes("\\") || raw.includes("\0"))
    throw new BadRequestError("invalid path segment");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequestError("invalid path encoding");
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  )
    throw new BadRequestError("invalid path segment");
  return decoded;
}

function publishedFiles(context: MirrorContext, entry: DocumentEntry): PyPiFile[] {
  let data: unknown;
  try {
    data = JSON.parse(entry.body);
  } catch {
    return htmlFiles(context, entry.body);
  }
  if (!isRecord(data) || !Array.isArray(data.files)) return [];
  const files: PyPiFile[] = [];
  for (const value of data.files) {
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.filename !== "string")
      continue;
    const hash =
      isRecord(value.hashes) && typeof value.hashes.sha256 === "string"
        ? value.hashes.sha256.toLowerCase()
        : shaFromUrl(value.url);
    const file = fileFor(context, value.url, value.filename, hash);
    if (file) files.push(file);
  }
  return files;
}

function htmlFiles(context: MirrorContext, body: string): PyPiFile[] {
  const files: PyPiFile[] = [];
  for (const match of body.matchAll(HREF)) {
    const url = match[3];
    if (!url) continue;
    const file = fileFor(context, url, filenameOf(url), shaFromUrl(url));
    if (file) files.push(file);
  }
  return files;
}

function fileFor(
  context: MirrorContext,
  url: string,
  filename: string,
  hash: string | undefined,
): PyPiFile | undefined {
  if (!hash || !SHA256.test(hash) || !FILENAME.test(filename)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!context.hosts.pypiFiles.has(parsed.host)) return undefined;
  return { url, filename, sha256: hash };
}

function filenameOf(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

function shaFromUrl(url: string): string | undefined {
  return /#sha256=([a-f0-9]{64})$/i.exec(url)?.[1]?.toLowerCase();
}

function rewriteIndex(
  context: MirrorContext,
  entry: DocumentEntry,
): { body: string; contentType: string } {
  const files = entry.files ?? [];
  let data: unknown;
  try {
    data = JSON.parse(entry.body);
  } catch {
    return {
      body: rewriteHtml(context, entry.body, files),
      contentType: "text/html; charset=utf-8",
    };
  }
  if (!isRecord(data) || !Array.isArray(data.files))
    return { body: JSON.stringify(data), contentType: "application/vnd.pypi.simple.v1+json" };
  for (const value of data.files) {
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.filename !== "string")
      continue;
    const hash = isRecord(value.hashes)
      ? String(value.hashes.sha256 ?? "").toLowerCase()
      : shaFromUrl(value.url);
    const file = files.find((candidate) => candidate.sha256 === hash);
    if (file) value.url = publicFileUrl(context, file);
  }
  return { body: JSON.stringify(data), contentType: "application/vnd.pypi.simple.v1+json" };
}

function rewriteHtml(context: MirrorContext, body: string, files: PyPiFile[]): string {
  return body.replace(HREF, (whole, prefix: string, quote: string, url: string) => {
    const hash = shaFromUrl(url);
    const file = hash ? files.find((candidate) => candidate.sha256 === hash) : undefined;
    return file ? `${prefix}${quote}${publicFileUrl(context, file)}${quote}` : whole;
  });
}

function publicFileUrl(context: MirrorContext, file: PyPiFile): string {
  return `${context.config.publicUrl}/pypi/files/${file.sha256}/${encodeURIComponent(file.filename)}`;
}
