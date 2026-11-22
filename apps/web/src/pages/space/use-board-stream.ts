import { abortableDelay, isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";

type TicketsOptions = ReturnType<
  ReturnType<typeof useSpaceQueries>["tickets"]["list"]["queryOptions"]
>;

/**
 * Keeps a ticket list live: the board's event stream signals a change, and the list and any open
 * ticket's comments are read again. A dropped stream reconnects, and each connect reads once. The
 * liveness frame a quiet board gets changes nothing, so it reads nothing.
 */
export function useBoardStream(
  ticketsOptions: TicketsOptions,
  onError: (message: string) => void = () => undefined,
  enabled = true,
) {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  // Held as the options' own key so a new object each render does not restart the stream.
  const optionsKey = JSON.stringify(ticketsOptions.queryKey);

  useEffect(() => {
    if (!enabled) return;
    let currentController: AbortController | undefined;
    let active = true;
    let firstConnect = true;
    const refreshComments = (ticketId?: string) =>
      void queryClient.invalidateQueries({
        queryKey: ticketId
          ? queries.tickets.comments.queryKey({ input: { ticketId } })
          : queries.tickets.comments.key(),
      });
    const stopped = new AbortController();
    void (async () => {
      while (active) {
        const controller = new AbortController();
        currentController = controller;
        let failure: unknown;
        let opened = false;
        try {
          const stream = await rpc.boards.subscribe(undefined, {
            signal: controller.signal,
          });
          if (!active) return;
          // The screen that opened this stream asked for the same list; share that read instead
          // of cancelling and repeating it. A reconnect reads fresh: what it missed happened
          // after any read still in flight.
          const reuse = firstConnect;
          firstConnect = false;
          await fetchFresh(queryClient, ticketsOptions, { reuse });
          if (!active) return;
          refreshComments();
          onError("");
          opened = true;
          for await (const event of stream) {
            if (!active) return;
            if (event.heartbeat) continue;
            refreshComments(event.ticketId);
            await fetchFresh(queryClient, ticketsOptions);
          }
        } catch (cause) {
          failure = cause;
          if (active) onError(errorText(cause));
        } finally {
          controller.abort();
        }
        if (!active || !isRetryableError(failure)) return;
        await abortableDelay(
          opened ? reconnectDelayMs(failure) : retryDelayMs(failure, 1_000),
          stopped.signal,
        );
      }
    })();
    return () => {
      active = false;
      currentController?.abort();
      stopped.abort();
    };
  }, [queries, optionsKey, enabled]);
}

/** A bot's tickets, kept live while `enabled`. */
export function useBotTickets(botId: string | undefined, enabled: boolean) {
  const queries = useSpaceQueries();
  const options = queries.tickets.list.queryOptions({
    input: { assigneeBotId: botId },
  });
  const query = useQuery({ ...options, enabled: enabled && Boolean(botId) });
  useBoardStream(options, undefined, enabled && Boolean(botId));
  return query.data?.tickets ?? [];
}

/**
 * The bot's current active run (including background `tickets` runs), kept live via the Space's
 * `runs` change signal without polling.
 */
export function useBotActiveRun(botId: string | undefined, enabled: boolean) {
  const queries = useSpaceQueries();
  const runsOptions = queries.runs?.list?.queryOptions({
    input: { filter: "active", includeTickets: true },
    refetchOnWindowFocus: "always",
  });
  const query = useQuery({
    queryKey: runsOptions?.queryKey ?? ["runs", "list", "active", "tickets", "disabled"],
    queryFn: runsOptions?.queryFn ?? (async () => ({ runs: [] })),
    enabled: enabled && Boolean(botId) && Boolean(runsOptions),
    refetchOnWindowFocus: "always",
  });
  if (!botId) return null;
  const botRuns = (query.data?.runs ?? []).filter((run) => run.botId === botId);
  if (botRuns.length === 0) return null;
  return (
    botRuns.find((run) => run.status === "running") ??
    botRuns.find((run) => run.status === "leased") ??
    botRuns.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover") ??
    botRuns[0] ??
    null
  );
}
