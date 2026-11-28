import type { MirrorContext } from "./context.js";
import type { DocumentOptions } from "./documents.js";
import { serveDocument } from "./documents.js";
import { BadRequestError, UpstreamError } from "./errors.js";
import { isRecord } from "./json.js";
import type { MirrorResponse } from "./response.js";

const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*$/;
const MAX_PACKAGES_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
/** Optional endpoints that still work directly against the upstream, never through the mirror. */
const UPSTREAM_ROOT_FIELDS = ["notify-batch", "search", "list"] as const;

/**
 * Composer 2 repository metadata (`/composer/`). Only metadata is mirrored: dist archive URLs
 * stay exactly as Packagist published them, because composer.lock records dist.url.
 */
export async function handleComposer(
  context: MirrorContext,
  suffix: string,
): Promise<MirrorResponse> {
  if (suffix.includes("\\") || suffix.includes("\0"))
    throw new BadRequestError("invalid Composer path");
  if (suffix === "packages.json") return serveDocument(context, packagesOptions(context));
  if (suffix.startsWith("p2/"))
    return serveDocument(context, metadataOptions(context, suffix.slice("p2/".length)));
  throw new UpstreamError("not found", 404);
}

function packagesOptions(context: MirrorContext): DocumentOptions {
  return {
    key: "composer/packages.json",
    url: `${context.config.composerUpstream}/packages.json`,
    hosts: context.hosts.composer,
    maxBytes: MAX_PACKAGES_BYTES,
    contentType: "application/json",
    ttlMs: context.config.indexTtlMs,
    rewrite: (entry) => ({
      body: rewritePackagesJson(entry.body),
      contentType: "application/json",
    }),
  };
}

/**
 * A minimal Composer 2 root: `packages` plus a metadata-url. Composer 1's providers fields and
 * the optional catalog/changes endpoints are dropped because the mirror does not serve them;
 * notify-batch, search and list keep working against Packagist when the upstream publishes them.
 */
function rewritePackagesJson(body: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new UpstreamError("Composer packages.json is not JSON", 502);
  }
  if (!isRecord(data)) throw new UpstreamError("Composer packages.json is not an object", 502);
  const result: Record<string, unknown> = {
    packages: Array.isArray(data.packages) ? data.packages : [],
    "metadata-url": "/composer/p2/%package%.json",
  };
  for (const field of UPSTREAM_ROOT_FIELDS) {
    const value = data[field];
    // A relative endpoint would resolve against the mirror and dangle; only absolute ones stay.
    if (typeof value === "string" && /^https?:\/\//i.test(value)) result[field] = value;
  }
  if (typeof data.warning === "string") result.warning = data.warning;
  return JSON.stringify(result);
}

function metadataOptions(context: MirrorContext, raw: string): DocumentOptions {
  const segments = raw.split("/");
  if (segments.length !== 2) throw new BadRequestError("invalid Composer package path");
  const [vendor, file] = segments;
  if (!vendor || vendor.length > 100 || !COMPOSER_NAME.test(vendor))
    throw new BadRequestError("invalid Composer vendor name");
  if (!file?.endsWith(".json")) throw new BadRequestError("invalid Composer metadata path");
  const base = file.slice(0, -".json".length);
  const dev = base.endsWith("~dev");
  const name = dev ? base.slice(0, -"~dev".length) : base;
  if (!name || name.length > 100 || !COMPOSER_NAME.test(name))
    throw new BadRequestError("invalid Composer package name");
  const path = `${vendor}/${name}${dev ? "~dev" : ""}.json`;
  return {
    key: `composer/p2/${path}`,
    url: `${context.config.composerUpstream}/p2/${path}`,
    hosts: context.hosts.composer,
    maxBytes: MAX_METADATA_BYTES,
    contentType: "application/json",
    ttlMs: context.config.indexTtlMs,
    rewrite: (entry) => ({ body: entry.body, contentType: "application/json" }),
  };
}
