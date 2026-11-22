/** A read that event-driven callers share; the promise it returns covers the read they joined. */
export interface RefreshCoalescer {
  invalidate(): Promise<void>;
  dispose(): void;
}

/** Share event-driven reads while retaining invalidations that arrive during a read. */
export function createRefreshCoalescer(refresh: () => Promise<unknown>): RefreshCoalescer {
  let pending: Promise<void> | null = null;
  let dirty = false;
  let disposed = false;

  async function drain() {
    let failed = false;
    let lastError: unknown;
    while (dirty && !disposed) {
      dirty = false;
      try {
        await refresh();
        failed = false;
      } catch (error) {
        failed = true;
        lastError = error;
      }
    }
    // Clear in the same turn as the final dirty check, so a new invalidation
    // cannot attach to a completed drain and lose its refresh.
    pending = null;
    if (failed) throw lastError;
  }

  return {
    invalidate(): Promise<void> {
      if (disposed) return Promise.resolve();
      dirty = true;
      pending ??= Promise.resolve().then(drain);
      return pending;
    },
    dispose() {
      disposed = true;
      dirty = false;
    },
  };
}
