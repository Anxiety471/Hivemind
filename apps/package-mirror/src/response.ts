import type { Readable } from "node:stream";

export type MirrorCacheStatus = "hit" | "miss" | "stale";

/** What a protocol handler answers; the server owns turning it into an HTTP response. */
export interface MirrorResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | { stream: Readable; size: number };
  cache?: MirrorCacheStatus;
}
