import { randomUUID } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** One cache path segment. Slashes are separate segments; dot segments never reach here. */
const SAFE_SEGMENT = /^[A-Za-z0-9@._~!+_-]+$/;

interface Entry {
  size: number;
  /** A monotonic access order, seeded from file mtimes so a restart keeps the same order. */
  lastUsed: number;
}

/**
 * A size-capped file cache with least-recently-used eviction. Writes land in a temporary file
 * and are renamed into place, so a reader never sees a partial artifact.
 */
export class DiskCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private clock = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly maxBytes: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.scan(this.root, "");
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Keys under `prefix`, used to rebuild in-memory indexes after a restart. */
  keys(prefix = ""): string[] {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix));
  }

  async read(key: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    try {
      const data = await readFile(this.pathFor(key));
      entry.lastUsed = this.tick();
      return data;
    } catch (error) {
      if (isMissing(error)) {
        this.forget(key);
        return undefined;
      }
      throw error;
    }
  }

  /** Opens a cached artifact for streaming; the caller must consume or destroy the stream. */
  async open(key: string): Promise<{ stream: ReadStream; size: number } | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    try {
      const handle = await open(this.pathFor(key), "r");
      const info = await handle.stat();
      entry.lastUsed = this.tick();
      const stream = handle.createReadStream({ autoClose: false });
      stream.once("close", () => {
        void handle.close().catch(() => undefined);
      });
      return { stream, size: info.size };
    } catch (error) {
      if (isMissing(error)) {
        this.forget(key);
        return undefined;
      }
      throw error;
    }
  }

  /** Caches a small in-memory document. Returns false when it cannot fit. */
  write(key: string, data: Buffer): Promise<boolean> {
    const temp = `${this.pathFor(key)}.${randomUUID()}.tmp`;
    return this.store(key, async (target) => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temp, data);
      await rename(temp, target);
      return data.byteLength;
    }).catch(async (error) => {
      await rm(temp, { force: true });
      throw error;
    });
  }

  /** Moves a fully downloaded temporary file into the cache without copying it. */
  adopt(key: string, tempPath: string, size: number): Promise<boolean> {
    return this.store(key, async (target) => {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(tempPath, target);
      return size;
    });
  }

  stats(): { entries: number; bytes: number; maxBytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes, maxBytes: this.maxBytes };
  }

  /** Absolute path for a cache key, refusing anything that could leave the cache root. */
  pathFor(key: string): string {
    const segments = key.split("/");
    if (segments.length === 0) throw new Error("empty cache key");
    for (const segment of segments)
      if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..")
        throw new Error("invalid cache key");
    const target = path.join(this.root, ...segments);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new Error("invalid cache key");
    return target;
  }

  private store(key: string, write: (target: string) => Promise<number>): Promise<boolean> {
    const run = this.writes.then(async () => {
      const target = this.pathFor(key);
      let size: number;
      try {
        size = await write(target);
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }
      if (size > this.maxBytes) {
        await rm(target, { force: true });
        return false;
      }
      const previous = this.entries.get(key);
      if (previous) this.totalBytes -= previous.size;
      this.entries.set(key, { size, lastUsed: this.tick() });
      this.totalBytes += size;
      await this.evict();
      return true;
    });
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async evict(): Promise<void> {
    if (this.totalBytes <= this.maxBytes) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of oldest) {
      if (this.totalBytes <= this.maxBytes) break;
      this.forget(key);
      await rm(this.pathFor(key), { force: true });
    }
  }

  private forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.size;
    this.entries.delete(key);
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private async scan(dir: string, prefix: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const key = prefix ? `${prefix}/${item.name}` : item.name;
      const target = path.join(dir, item.name);
      if (item.isDirectory()) {
        await this.scan(target, key);
        continue;
      }
      if (!item.isFile() || !SAFE_SEGMENT.test(item.name)) continue;
      const info = await stat(target);
      this.entries.set(key, { size: info.size, lastUsed: info.mtimeMs });
      this.totalBytes += info.size;
      this.clock = Math.max(this.clock, info.mtimeMs);
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
