import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deferred } from "@rakazo/core/test-async";
import type { DataKey } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHomeRecords, StoredHome } from "./home-object-store.js";
import { ObjectAgentHomeStore } from "./home-object-store.js";
import { takeHomeSaveLease } from "./home-save-lease.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The one home row a save needs, without a database. */
function memoryRecords() {
  const homes = new Map<string, StoredHome>();
  const key: DataKey = { id: "k1", spaceId: "space-1", version: 1, key: randomBytes(32) };
  const records: AgentHomeRecords = {
    load: async (homeKey) => homes.get(homeKey),
    create: async (homeKey) => {
      if (!homes.has(homeKey)) homes.set(homeKey, { storageId: "storage-1", revision: null, key });
      return homes.get(homeKey);
    },
    advance: async (homeKey, storageId, from, to) => {
      const home = homes.get(homeKey);
      if (!home || home.storageId !== storageId || home.revision !== from) return false;
      home.revision = to;
      return true;
    },
    prune: async () => [],
    versions: async () => undefined,
    restore: async () => undefined,
    revisions: async () => new Map(),
    kinds: async (homeKeys) => new Map(homeKeys.map((homeKey) => [homeKey, "boat"])),
  };
  return { records, homes };
}

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A sandbox export staged for `commit`. */
async function staged(files: Record<string, string>) {
  const dir = await tempDir("rakazo-save-lease-staging-");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe("one home, one save at a time", () => {
  it("waits for the save already packing instead of packing the same bytes again", async () => {
    const root = await tempDir("rakazo-save-lease-homes-");
    const storage = new MemoryObjectStorage();
    const { records } = memoryRecords();
    // The API and the worker share the data directory and each has its own store.
    const api = new ObjectAgentHomeStore(root, storage, records);
    const worker = new ObjectAgentHomeStore(root, storage, records);

    const put = storage.put.bind(storage);
    const packing = deferred();
    const release = deferred();
    let packed = 0;
    storage.put = async (key, body) => {
      packed += 1;
      if (packed === 1) {
        packing.resolve();
        await release.promise;
      }
      return put(key, body);
    };

    const first = api.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await packing.promise;
    const second = worker.commit("bot-1", await staged({ "a.txt": "later" }), context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The second save waits for the first: nothing else is read or sealed from the same home.
    expect(packed).toBe(1);

    release.resolve();
    await first;
    await second;
    storage.put = put;
    // Both saves landed, one after the other, so the home points at the later one.
    expect(packed).toBe(2);
    expect(await api.readFile("bot-1", "a.txt", context)).toBe("later");
  });

  it("takes over a lease the process that held it never released", async () => {
    const root = await tempDir("rakazo-save-lease-stale-");
    const home = path.join(root, "homes", "bot-1");
    await mkdir(home, { recursive: true });
    const stale = path.join(root, "homes", "bot-1.saving");
    await writeFile(stale, '{"pid":1}');
    const old = new Date(Date.now() - 31 * 60_000);
    await utimes(stale, old, old);

    const release = await takeHomeSaveLease(home);
    await release();
    const again = await takeHomeSaveLease(home);
    await again();
  });

  it("releases a lease, and releasing it twice is harmless", async () => {
    const root = await tempDir("rakazo-save-lease-forever-");
    const home = path.join(root, "homes", "bot-1");
    await mkdir(home, { recursive: true });
    const lease = await takeHomeSaveLease(home);
    const released = await lease();
    expect(released).toBeUndefined();
    // The release is safe to repeat, so a save that errors still leaves nothing behind.
    await lease();
  });
});
