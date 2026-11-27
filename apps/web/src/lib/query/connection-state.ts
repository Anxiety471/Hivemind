import { useSyncExternalStore } from "react";

/** Whether this device reports a network at all; a browser without `navigator` is a server. */
export function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

let serverReachable = isBrowserOnline();
const listeners = new Set<(reachable: boolean) => void>();

/** False from a request that could not reach the server until the server answers again. */
export function isServerReachable(): boolean {
  return serverReachable;
}

/** Calls `listener` each time the server stops or starts answering. */
export function subscribeServerReachable(listener: (reachable: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteServerReachable(reachable: boolean): void {
  if (reachable === serverReachable) return;
  serverReachable = reachable;
  for (const listener of [...listeners]) listener(reachable);
}

/** Whether the server is answering right now, for a component that must react to it. */
export function useServerReachable(): boolean {
  return useSyncExternalStore(subscribeServerReachable, isServerReachable, () => true);
}

/** Test-only: put the state back to a known value without announcing a transition. */
export function resetServerReachableForTests(reachable: boolean = isBrowserOnline()): void {
  serverReachable = reachable;
}

// A browser that regains its network can reach the server again; losing it cannot.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => noteServerReachable(true));
  window.addEventListener("offline", () => noteServerReachable(false));
}
