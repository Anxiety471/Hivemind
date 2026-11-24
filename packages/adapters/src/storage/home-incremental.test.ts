import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeArchiveError, packHome } from "./home-archive.js";
import type { PreviousRevision } from "./home-incremental.js";
import { prepareRevision, readManifest, restoreHome } from "./home-incremental.js";

const dirs: string[] = [];
const limits = { maxBytes: 1024 ** 3, maxEntries: 100_000 };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-home-incremental-"));
  dirs.push(dir);
  return dir;
}

async function* chunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += 777)
    yield bytes.subarray(offset, offset + 777);
}

async function write(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

/** Revisions as a bucket would hold them, each saved on top of the last. */
function bucket() {
  const revisions = new Map<string, Buffer>();
  let previous: PreviousRevision | undefined;
  return {
    revisions,
    async save(root: string) {
      const scratch = await tempDir();
      const prepared = await prepareRevision({ root, previous, limits, scratch });
      const parts: Buffer[] = [];
      for await (const part of prepared.stream()) parts.push(part);
      await prepared.dispose();
      const revision = `rev-${revisions.size + 1}`;
      const bytes = Buffer.concat(parts);
      revisions.set(revision, bytes);
      previous = { revision, manifest: (await readManifest(chunks(bytes), limits))! };
      return { revision, bytes, prepared };
    },
    async restore(revision: string, dest = tempDir()) {
      const target = await dest;
      await restoreHome(
        chunks(revisions.get(revision)!),
        (earlier) => chunks(revisions.get(earlier)!),
        target,
        limits,
      );
      return target;
    },
  };
}

async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(found, { [`${relative}/`]: "" }, await tree(root, relative));
    else found[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return found;
}

describe("incremental home revisions", () => {
  it("restores a whole home, with empty files, modes and files of the same contents", async () => {
    const home = await tempDir();
    await write(home, {
      "a.txt": "alpha",
      "dir/b.txt": "same contents",
      "dir/copy.txt": "same contents",
      "empty.txt": "",
      "deep/er/c.txt": "gamma",
    });
    await chmod(path.join(home, "a.txt"), 0o750);
    const saved = bucket();
    const { revision, prepared } = await saved.save(home);
    // Files of the same contents are stored once.
    expect(prepared.stats.ownBytes).toBe("alpha".length + "same contents".length + "gamma".length);

    const restored = await saved.restore(revision);
    expect(await tree(restored)).toEqual(await tree(home));
    expect((await stat(path.join(restored, "a.txt"))).mode & 0o777).toBe(0o750);
  });

  it("stores only what changed and still restores the whole home", async () => {
    const home = await tempDir();
    await write(home, { "keep.txt": "kept ".repeat(1000), "edit.txt": "v1", "gone.txt": "bye" });
    // Files that settled long before a save are trusted without being read again.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const saved = bucket();
    const first = await saved.save(home);
    expect(first.prepared.references).toEqual([]);

    await writeFile(path.join(home, "edit.txt"), "v2");
    await write(home, { "new.txt": "fresh" });
    await rm(path.join(home, "gone.txt"));
    const second = await saved.save(home);

    expect(second.prepared.references).toEqual([first.revision]);
    expect(second.prepared.stats.ownBytes).toBe("v2".length + "fresh".length);
    expect(second.prepared.stats.reused).toBe(1);
    expect(second.bytes.length).toBeLessThan(first.bytes.length);
    expect(await tree(await saved.restore(second.revision))).toEqual(await tree(home));
    // Earlier revisions stay readable as they were.
    expect((await tree(await saved.restore(first.revision)))["gone.txt"]).toBe("bye");
  });

  it("notices a same-size rewrite whose modification time was put back", async () => {
    const home = await tempDir();
    await write(home, { "data.txt": "aaaa" });
    const old = new Date(Date.now() - 3600_000);
    await utimes(path.join(home, "data.txt"), old, old);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const saved = bucket();
    await saved.save(home);

    await writeFile(path.join(home, "data.txt"), "bbbb");
    await utimes(path.join(home, "data.txt"), old, old);
    const second = await saved.save(home);

    expect(second.prepared.stats.reused).toBe(0);
    expect(
      await readFile(path.join(await saved.restore(second.revision), "data.txt"), "utf8"),
    ).toBe("bbbb");
  });

  it("starts over with a revision that reads from none once too many are read from", async () => {
    const home = await tempDir();
    await write(home, { "stable.txt": "stable", "edit.txt": "0" });
    const saved = bucket();
    let latest = await saved.save(home);
    let widest = 0;
    for (let round = 1; round <= 40; round++) {
      await write(home, { "edit.txt": String(round) });
      latest = await saved.save(home);
      widest = Math.max(widest, latest.prepared.references.length);
    }
    expect(widest).toBeLessThanOrEqual(32);
    expect(latest.prepared.references.length).toBeLessThan(32);
    expect(await tree(await saved.restore(latest.revision))).toEqual(await tree(home));
  });

  it("refuses a file whose bytes do not match the stored hash", async () => {
    const home = await tempDir();
    await write(home, { "a.txt": "original" });
    const saved = bucket();
    const { revision, bytes } = await saved.save(home);
    const tampered = Buffer.from(bytes);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
    saved.revisions.set(revision, tampered);
    await expect(saved.restore(revision)).rejects.toThrow(HomeArchiveError);
  });

  it("refuses a table naming a path outside the home", async () => {
    const header = Buffer.from(JSON.stringify({ startedAtMs: 0, dataBytes: 0, refs: [] }));
    const row = JSON.stringify([1, "../escape.txt", 0o644, 0, 0, "0".repeat(64), -1, 0]);
    const table = gzipSync(Buffer.from(`${row}\n`));
    const length = (value: number) => Buffer.from([0, 0, value >> 8, value & 0xff]);
    const revision = Buffer.concat([
      Buffer.from("RKZI\x01", "latin1"),
      length(header.length),
      header,
      length(table.length),
      table,
    ]);
    const dest = await tempDir();
    await expect(
      restoreHome(chunks(revision), () => chunks(Buffer.alloc(0)), dest, limits),
    ).rejects.toThrow("corrupt");
    expect(await readdir(dest)).toEqual([]);
  });

  it("does not take a whole archive for an incremental revision", async () => {
    const home = await tempDir();
    await write(home, { "a.txt": "a" });
    const parts: Buffer[] = [];
    for await (const part of packHome(home)) parts.push(part);
    expect(await readManifest(chunks(Buffer.concat(parts)), limits)).toBeUndefined();
  });
});
