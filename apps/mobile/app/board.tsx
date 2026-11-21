import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { LoadFailure } from "../components/ui/load-failure";
import { errorText } from "../lib/api/user-error";
import { boardSections } from "../lib/board/board";
import { BoardList } from "../lib/board/board-list";
import { TicketDetailSheet } from "../lib/board/ticket-detail-sheet";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/** The Space's ticket board: every column, with the status changed in place. */
export default function BoardScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const ticketsRead = rpcQuery("tickets/list", {});
  const ticketsQuery = useScreenQuery(ticketsRead);
  const tickets = ticketsQuery.data?.tickets ?? [];

  const moveSave = useSave<{ ticket: Ticket; status: TicketStatus }, Ticket>({
    save: ({ ticket, status }, send) => send("tickets/move", { id: ticket.id, status }),
    stale: [ticketsRead.queryKey],
    onSaved: (updated) => {
      queryClient.setQueryData(ticketsRead.queryKey, (current) => ({
        tickets: [updated, ...(current?.tickets ?? []).filter((row) => row.id !== updated.id)],
      }));
    },
    onFailed: (cause) => Alert.alert(t`Could not move the ticket`, errorText(cause, t`Try again.`)),
  });

  const decideSave = useSave<
    { ticketId: string; optionId?: string; customAnswer?: string },
    { ticket: Ticket }
  >({
    save: (input, send) => send("tickets/decide", input),
    stale: [ticketsRead.queryKey],
    onSaved: (result) => {
      queryClient.setQueryData(ticketsRead.queryKey, (current) => ({
        tickets: [
          result.ticket,
          ...(current?.tickets ?? []).filter((row) => row.id !== result.ticket.id),
        ],
      }));
    },
    onFailed: (cause) => Alert.alert(t`Could not submit decision`, errorText(cause, t`Try again.`)),
  });

  const error = ticketsQuery.error ? errorText(ticketsQuery.error, t`Try again.`) : "";
  const loading = ticketsQuery.isPending || (ticketsQuery.isFetching && tickets.length === 0);
  const selectedTicket = selectedTicketId
    ? (tickets.find((row) => row.id === selectedTicketId) ?? null)
    : null;

  if (loading && tickets.length === 0) {
    return (
      <View style={[styles.centered, sideInsets]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (tickets.length === 0) {
    return (
      <View style={[styles.centered, sideInsets]}>
        {error ? (
          <LoadFailure message={error} onRetry={() => void ticketsQuery.refetch()} />
        ) : (
          <Text style={styles.message}>{t`No tickets yet.`}</Text>
        )}
      </View>
    );
  }
  return (
    <>
      <BoardList
        sections={boardSections(tickets)}
        error={error}
        onSelect={(ticket) => setSelectedTicketId(ticket.id)}
        onMove={(ticket, status) => moveSave.run({ ticket, status })}
        onRefresh={async () => {
          await ticketsQuery.refetch();
        }}
      />
      {selectedTicket ? (
        <TicketDetailSheet
          ticket={selectedTicket}
          deciding={decideSave.pending}
          onClose={() => setSelectedTicketId(null)}
          onMove={(ticket, status) => moveSave.run({ ticket, status })}
          onDecide={(ticket, input) => decideSave.run({ ticketId: ticket.id, ...input })}
        />
      ) : null}
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      backgroundColor: native.groupedPage,
    },
    message: { ...typeScale.body, color: native.secondaryLabel, textAlign: "center" },
    badge: { fontWeight: fontWeight.medium },
  });
}
