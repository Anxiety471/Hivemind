import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract, ProductEvent } from "@rakazo/contracts";
import { CLIENT_BUILD_HEADER, formatClientBuild } from "@rakazo/contracts";
import {
  deadlineSignal,
  displayIdentityEvent,
  displayIdentityResult,
  isServerUnreachable,
  isUnreachableStatus,
  parseRetryAfter,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import { authClient } from "../auth/auth";
import { identityLabels } from "../bots/identity-display";
import { i18n } from "../locale/i18n";
import { CLIENT_BUILD } from "../platform/client-build";
import { reportClientError } from "../platform/monitoring";
import { noteServerReachable } from "./connection-state";

const SPACE_STORAGE_KEY = "rakazo:space-id";
export const ORGANIZATION_SPACES_STORAGE_KEY = "rakazo:org-spaces";

type RpcClientContext = {
  spaceId?: string | null;
  /** Finish the call even if the page is closing. */
  keepalive?: boolean;
  /**
   * How long the request may take before it is abandoned and retried. `null` leaves it open, as
   * streams and long mutations need; a call that names none gets {@link RPC_TIMEOUT_MS}.
   */
  timeoutMs?: number | null;
  /** Filled by the link so a failure keeps the status and Retry-After the server sent. */
  responseMeta?: { status?: number; retryAfterMs?: number };
};

/** How long a unary call may stay silent before it is treated as a stalled connection. */
export const RPC_TIMEOUT_MS = 30_000;

const OPEN_PROCEDURES = new Set([
  "threads/subscribe",
  "threads/helperSubscribe",
  "notifications/subscribe",
  "notifications/subscribeCalls",
  "boards/subscribe",
]);

/**
 * A stream stays open for as long as the server has something to say; a sandbox boot, update or
 * reset, a delete that runs through everything a space holds, and a fallback upload that carries a
 * whole file can take minutes. A deadline would cut those off; every other call gets one.
 */
function openForLonger(procedure: string): boolean {
  return (
    OPEN_PROCEDURES.has(procedure) ||
    procedure === "computer/boot" ||
    procedure === "computer/update" ||
    procedure === "computer/reset" ||
    procedure === "computer/recover" ||
    procedure === "spaces/remove" ||
    procedure === "organizations/remove" ||
    procedure === "artifacts/create"
  );
}

/** A request that ran out of time, retryable and reported as a timeout rather than a cancellation. */
function rpcTimeoutError(): Error {
  const error = new Error("The server took too long to answer.");
  error.name = "TimeoutError";
  return error;
}

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Fired after the selected Space changes, so per-organization state (billing) can reload. */
export const SPACE_SELECTED_EVENT = "rakazo:space-selected";

export function selectSpace(id: string): boolean {
  let selected: boolean;
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    selected = true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      selected = window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      selected = false;
    }
  }
  if (selected) window.dispatchEvent(new Event(SPACE_SELECTED_EVENT));
  return selected;
}

export function clearSpaceSelection(): void {
  try {
    window.localStorage.removeItem(SPACE_STORAGE_KEY);
    window.localStorage.removeItem(ORGANIZATION_SPACES_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-rakazo-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  else headers.delete("x-rakazo-space-id");
  return headers;
}

const responseListeners = new Set<(response: Response) => void>();

/** Every API reply, for the build handshake; RPC callers still get their own result. */
export function onRpcResponse(listener: (response: Response) => void): () => void {
  responseListeners.add(listener);
  return () => {
    responseListeners.delete(listener);
  };
}

const link = new RPCLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined" ? "http://127.0.0.1:5173/rpc" : `${window.location.origin}/rpc`,
  fetch: async (input, init, options) => {
    const request = new Request(input, init);
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const correlation = clientCorrelationHeaders();
    const headers = withSpaceHeaders(request.headers, spaceId);
    if (CLIENT_BUILD) headers.set(CLIENT_BUILD_HEADER, formatClientBuild("web", CLIENT_BUILD));
    for (const [key, value] of Object.entries(correlation)) headers.set(key, value);
    const timeoutMs =
      options.context.timeoutMs === null ? null : (options.context.timeoutMs ?? RPC_TIMEOUT_MS);
    // The deadline rides along with the caller's cancellation, so either one ends the request.
    const signal = timeoutMs === null ? options.signal : deadlineSignal(timeoutMs, options.signal);
    let response: Response;
    try {
      response = await fetch(request, {
        headers,
        credentials: "include",
        keepalive: options.context.keepalive,
        // Keep cancellation attached directly to fetch rather than only a cloned Request.
        signal,
      });
    } catch (error) {
      // The caller still holds the request; only our own deadline ran out. That stall is
      // retryable, and it does not mean the server is gone, so reachability is left alone.
      if (timeoutMs !== null && !options.signal?.aborted && signal?.aborted)
        throw rpcTimeoutError();
      if (!options.signal?.aborted && isServerUnreachable(error)) noteServerReachable(false);
      if (!options.signal?.aborted)
        reportClientError(error, "rpc.transport", responseCorrelation(new Headers(correlation)));
      throw error;
    }
    noteServerReachable(!isUnreachableStatus(response.status));
    if (options.context.responseMeta) {
      options.context.responseMeta.status = response.status;
      options.context.responseMeta.retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
      );
    }
    // Server exceptions are reported by the API; do not report every HTTP failure twice.
    recheckSessionOnUnauthorized(response.status);
    if (response.status === 401 && spaceId && spaceId === selectedSpaceId())
      void leaveUnavailableSpace(spaceId);
    for (const listener of responseListeners) listener(response);
    return response;
  },
});

/**
 * A 401 means the session behind the app's last known user may be gone, but Better Auth only
 * rechecks it on focus or a timer, so a backgrounded window would keep its stale user (and every
 * screen that polls) indefinitely. Recheck now: a signed-out answer routes to sign-in.
 */
export function recheckSessionOnUnauthorized(status: number): void {
  if (status === 401) authClient.$store.notify("$sessionSignal");
}

let leavingSpace: Promise<void> | null = null;

/**
 * The server answers 401 when the selected space is no longer one of the user's, for instance
 * after they are removed from it, and every request would keep failing. Ask without a space which
 * spaces the user has in any organization; if the selected one is not among them, reload into
 * their default space.
 */
export function leaveUnavailableSpace(spaceId: string): Promise<void> {
  leavingSpace ??= (async () => {
    try {
      const { organizations } = await rpc.organizations.list(undefined, {
        context: { spaceId: null },
      });
      if (
        organizations.some((organization) => organization.spaceIds.includes(spaceId)) ||
        selectedSpaceId() !== spaceId
      )
        return;
      try {
        window.localStorage.removeItem(SPACE_STORAGE_KEY);
      } catch {
        // Without storage the reload keeps asking without a Space.
      }
      window.location.reload();
    } catch {
      // Signed out or unreachable: leave the selection for the next request to try again.
    } finally {
      leavingSpace = null;
    }
  })();
  return leavingSpace;
}

export type RpcClient = ContractRouterClient<AppContract, RpcClientContext>;

function defineResponseMeta(error: object, key: "status" | "retryAfterMs", value: number): void {
  try {
    Object.defineProperty(error, key, { value, writable: true, configurable: true });
  } catch {
    // An error that refuses new fields keeps only the ones it already had.
  }
}

/**
 * Keep the HTTP status and Retry-After of a failure oRPC could not decode, such as a proxy's
 * HTML 502 or 429, so retry and copy decisions still see them.
 */
function attachResponseMeta(
  error: unknown,
  meta: { status?: number; retryAfterMs?: number },
): void {
  if (typeof error !== "object" || error === null) return;
  const target = error as { status?: unknown; retryAfterMs?: unknown };
  if (target.status === undefined && meta.status !== undefined)
    defineResponseMeta(target, "status", meta.status);
  if (target.retryAfterMs === undefined && meta.retryAfterMs !== undefined)
    defineResponseMeta(target, "retryAfterMs", meta.retryAfterMs);
}

async function callWithResponseMeta<T>(
  call: () => Promise<T>,
  meta: { status?: number; retryAfterMs?: number },
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    attachResponseMeta(error, meta);
    throw error;
  }
}

const displayLink = {
  call: async (...args: Parameters<typeof link.call>) => {
    const [path, input, options] = args;
    const procedure = path.join("/");
    const responseMeta: { status?: number; retryAfterMs?: number } = {};
    const result = await callWithResponseMeta(
      () =>
        link.call(path, input, {
          ...options,
          context: {
            ...options.context,
            responseMeta,
            timeoutMs:
              options.context.timeoutMs !== undefined
                ? options.context.timeoutMs
                : openForLonger(procedure)
                  ? null
                  : RPC_TIMEOUT_MS,
          },
        }),
      responseMeta,
    );
    if (procedure === "threads/subscribe" || procedure === "threads/helperSubscribe") {
      return (async function* () {
        for await (const event of result as AsyncIterable<ProductEvent>) {
          yield displayIdentityEvent(event, identityLabels());
        }
      })();
    }
    // A helper's snapshot is the same shape as an open chat's, so it projects the same way.
    if (procedure === "threads/helperGet") {
      return i18n.locale
        ? displayIdentityResult(["threads", "get"], result, identityLabels())
        : result;
    }
    // Bootstrap can be prefetched before the locale catalog is ready. Its consumer projects it.
    return i18n.locale ? displayIdentityResult(path, result, identityLabels()) : result;
  },
};

export const rpc: RpcClient = createORPCClient(displayLink);

/** Keep late async follow-up requests in the shell's original auth boundary. */
export function createSpaceRpc(spaceId: string | null): typeof rpc {
  return createORPCClient({
    call: (path, input, options) =>
      displayLink.call(path, input, {
        ...options,
        // A call that names its own space (e.g. renaming another space's section) keeps it.
        context: {
          ...options.context,
          spaceId: options.context.spaceId === undefined ? spaceId : options.context.spaceId,
        },
      }),
  });
}

const spaceClients = new Map<string, RpcClient>();

/** Reuse a client for settings without changing the selected space. */
export function rpcForSpace(spaceId: string): RpcClient {
  let client = spaceClients.get(spaceId);
  if (!client) {
    client = createSpaceRpc(spaceId);
    spaceClients.set(spaceId, client);
  }
  return client;
}
