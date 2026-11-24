import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiskCache } from "./cache.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function cache(maxBytes: number): Promise<{ cache: DiskCache; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "rakazo-package-cache-"));
  directories.push(directory);
  const cache = new DiskCache(directory, maxBytes);
  await cache.init();
  return { cache, directory };
}

describe("disk cache", () => {
  it("evicts the least recently used entry to stay under the cap", async () => {
    const { cache: disk } = await cache(10);
    expect(await disk.write("npm/a", Buffer.alloc(6, 1))).toBe(true);
    expect(await disk.write("npm/b", Buffer.alloc(6, 2))).toBe(true);

    expect(await disk.read("npm/a")).toBeUndefined();
    expect((await disk.read("npm/b"))?.byteLength).toBe(6);
    expect(disk.stats().bytes).toBeLessThanOrEqual(10);
  });

  it("refuses one artifact larger than the whole cache", async () => {
    const { cache: disk } = await cache(10);
    expect(await disk.write("npm/large", Buffer.alloc(11))).toBe(false);
    expect(disk.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 10 });
  });

  it("rejects keys that could leave the cache directory", async () => {
    const { cache: disk } = await cache(1024);
    for (const key of ["../escape", "npm/../../escape", "npm/..", "/absolute", "npm/back\\slash"]) {
      expect(() => disk.pathFor(key), key).toThrow();
    }
  });

  it("reloads entries after a restart", async () => {
    const { cache: disk, directory } = await cache(1024);
    await disk.write("npm/a", Buffer.from("kept"));
    const reopened = new DiskCache(directory, 1024);
    await reopened.init();
    expect((await reopened.read("npm/a"))?.toString()).toBe("kept");
  });
});
