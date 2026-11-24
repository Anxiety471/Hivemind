import { mkdir, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { DiskCache } from "./cache.js";
import { handleComposer } from "./composer.js";
import type { MirrorConfig } from "./config.js";
import { mirrorHostAllowlists } from "./config.js";
import type { MirrorContext } from "./context.js";
import { handleCrates } from "./crates.js";
import { readDocument } from "./documents.js";
import { BadRequestError, IntegrityError, UpstreamError } from "./errors.js";
import { handleGo } from "./go.js";
import { handleNpm } from "./npm.js";
import { handlePyPi } from "./pypi.js";
import { PyPiFileIndex } from "./pypi-files.js";
import type { MirrorResponse } from "./response.js";
import { SingleFlight } from "./single-flight.js";
import { UpstreamFetcher } from "./upstream.js";

/** Builds the mirror's state, then a plain `node:http` server over it. */
export async function createMirrorServer(config: MirrorConfig): Promise<Server> {
  const context = await createMirrorContext(config);
  return createServer((request, response) => {
    void handle(context, request, response);
  });
}

export async function createMirrorContext(config: MirrorConfig): Promise<MirrorContext> {
  const cache = new DiskCache(path.join(config.dataDir, "cache"), config.maxBytes);
  await cache.init();
  const tempDir = path.join(config.dataDir, "tmp");
  await mkdir(tempDir, { recursive: true });
  await removeStaleTemps(tempDir);
  const hosts = mirrorHostAllowlists(config);
  const pypiFiles = new PyPiFileIndex();
  for (const key of cache.keys("pypi/index/")) {
    const entry = await readDocument(cache, key);
    if (!entry?.files) continue;
    pypiFiles.set(key.slice("pypi/index/".length, -".json".length), entry.files);
  }
  return {
    config,
    hosts,
    cache,
    fetcher: new UpstreamFetcher({
      timeoutMs: config.upstreamTimeoutMs,
      maxConcurrent: config.maxConcurrentFetches,
    }),
    documents: new SingleFlight(),
    artifacts: new SingleFlight(),
    pypiFiles,
    tempDir,
  };
}

async function handle(
  context: MirrorContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const headOnly = request.method === "HEAD";
  try {
    if (request.method !== "GET" && !headOnly) {
      response.writeHead(405, {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("method not allowed\n");
      return;
    }
    const rawUrl = request.url ?? "/";
    const query = rawUrl.indexOf("?");
    const rawPath = query >= 0 ? rawUrl.slice(0, query) : rawUrl;
    if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("\0"))
      throw new BadRequestError("invalid request path");
    const result = await route(context, rawPath);
    send(response, result, headOnly);
  } catch (error) {
    sendError(response, error, headOnly);
  }
}

async function route(context: MirrorContext, rawPath: string): Promise<MirrorResponse> {
  if (rawPath === "/health") {
    return {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: Buffer.from(JSON.stringify({ status: "ok", cache: context.cache.stats() })),
    };
  }
  if (rawPath.startsWith("/npm/")) return handleNpm(context, rawPath.slice("/npm/".length));
  if (rawPath.startsWith("/go/")) return handleGo(context, rawPath.slice("/go/".length));
  if (rawPath.startsWith("/pypi/")) return handlePyPi(context, rawPath.slice("/pypi/".length));
  if (rawPath.startsWith("/crates/"))
    return handleCrates(context, rawPath.slice("/crates/".length));
  if (rawPath.startsWith("/composer/"))
    return handleComposer(context, rawPath.slice("/composer/".length));
  throw new UpstreamError("not found", 404);
}

function send(response: ServerResponse, result: MirrorResponse, headOnly: boolean): void {
  const headers: Record<string, string> = { ...result.headers };
  if (result.cache) headers["x-cache"] = result.cache;
  const body = result.body;
  if (Buffer.isBuffer(body)) {
    headers["content-length"] = String(body.byteLength);
    response.writeHead(result.status, headers);
    response.end(headOnly ? undefined : body);
    return;
  }
  headers["content-length"] = String(body.size);
  response.writeHead(result.status, headers);
  if (headOnly) {
    body.stream.destroy();
    response.end();
    return;
  }
  body.stream.on("error", () => response.destroy());
  response.on("close", () => body.stream.destroy());
  body.stream.pipe(response);
}

function sendError(response: ServerResponse, error: unknown, headOnly: boolean): void {
  let status = 500;
  let message = "internal error";
  if (error instanceof BadRequestError || error instanceof UpstreamError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof IntegrityError) {
    status = error.status;
    message = error.message;
  } else {
    console.error("package mirror request failed", error);
  }
  const body = Buffer.from(`${message}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  });
  response.end(headOnly ? undefined : body);
}

async function removeStaleTemps(directory: string): Promise<void> {
  for (const name of await readdir(directory))
    if (name.startsWith(".tmp-")) await rm(path.join(directory, name), { force: true });
}
