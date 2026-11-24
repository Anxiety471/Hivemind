import type { MirrorContext } from "./context.js";
import type { DocumentEntry, DocumentOptions } from "./documents.js";
import { loadDocument, serveArtifact, serveDocument } from "./documents.js";
import { BadRequestError, IntegrityError, UpstreamError } from "./errors.js";
import { isRecord } from "./json.js";
import type { MirrorResponse } from "./response.js";
import type { ArtifactDigests } from "./upstream.js";

const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const TARBALL_NAME = /^[A-Za-z0-9][A-Za-z0-9._~+-]*\.tgz$/;
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;
const MAX_TARBALL_BYTES = 2 * 1024 * 1024 * 1024;

/** `/npm/<package>` packuments and `/npm/<package>/-/<file>.tgz` tarballs. */
export async function handleNpm(context: MirrorContext, suffix: string): Promise<MirrorResponse> {
  if (!suffix || suffix.includes("\\") || suffix.includes("\0") || suffix.includes("//"))
    throw new BadRequestError("invalid npm path");
  const tarball = suffix.indexOf("/-/");
  if (tarball < 0) return serveDocument(context, packumentOptions(context, packageName(suffix)));
  const name = packageName(suffix.slice(0, tarball));
  const filename = pathPart(suffix.slice(tarball + 3));
  if (!TARBALL_NAME.test(filename)) throw new BadRequestError("invalid npm tarball name");
  return serveArtifact(context, {
    key: `npm/tarballs/${name}/${filename}`,
    url: `${context.config.npmUpstream}/${name}/-/${filename}`,
    hosts: context.hosts.npm,
    maxBytes: MAX_TARBALL_BYTES,
    contentType: "application/octet-stream",
    // A cached tarball is served without the packument; a fresh download proves its bytes.
    verify: async (digests) => {
      const packument = await loadDocument(context, packumentOptions(context, name));
      verifyTarball(digests, publishedHash(packument.entry, filename));
    },
  });
}

function packumentOptions(context: MirrorContext, name: string): DocumentOptions {
  return {
    key: `npm/packuments/${name}.json`,
    url: `${context.config.npmUpstream}/${name}`,
    hosts: context.hosts.npm,
    accept: "application/json",
    maxBytes: MAX_PACKUMENT_BYTES,
    contentType: "application/json",
    ttlMs: context.config.indexTtlMs,
    rewrite: (entry) => rewritePackument(entry, name, context.config.publicUrl),
  };
}

/** A scoped name arrives as `@scope/name` or, from npm itself, `@scope%2fname`. */
function packageName(raw: string): string {
  const decoded = pathPart(raw);
  if (decoded.length > 214 || !NPM_NAME.test(decoded))
    throw new BadRequestError("invalid npm package name");
  return decoded;
}

function pathPart(raw: string): string {
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

function rewritePackument(
  entry: DocumentEntry,
  name: string,
  publicUrl: string,
): { body: string; contentType: string } {
  let data: unknown;
  try {
    data = JSON.parse(entry.body);
  } catch {
    return { body: entry.body, contentType: "application/json" };
  }
  if (isRecord(data) && isRecord(data.versions)) {
    const base = `${publicUrl}/npm/${name}/-/`;
    for (const version of Object.values(data.versions)) {
      if (!isRecord(version) || !isRecord(version.dist)) continue;
      const tarball = version.dist.tarball;
      if (typeof tarball !== "string") continue;
      const filename = tarballBasename(tarball);
      if (filename && TARBALL_NAME.test(filename)) version.dist.tarball = `${base}${filename}`;
    }
  }
  return { body: JSON.stringify(data), contentType: "application/json" };
}

function tarballBasename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.slice(pathname.lastIndexOf("/") + 1);
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function publishedHash(
  entry: DocumentEntry,
  filename: string,
): { integrity?: string; shasum?: string } {
  let data: unknown;
  try {
    data = JSON.parse(entry.body);
  } catch {
    throw new UpstreamError("npm packument is not JSON", 502);
  }
  if (!isRecord(data) || !isRecord(data.versions))
    throw new UpstreamError("npm packument has no versions", 502);
  for (const version of Object.values(data.versions)) {
    if (!isRecord(version) || !isRecord(version.dist)) continue;
    const tarball = version.dist.tarball;
    if (typeof tarball !== "string" || tarballBasename(tarball) !== filename) continue;
    return {
      integrity: typeof version.dist.integrity === "string" ? version.dist.integrity : undefined,
      shasum: typeof version.dist.shasum === "string" ? version.dist.shasum : undefined,
    };
  }
  throw new UpstreamError("npm packument does not list this tarball", 404);
}

function verifyTarball(
  digests: ArtifactDigests,
  published: { integrity?: string; shasum?: string },
): void {
  const hashes = published.integrity?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (hashes.length > 0) {
    for (const value of hashes) {
      const dash = value.indexOf("-");
      if (dash <= 0) continue;
      const actual = digestFor(digests, value.slice(0, dash));
      const expected = value.slice(dash + 1).split("?")[0];
      if (actual && Buffer.from(actual, "hex").toString("base64") === expected) return;
    }
    throw new IntegrityError("npm tarball does not match its published integrity");
  }
  if (published.shasum) {
    if (digests.sha1.toLowerCase() === published.shasum.toLowerCase()) return;
    throw new IntegrityError("npm tarball does not match its published shasum");
  }
  throw new IntegrityError("npm packument publishes no hash for this tarball");
}

function digestFor(digests: ArtifactDigests, algorithm: string): string | undefined {
  switch (algorithm) {
    case "sha512":
      return digests.sha512;
    case "sha384":
      return digests.sha384;
    case "sha256":
      return digests.sha256;
    case "sha1":
      return digests.sha1;
    default:
      return undefined;
  }
}
