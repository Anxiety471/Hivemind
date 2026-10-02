// One shared WebSocket to `/api/v1/ws` with reconnect and a tiny pub/sub.
import { useEffect, useSyncExternalStore } from "react";
import { currentSettings } from "./api";

export type LiveEvent = { type: string; id?: string; payload: Record<string, any>; at: number };
export type LiveStatus = "connecting" | "open" | "closed";

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<(s: LiveStatus) => void>();
const recent: LiveEvent[] = [];
let socket: WebSocket | null = null;
let status: LiveStatus = "closed";
let retry: number | undefined;
let backoff = 500;

function setStatus(next: LiveStatus) {
  status = next;
  statusListeners.forEach((fn) => fn(next));
}

export function connect() {
  clearTimeout(retry);
  socket?.close();
  const { baseUrl, token } = currentSettings();
  const url = baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
  setStatus("connecting");
  // Browsers cannot set Authorization on a WebSocket; the server accepts the token as a subprotocol.
  const ws = token ? new WebSocket(url, [`hivemind.auth.${token}`]) : new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    backoff = 500;
    setStatus("open");
  };
  ws.onmessage = (frame) => {
    let event: LiveEvent;
    try {
      event = { ...JSON.parse(frame.data), at: Date.now() };
    } catch {
      return;
    }
    recent.push(event);
    if (recent.length > 300) recent.shift();
    listeners.forEach((fn) => fn(event));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    setStatus("closed");
    retry = window.setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };
}

export function recentEvents() {
  return recent.slice();
}

/** Run `fn` for every live event while the component is mounted. */
export function useLive(fn: Listener, deps: unknown[] = []) {
  useEffect(() => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

export function useLiveStatus() {
  // Synchronize snapshots during subscription so a fast socket opening between
  // render and effect registration cannot leave the UI stuck on Connecting.
  return useSyncExternalStore(subscribeStatus, () => status, () => "closed" as LiveStatus);
}

/** Re-run `load` when any event matching `match` arrives, coalesced to one call per 250 ms. */
export function useRefreshOn(match: (e: LiveEvent) => boolean, load: () => void, deps: unknown[] = []) {
  useEffect(() => {
    let timer: number | undefined;
    const fn = (e: LiveEvent) => {
      if (e.type === "system.events_lagged" || match(e)) {
        clearTimeout(timer);
        timer = window.setTimeout(load, 250);
      }
    };
    listeners.add(fn);
    return () => {
      clearTimeout(timer);
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
