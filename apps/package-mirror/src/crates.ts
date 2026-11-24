import type { MirrorContext } from "./context.js";
import type { DocumentEntry, DocumentOptions } from "./documents.js";
import { loadDocument, serveArtifact, serveDocument } from "./documents.js";
import { BadRequestError, IntegrityError, UpstreamError } from "./errors.js";
import { isRecord } from "./json.js";
import type { MirrorResponse } from "./response.js";

const CRATE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SEGMENT = /^[a-z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;
const MAX_VERSION_LENGTH = 128;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_CRATE_BYTES = 1024 * 1024 * 1024;

/**
 * Cargo sparse index (`/crates/index/`) and crate downloads (`/crates/dl/`). The index keeps
 * the upstream lines verbatim, including each version's cksum, so Cargo.lock stays as published.
 */
export async function handleCrates(
  context: MirrorContext,
  suffix: string,
): Promise<MirrorResponse> {
  if (suffix.includes("\\") || suffix.includes("\0"))
    throw new BadRequestError("invalid crates path");
  if (suffix === "index/config.json") return sparseConfig(context);
  if (suffix.startsWith("index/")) {
    const path = indexFilePath(suffix.slice("index/".length));
    return serveDocument(context, indexOptions(context, path));
  }
  if (suffix.startsWith("dl/")) return download(context, suffix.slice("dl/".length));
  throw new UpstreamError("not found", 404);
}

/**
 * The sparse index config. The `dl` markers make Cargo request `/<crate>/<version>` directly;
 * without them Cargo appends `/<crate>/<version>/download`. `api` is omitted: the mirror is
 * read-only, so publishing, yanking and owner commands are unavailable rather than pointed at
 * an endpoint the mirror does not serve.
 */
function sparseConfig(context: MirrorContext): MirrorResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: Buffer.from(
      JSON.stringify({ dl: `${context.config.publicUrl}/crates/dl/{crate}/{version}` }),
    ),
  };
}

/** Cargo's index layout: `1/n`, `2/na`, `3/n/nam`, or `na/me/name` for longer names. */
function indexFilePath(raw: string): string {
  const segments = raw.split("/");
  const name = segments.at(-1) ?? "";
  if (!name || name.length > MAX_NAME_LENGTH)
    throw new BadRequestError("invalid crates index path");
  for (const segment of segments)
    if (!SEGMENT.test(segment)) throw new BadRequestError("invalid crates index path");
  if (segments.length === 2) {
    if (segments[0] === "1" && name.length === 1) return raw;
    if (segments[0] === "2" && name.length === 2) return raw;
  }
  if (segments.length === 3) {
    if (segments[0] === "3" && name.length === 3 && segments[1] === name.slice(0, 1)) return raw;
    if (name.length >= 4 && segments[0] === name.slice(0, 2) && segments[1] === name.slice(2, 4))
      return raw;
  }
  throw new BadRequestError("invalid crates index path");
}

function indexOptions(context: MirrorContext, path: string): DocumentOptions {
  return {
    key: `crates/index/${path}`,
    url: `${context.config.cratesIndexUpstream}/${path}`,
    hosts: context.hosts.cratesIndex,
    maxBytes: MAX_INDEX_BYTES,
    contentType: "text/plain; charset=utf-8",
    ttlMs: context.config.indexTtlMs,
    rewrite: (entry) => ({ body: entry.body, contentType: "text/plain; charset=utf-8" }),
  };
}

async function download(context: MirrorContext, rest: string): Promise<MirrorResponse> {
  const segments = rest.split("/");
  if (segments.length !== 2) throw new BadRequestError("invalid crate download path");
  const [crate, version] = segments;
  if (!crate || crate.length > MAX_NAME_LENGTH || !CRATE_NAME.test(crate))
    throw new BadRequestError("invalid crate name");
  if (!version || version.length > MAX_VERSION_LENGTH || !VERSION.test(version))
    throw new BadRequestError("invalid crate version");
  return serveArtifact(context, {
    key: `crates/${crate}/${version}.crate`,
    url: `${context.config.cratesDlUpstream}/${crate}/${crate}-${version}.crate`,
    hosts: context.hosts.cratesDl,
    maxBytes: MAX_CRATE_BYTES,
    contentType: "application/octet-stream",
    // A cached crate needs no index; a fresh download is checked against the published cksum.
    verify: async (digests) => {
      const index = await loadDocument(context, indexOptions(context, indexPathForCrate(crate)));
      if (digests.sha256 !== cksumFor(index.entry, version))
        throw new IntegrityError("crate does not match its index cksum");
    },
  });
}

function indexPathForCrate(name: string): string {
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name.slice(0, 1)}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

/** The index is newline-delimited JSON, one object per published version. */
function cksumFor(entry: DocumentEntry, version: string): string {
  for (const line of entry.body.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.vers !== version) continue;
    const cksum = parsed.cksum;
    if (typeof cksum !== "string" || !/^[a-f0-9]{64}$/i.test(cksum))
      throw new UpstreamError("crate index has no valid cksum", 502);
    return cksum.toLowerCase();
  }
  throw new UpstreamError("crate version not found in the index", 404);
}
