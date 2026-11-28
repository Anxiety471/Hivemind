import { rm } from "node:fs/promises";
import type { DiskCache } from "./cache.js";
import type { MirrorContext } from "./context.js";
import { UpstreamError } from "./errors.js";
import type { PyPiFile } from "./pypi-files.js";
import type { MirrorResponse } from "./response.js";
import type { ArtifactDigests } from "./upstream.js";

/** A packument or simple index stored with the time it was fetched. */
export interface DocumentEntry {
  fetchedAt: number;
  contentType: string;
  body: string;
  /** PyPI files named by this index, so a file request can be resolved after a restart. */
  files?: PyPiFile[];
}

export interface DocumentOptions {
  key: string;
  url: string;
  hosts: ReadonlySet<string>;
  accept?: string;
  maxBytes: number;
  contentType: string;
  ttlMs: number;
  /** Runs on fresh and cached entries, before they are stored or served. */
  prepare?: (entry: DocumentEntry) => void;
  /** Returns the body clients see; a cached body is rewritten on every request. */
  rewrite: (entry: DocumentEntry) => { body: string; contentType: string };
}

export interface LoadedDocument {
  entry: DocumentEntry;
  cache: "hit" | "miss" | "stale";
}

export async function readDocument(
  cache: DiskCache,
  key: string,
): Promise<DocumentEntry | undefined> {
  const data = await cache.read(key);
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data.toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as DocumentEntry).fetchedAt === "number" &&
      typeof (parsed as DocumentEntry).contentType === "string" &&
      typeof (parsed as DocumentEntry).body === "string"
    )
      return parsed as DocumentEntry;
  } catch {
    // A truncated document is refetched below.
  }
  return undefined;
}

/**
 * Reads a mutable document from cache while fresh, otherwise fetches it once. An upstream
 * failure falls back to the last copy instead of failing an install.
 */
export async function loadDocument(
  context: MirrorContext,
  options: DocumentOptions,
): Promise<LoadedDocument> {
  const cached = await readDocument(context.cache, options.key);
  if (cached) options.prepare?.(cached);
  if (cached && Date.now() - cached.fetchedAt < options.ttlMs)
    return { entry: cached, cache: "hit" };
  try {
    const entry = await context.documents.run(options.key, async () => {
      const fetched = await context.fetcher.fetchBuffer(options.url, {
        hosts: options.hosts,
        accept: options.accept,
        maxBytes: options.maxBytes,
      });
      const fresh: DocumentEntry = {
        fetchedAt: Date.now(),
        contentType: fetched.contentType ?? options.contentType,
        body: fetched.body.toString("utf8"),
      };
      options.prepare?.(fresh);
      await context.cache.write(options.key, Buffer.from(JSON.stringify(fresh)));
      return fresh;
    });
    return { entry, cache: "miss" };
  } catch (error) {
    if (cached && error instanceof UpstreamError) return { entry: cached, cache: "stale" };
    throw error;
  }
}

export async function serveDocument(
  context: MirrorContext,
  options: DocumentOptions,
): Promise<MirrorResponse> {
  const loaded = await loadDocument(context, options);
  return documentResponse(loaded.entry, options, loaded.cache);
}

export interface ArtifactOptions {
  key: string;
  url: string;
  hosts: ReadonlySet<string>;
  accept?: string;
  maxBytes: number;
  contentType: string;
  /** Checks the downloaded bytes against a hash the index published; omitted where none exists. */
  verify?: (digests: ArtifactDigests) => void | Promise<void>;
}

/**
 * Serves an immutable artifact from the content cache, downloading and verifying it once when
 * missing. A file larger than the whole cache is refused rather than streamed uncached.
 */
export async function serveArtifact(
  context: MirrorContext,
  options: ArtifactOptions,
): Promise<MirrorResponse> {
  const cached = await context.cache.open(options.key);
  if (cached)
    return {
      status: 200,
      headers: artifactHeaders(options.contentType),
      body: cached,
      cache: "hit",
    };
  await context.artifacts.run(options.key, async () => {
    if (context.cache.has(options.key)) return;
    const download = await context.fetcher.fetchToFile(options.url, {
      hosts: options.hosts,
      accept: options.accept,
      maxBytes: Math.min(options.maxBytes, context.config.maxBytes),
      directory: context.tempDir,
    });
    try {
      await options.verify?.(download.digests);
      if (!(await context.cache.adopt(options.key, download.path, download.size)))
        throw new UpstreamError("artifact is larger than the mirror cache", 502);
    } finally {
      await rm(download.path, { force: true });
    }
  });
  const stored = await context.cache.open(options.key);
  if (!stored) throw new UpstreamError("artifact could not be cached", 502);
  return {
    status: 200,
    headers: artifactHeaders(options.contentType),
    body: stored,
    cache: "miss",
  };
}

function documentResponse(
  entry: DocumentEntry,
  options: DocumentOptions,
  cache: "hit" | "miss" | "stale",
): MirrorResponse {
  const rewritten = options.rewrite(entry);
  return {
    status: 200,
    headers: {
      "content-type": rewritten.contentType,
      "cache-control": documentCacheControl(options.ttlMs, cache),
    },
    body: Buffer.from(rewritten.body, "utf8"),
    cache,
  };
}

function documentCacheControl(ttlMs: number, cache: "hit" | "miss" | "stale"): string {
  if (cache === "stale") return "public, max-age=60";
  if (!Number.isFinite(ttlMs)) return "public, max-age=31536000, immutable";
  return `public, max-age=${Math.max(0, Math.floor(ttlMs / 1000))}`;
}

function artifactHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
  };
}
