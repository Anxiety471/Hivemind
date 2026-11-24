import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MirrorConfig } from "./config.js";
import { createMirrorServer } from "./server.js";

export interface FakeResponse {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Holds the answer open so concurrent requests reach the mirror together. */
  delayMs?: number;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface FakeUpstream {
  url: string;
  requests: FakeRequest[];
  respond(requestPath: string, response: FakeResponse): void;
  close(): Promise<void>;
}

/** A local stand-in for every upstream host; tests point each ecosystem at it. */
export async function fakeUpstream(): Promise<FakeUpstream> {
  const routes = new Map<string, FakeResponse>();
  const requests: FakeRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
    });
    const route = routes.get(request.url ?? "/");
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const answer = () => {
      response.writeHead(route.status ?? 200, {
        "content-type": route.contentType ?? "application/octet-stream",
        ...route.headers,
      });
      response.end(route.body ?? "");
    };
    if (route.delayMs) setTimeout(answer, route.delayMs);
    else answer();
  });
  await listen(server);
  return {
    url: origin(server),
    requests,
    respond: (requestPath, response) => routes.set(requestPath, response),
    close: () => close(server),
  };
}

export interface RunningMirror {
  url: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startMirror(
  upstreamUrl: string,
  overrides: Partial<MirrorConfig> = {},
): Promise<RunningMirror> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-package-mirror-"));
  const config: MirrorConfig = {
    dataDir,
    publicUrl: "http://mirror.test",
    host: "127.0.0.1",
    port: 0,
    maxBytes: 1024 * 1024,
    indexTtlMs: 5 * 60_000,
    upstreamTimeoutMs: 5_000,
    maxConcurrentFetches: 4,
    npmUpstream: upstreamUrl,
    goUpstream: upstreamUrl,
    pypiUpstream: upstreamUrl,
    pypiFilesUpstream: upstreamUrl,
    ...overrides,
  };
  const server = await createMirrorServer(config);
  await listen(server);
  return {
    url: origin(server),
    dataDir,
    close: async () => {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function origin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
