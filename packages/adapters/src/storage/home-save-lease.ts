import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pollUntil } from "@rakazo/core";

/** Beside a home's cache, so the API and the worker see each other's saves. */
const SAVE_LEASE_SUFFIX = ".saving";
/** A lease this old belongs to a save that died; the next save takes it over. */
const SAVE_LEASE_STALE_MS = 30 * 60_000;
/** How often a save waiting on another process's lease looks at it again. */
const SAVE_LEASE_POLL_MS = 100;

/**
 * Holds one home's save while it packs, so the other process sharing the data directory (the API
 * or the worker, each with its own per-bot write chain) waits instead of reading and sealing the
 * same bytes. Two saves of one home packing at once is what doubled its checkpoint disk.
 *
 * Resolves to the release, which is safe to call twice. A lease left by a killed save is taken
 * over once it is clearly stale, and a save that waits that long fails rather than packing
 * alongside the one it could not see finish.
 */
export async function takeHomeSaveLease(homePath: string): Promise<() => Promise<void>> {
  const lease = homePath + SAVE_LEASE_SUFFIX;
  const owner = JSON.stringify({ pid: process.pid, since: new Date().toISOString() });
  await mkdir(path.dirname(lease), { recursive: true });
  let held = false;
  await pollUntil(
    async () => {
      try {
        await writeFile(lease, owner, { flag: "wx" });
        held = true;
        return true;
      } catch (error) {
        if (!isAlreadyThere(error)) throw error;
      }
      if (await isStale(lease)) await rm(lease, { force: true });
      return false;
    },
    {
      intervalMs: SAVE_LEASE_POLL_MS,
      timeoutMs: SAVE_LEASE_STALE_MS,
      waitingFor: "the other process saving this home to finish",
    },
  );
  return async () => {
    if (!held) return;
    held = false;
    await rm(lease, { force: true });
  };
}

async function isStale(lease: string) {
  try {
    return Date.now() - (await stat(lease)).mtimeMs > SAVE_LEASE_STALE_MS;
  } catch (error) {
    // Gone between the refused creation and this look: the next attempt creates it.
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Whether a lease write lost the race to another process that created it first. */
function isAlreadyThere(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
