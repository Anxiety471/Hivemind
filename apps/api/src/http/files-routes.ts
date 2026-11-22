import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor, DriveFile } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { clientErrorStatus } from "../client-error-status.js";
import type { DriveUploadParams } from "../content/files/index.js";
import {
  DriveFileTooLargeError,
  DriveNotFoundError,
  DriveValidationError,
  formatContentDisposition,
  isSafeInlineMedia,
  matchesIfNoneMatch,
  openSpaceFileContent,
  parseSingleByteRange,
  statSpaceFileContent,
  uploadSpaceFileStream,
} from "../content/files/index.js";

/**
 * Plain HTTP endpoints of the Space Drive: `POST /api/v1/files` (streaming multipart or raw
 * binary) and `GET`/`HEAD /api/v1/files/:id/content` (Range playback, ETag revalidation).
 * Mirrors apps/api-go/internal/drive/http.go; the Go gateway answers first in production and
 * this mount keeps an API-only deployment complete.
 */

/** One multipart form field, trimmed like Go's 8 KiB LimitReader. */
const MAX_FIELD_BYTES = 8 * 1024;
/** Cap for one part's header block; a browser sends a few hundred bytes. */
const MAX_HEADER_BYTES = 16 * 1024;

export type MultipartPart =
  | { kind: "field"; name: string; value: string }
  | {
      kind: "file";
      name: string;
      fileName?: string;
      contentType?: string;
      stream: AsyncIterable<Uint8Array>;
    };

export interface FileRouteDeps {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  maxFileUploadSizeBytes: number;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
  /**
   * Resolves the signed-in user and the Space they asked for (header or query). Returns null
   * when the session is missing or the user is not a member of that Space.
   */
  resolveActor: (request: Request, requestedSpaceId: string | null) => Promise<Actor | null>;
}

/** Buffers a web body just enough to find multipart delimiters without holding the file. */
class ChunkReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(body: ReadableStream<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.from(next.value);
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    return true;
  }

  /** Reads through `token`, keeping at most `limit` bytes of what came before it. */
  async readBoundedUntil(
    token: Buffer,
    limit: number,
  ): Promise<{ value: Buffer; truncated: boolean }> {
    let kept = Buffer.alloc(0);
    let truncated = false;
    const append = (bytes: Buffer) => {
      if (truncated) return;
      const room = limit - kept.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (bytes.length > room) {
        kept = Buffer.concat([kept, bytes.subarray(0, room)]);
        truncated = true;
        return;
      }
      kept = Buffer.concat([kept, bytes]);
    };
    for (;;) {
      const index = this.buffer.indexOf(token);
      if (index >= 0) {
        append(this.buffer.subarray(0, index));
        this.buffer = this.buffer.subarray(index + token.length);
        return { value: kept, truncated };
      }
      const tail = Math.min(token.length - 1, this.buffer.length);
      const emit = this.buffer.length - tail;
      if (emit > 0) {
        append(this.buffer.subarray(0, emit));
        this.buffer = this.buffer.subarray(emit);
      }
      if (!(await this.pull())) {
        append(this.buffer);
        this.buffer = Buffer.alloc(0);
        return { value: kept, truncated };
      }
    }
  }

  /** Reads exactly `count` bytes; a short body is malformed multipart. */
  async readExact(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      if (!(await this.pull())) throw new DriveValidationError("Invalid multipart stream");
    }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** Streams a part body until `token`, then consumes the delimiter. */
  async *bodyUntil(token: Buffer): AsyncGenerator<Uint8Array> {
    for (;;) {
      const index = this.buffer.indexOf(token);
      if (index >= 0) {
        if (index > 0) yield this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + token.length);
        return;
      }
      const tail = Math.min(token.length - 1, this.buffer.length);
      const emit = this.buffer.length - tail;
      if (emit > 0) {
        yield this.buffer.subarray(0, emit);
        this.buffer = this.buffer.subarray(emit);
      }
      if (!(await this.pull())) {
        if (this.buffer.length > 0) yield this.buffer;
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }
}

function partHeaders(raw: string): {
  name: string;
  fileName?: string;
  contentType?: string;
} {
  let name = "";
  let fileName: string | undefined;
  let contentType: string | undefined;
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-disposition") {
      name = dispositionParam(value, "name") ?? "";
      fileName = dispositionParam(value, "filename") ?? undefined;
    } else if (key === "content-type") {
      contentType = value;
    }
  }
  return { name, fileName, contentType };
}

function dispositionParam(header: string, key: string): string | null {
  const quoted = new RegExp(`(?:^|;)\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, "i").exec(header);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
  const bare = new RegExp(`(?:^|;)\\s*${key}=([^;]+)`, "i").exec(header);
  return bare?.[1]?.trim() ?? null;
}

/**
 * Reads one multipart stream. Metadata fields arrive before the file part, as Go's single-pass
 * `MultipartReader` requires; the file part is streamed, never buffered.
 */
export async function* openMultipartParts(
  body: ReadableStream<Uint8Array>,
  boundary: string,
): AsyncGenerator<MultipartPart> {
  const reader = new ChunkReader(body);
  const opening = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  await reader.readBoundedUntil(opening, 0);
  const afterOpening = (await reader.readExact(2)).toString("latin1");
  if (afterOpening === "--") return;
  if (afterOpening !== "\r\n") throw new DriveValidationError("Invalid multipart upload payload");
  for (;;) {
    const header = await reader.readBoundedUntil(Buffer.from("\r\n\r\n"), MAX_HEADER_BYTES);
    if (header.truncated) throw new DriveValidationError("Invalid multipart headers");
    const headers = partHeaders(header.value.toString("utf8"));
    if (headers.name === "file") {
      yield {
        kind: "file",
        name: headers.name,
        fileName: headers.fileName,
        contentType: headers.contentType,
        stream: reader.bodyUntil(delimiter),
      };
      // Go stops reading after the first file part; the rest of the body is never consumed.
      return;
    }
    const field = await reader.readBoundedUntil(delimiter, MAX_FIELD_BYTES);
    const afterField = (await reader.readExact(2)).toString("latin1");
    if (afterField !== "--" && afterField !== "\r\n") {
      throw new DriveValidationError("Invalid multipart stream");
    }
    yield { kind: "field", name: headers.name, value: field.value.toString("utf8").trim() };
    if (afterField === "--") return;
  }
}

function multipartBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  return boundary || null;
}

function optQueryOrHeader(c: Context, queryKey: string, headerKey: string): string | null {
  const header = c.req.header(headerKey)?.trim();
  if (header) return header;
  const query = c.req.query(queryKey)?.trim();
  return query || null;
}

function applyUploadField(params: DriveUploadParams, name: string, raw: string): void {
  const value = raw.trim();
  switch (name) {
    case "folderId":
      params.folderId = value || null;
      break;
    case "botId":
      params.botId = value || null;
      break;
    case "groupId":
      params.groupId = value || null;
      break;
    case "runId":
      params.runId = value || null;
      break;
    case "source":
      if (value) params.source = value;
      break;
    case "name":
      if (value) params.name = value;
      break;
    case "description":
      params.description = value || null;
      break;
    case "mimeType":
      if (value) params.mimeType = value;
      break;
    case "clientNonce":
      params.clientNonce = value || null;
      break;
    default:
      break;
  }
}

/** 413 has no ClientErrorKind; the upload cap is the only refusal that needs it. */
export function fileErrorStatus(error: ClientError): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 {
  return error instanceof DriveFileTooLargeError ? 413 : clientErrorStatus(error.kind);
}

/** Go's oRPC error body, so clients already read this endpoint's failures. */
function fileError(c: Context, error: unknown): Response {
  if (!(error instanceof ClientError)) throw error;
  const status = fileErrorStatus(error);
  if (status >= 500) getLogger().error("files request failed", { "files.code": error.code });
  return c.json(
    {
      json: {
        defined: false,
        code: error.code,
        status,
        message: error.message,
      },
    },
    status,
  );
}

/**
 * Streams a decrypted artifact to the response. Each step re-enters the tenant scope: the
 * reader resolves content keys lazily, and the response body is read after the route returns.
 */
function toWebStream(
  source: AsyncIterable<Uint8Array>,
  within: <T>(work: () => Promise<T>) => Promise<T>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await within(() => iterator.next());
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await within(async () => {
        await iterator.return?.();
      });
    },
  });
}

function contentHeaders(meta: { hash: string; mimeType: string; name: string }): Headers {
  const headers = new Headers();
  if (meta.hash) headers.set("etag", `"${meta.hash}"`);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, max-age=3600, stale-while-revalidate=86400");
  headers.set(
    "access-control-expose-headers",
    "Content-Range, Accept-Ranges, Content-Length, ETag, Content-Disposition",
  );
  return headers;
}

export function mountFileRoutes(app: Hono, deps: FileRouteDeps): void {
  const authenticate = async (c: Context): Promise<Actor | null> => {
    const requested =
      c.req.header("x-rakazo-space-id")?.trim() || c.req.query("spaceId")?.trim() || null;
    return deps.resolveActor(c.req.raw, requested);
  };

  const readUploadBody = async (
    c: Context,
    actor: Actor,
    params: DriveUploadParams,
  ): Promise<DriveFile> => {
    const contentType = c.req.header("content-type") ?? "";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const body = c.req.raw.body;
    if (!body) throw new DriveValidationError("Missing upload body");
    if (!mediaType.startsWith("multipart/")) {
      return uploadSpaceFileStream(
        deps,
        actor,
        {
          ...params,
          name: params.name || "upload",
          mimeType: params.mimeType || mediaType,
        },
        (async function* () {
          for await (const chunk of body) yield chunk;
        })(),
      );
    }
    const boundary = multipartBoundary(contentType);
    if (!boundary) throw new DriveValidationError("Invalid multipart upload payload");
    for await (const part of openMultipartParts(body, boundary)) {
      if (part.kind === "field") {
        applyUploadField(params, part.name, part.value);
        continue;
      }
      return uploadSpaceFileStream(
        deps,
        actor,
        {
          ...params,
          name: params.name || part.fileName,
          mimeType: params.mimeType || part.contentType,
        },
        part.stream,
      );
    }
    throw new DriveValidationError("Missing file form part");
  };

  const upload = async (c: Context, actor: Actor): Promise<Response> => {
    const params: DriveUploadParams = {
      folderId: optQueryOrHeader(c, "folderId", "X-File-Folder-Id"),
      botId: optQueryOrHeader(c, "botId", "X-File-Bot-Id"),
      groupId: optQueryOrHeader(c, "groupId", "X-File-Group-Id"),
      runId: optQueryOrHeader(c, "runId", "X-File-Run-Id"),
      source: optQueryOrHeader(c, "source", "X-File-Source") ?? "upload",
      name: optQueryOrHeader(c, "name", "X-File-Name"),
      description: optQueryOrHeader(c, "description", "X-File-Description"),
      mimeType: optQueryOrHeader(c, "mimeType", "X-File-Mime-Type"),
      clientNonce: optQueryOrHeader(c, "clientNonce", "X-File-Nonce"),
    };
    const uploaded = await readUploadBody(c, actor, params);
    await bestEffort(
      "files upload space change",
      deps.events?.publishSpaceChange?.(actor.spaceId, "files"),
    );
    return Response.json(uploaded, { status: 201, headers: { "cache-control": "no-store" } });
  };

  app.post("/api/v1/files", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return fileError(c, new ClientError("UNAUTHORIZED", "Unauthorized"));
    try {
      return await runAsTenant(actor, () => upload(c, actor));
    } catch (error) {
      return fileError(c, error);
    }
  });

  const content = async (c: Context, actor: Actor): Promise<Response> => {
    const fileId = c.req.param("id") ?? "";
    if (!fileId || fileId.includes("/") || fileId.includes("\\")) {
      return fileError(c, new DriveNotFoundError("File not found"));
    }
    const meta = await runAsTenant(actor, () => statSpaceFileContent(deps, actor, fileId));
    const headers = contentHeaders(meta);
    const etag = `"${meta.hash}"`;
    if (meta.hash && matchesIfNoneMatch(c.req.header("if-none-match") ?? "", etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-type", meta.mimeType);
    const download = c.req.query("download") === "1";
    headers.set(
      "content-disposition",
      formatContentDisposition(!download && isSafeInlineMedia(meta.mimeType), meta.name),
    );
    const { range, unsatisfiable } = parseSingleByteRange(c.req.header("range") ?? "", meta.size);
    if (unsatisfiable) {
      headers.set("content-range", `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (c.req.method === "HEAD") {
      if (range) {
        headers.set("content-range", `bytes ${range.start}-${range.endInclusive}/${meta.size}`);
        headers.set("content-length", String(range.endInclusive - range.start + 1));
        return new Response(null, { status: 206, headers });
      }
      headers.set("content-length", String(meta.size));
      return new Response(null, { status: 200, headers });
    }

    const opened = await runAsTenant(actor, () => openSpaceFileContent(deps, actor, fileId, range));
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.start}-${range.endInclusive}/${opened.totalSize}`,
      );
      headers.set("content-length", String(range.endInclusive - range.start + 1));
      return new Response(
        toWebStream(opened.stream, (work) => runAsTenant(actor, work)),
        {
          status: 206,
          headers,
        },
      );
    }
    headers.set("content-length", String(opened.totalSize));
    return new Response(
      toWebStream(opened.stream, (work) => runAsTenant(actor, work)),
      {
        status: 200,
        headers,
      },
    );
  };

  app.on(["GET", "HEAD"], "/api/v1/files/:id/content", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return fileError(c, new ClientError("UNAUTHORIZED", "Unauthorized"));
    try {
      return await content(c, actor);
    } catch (error) {
      return fileError(c, error);
    }
  });
}
