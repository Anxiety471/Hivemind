import type { MirrorContext } from "./context.js";
import type { DocumentOptions } from "./documents.js";
import { serveArtifact, serveDocument } from "./documents.js";
import { BadRequestError, UpstreamError } from "./errors.js";
import type { MirrorResponse } from "./response.js";

const MODULE_SEGMENT = /^[A-Za-z0-9._~!+-]+$/;
const VERSION = /^v[0-9][A-Za-z0-9.+-]*$/;
const MAX_LIST_BYTES = 32 * 1024 * 1024;
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_MOD_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

/** `/go/<module>/@v/list`, `.info`, `.mod`, `.zip`, and `@latest` (GOPROXY). */
export async function handleGo(context: MirrorContext, suffix: string): Promise<MirrorResponse> {
  if (suffix.includes("\\") || suffix.includes("\0")) throw new BadRequestError("invalid Go path");
  if (suffix.endsWith("/@latest")) {
    const modulePath = moduleName(suffix.slice(0, -"/@latest".length));
    return serveDocument(context, goOptions(context, modulePath, "@latest"));
  }
  const marker = suffix.lastIndexOf("/@v/");
  if (marker < 0) throw new BadRequestError("invalid Go module proxy path");
  const modulePath = moduleName(suffix.slice(0, marker));
  const file = suffix.slice(marker + "/@v/".length);
  if (file === "list") return serveDocument(context, goOptions(context, modulePath, "list"));
  const match = /^(.+)\.(info|mod|zip)$/.exec(file);
  if (!match?.[1] || !match[2]) throw new BadRequestError("invalid Go module version file");
  if (!VERSION.test(match[1])) throw new BadRequestError("invalid Go module version");
  const versionFile = `${match[1]}.${match[2]}`;
  if (match[2] === "zip")
    return serveArtifact(context, {
      key: `go/${modulePath}/@v/${versionFile}`,
      url: `${context.config.goUpstream}/${modulePath}/@v/${versionFile}`,
      hosts: context.hosts.go,
      maxBytes: MAX_ZIP_BYTES,
      contentType: "application/zip",
    });
  return serveDocument(context, goOptions(context, modulePath, versionFile));
}

function goOptions(context: MirrorContext, modulePath: string, file: string): DocumentOptions {
  const immutable = file.endsWith(".info") || file.endsWith(".mod");
  const path = file === "@latest" ? "@latest" : `@v/${file}`;
  return {
    key: `go/${modulePath}/${path}`,
    url: `${context.config.goUpstream}/${modulePath}/${path}`,
    hosts: context.hosts.go,
    maxBytes: maxBytesFor(file),
    contentType: contentTypeFor(file),
    ttlMs: immutable ? Number.POSITIVE_INFINITY : context.config.indexTtlMs,
    rewrite: (entry) => ({
      body: entry.body,
      contentType: contentTypeFor(file),
    }),
  };
}

function moduleName(raw: string): string {
  if (!raw) throw new BadRequestError("invalid Go module path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequestError("invalid Go module path encoding");
  }
  if (decoded.includes("%")) throw new BadRequestError("invalid Go module path");
  for (const segment of decoded.split("/"))
    if (!MODULE_SEGMENT.test(segment) || segment === "." || segment === "..")
      throw new BadRequestError("invalid Go module path");
  if (decoded.length > 500) throw new BadRequestError("invalid Go module path");
  return decoded;
}

function maxBytesFor(file: string): number {
  if (file === "list") return MAX_LIST_BYTES;
  if (file === "@latest" || file.endsWith(".info")) return MAX_INFO_BYTES;
  if (file.endsWith(".mod")) return MAX_MOD_BYTES;
  throw new UpstreamError("not found", 404);
}

function contentTypeFor(file: string): string {
  if (file === "list" || file.endsWith(".mod")) return "text/plain; charset=utf-8";
  if (file === "@latest" || file.endsWith(".info")) return "application/json";
  throw new UpstreamError("not found", 404);
}
