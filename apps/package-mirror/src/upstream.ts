import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { UpstreamError } from "./errors.js";

const MAX_REDIRECTS = 5;
const USER_AGENT = "rakazo-package-mirror";

export interface ArtifactDigests {
  sha256: string;
  sha384: string;
  sha512: string;
  sha1: string;
}

export interface FetchOptions {
  accept?: string;
  maxBytes: number;
  /** Hostnames (with ports) this ecosystem's request or redirect may reach. */
  hosts: ReadonlySet<string>;
}

export interface FetcherOptions {
  timeoutMs: number;
  maxConcurrent: number;
}

/**
 * Fetches from the fixed upstreams only, with a timeout, a response size cap, a redirect
 * allowlist, and a global concurrency limit. Request headers are never forwarded.
 */
export class UpstreamFetcher {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly options: FetcherOptions) {}

  async fetchBuffer(
    url: string,
    options: FetchOptions,
  ): Promise<{
    body: Buffer;
    contentType: string | undefined;
  }> {
    await this.acquire();
    try {
      const response = await this.request(url, options);
      assertDeclaredSize(response, options.maxBytes);
      const chunks: Buffer[] = [];
      for await (const chunk of responseChunks(response, options.maxBytes)) chunks.push(chunk);
      return {
        body: Buffer.concat(chunks),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    } catch (error) {
      throw fetchError(error);
    } finally {
      this.release();
    }
  }

  /** Streams an artifact to a temporary file and hashes it in the same pass. */
  async fetchToFile(
    url: string,
    options: FetchOptions & { directory: string },
  ): Promise<{ path: string; size: number; digests: ArtifactDigests }> {
    const tempPath = path.join(options.directory, `.tmp-${randomUUID()}`);
    await this.acquire();
    try {
      const response = await this.request(url, options);
      assertDeclaredSize(response, options.maxBytes);
      const sha256 = createHash("sha256");
      const sha384 = createHash("sha384");
      const sha512 = createHash("sha512");
      const sha1 = createHash("sha1");
      const handle = await open(tempPath, "w");
      let size = 0;
      try {
        for await (const chunk of responseChunks(response, options.maxBytes)) {
          size += chunk.byteLength;
          sha256.update(chunk);
          sha384.update(chunk);
          sha512.update(chunk);
          sha1.update(chunk);
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      return {
        path: tempPath,
        size,
        digests: {
          sha256: sha256.digest("hex"),
          sha384: sha384.digest("hex"),
          sha512: sha512.digest("hex"),
          sha1: sha1.digest("hex"),
        },
      };
    } catch (error) {
      await rm(tempPath, { force: true });
      throw fetchError(error);
    } finally {
      this.release();
    }
  }

  private async request(url: string, options: FetchOptions): Promise<Response> {
    let current = new URL(url);
    for (let redirects = 0; ; redirects += 1) {
      this.assertAllowed(current, options.hosts);
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          ...(options.accept ? { accept: options.accept } : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (redirects >= MAX_REDIRECTS) throw new UpstreamError("too many upstream redirects", 502);
        if (!location) throw new UpstreamError("upstream redirect has no location", 502);
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new UpstreamError(
          `upstream responded ${response.status}`,
          response.status === 404 ? 404 : 502,
        );
      }
      return response;
    }
  }

  private assertAllowed(url: URL, hosts: ReadonlySet<string>): void {
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new UpstreamError("upstream protocol is not allowed", 502);
    if (url.username || url.password)
      throw new UpstreamError("upstream credentials are not allowed", 502);
    if (!hosts.has(url.host)) throw new UpstreamError("upstream host is not allowed", 502);
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

function assertDeclaredSize(response: Response, maxBytes: number): void {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel();
    throw new UpstreamError("upstream response is too large", 502);
  }
}

async function* responseChunks(response: Response, maxBytes: number): AsyncGenerator<Buffer> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new UpstreamError("upstream response is too large", 502);
      yield Buffer.from(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function fetchError(error: unknown): Error {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return new UpstreamError("upstream request timed out", 504);
  return new UpstreamError("upstream request failed", 502);
}
