import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { hasPendingTicketDecision, pullRequestLabel, TICKET_STATUSES } from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AskActions } from "../../components/cards/AskActions";
import { NativeActionButton } from "../../components/native/native-action-button";
import { native, useMobileTokens, useThemedStyles } from "../native/native";
import { ticketPullRequestStateLabel, ticketStatusLabel } from "./board";

/** Modal sheet for reading a ticket and answering a pending 3-choice (+ Other) decision on mobile. */
export function TicketDetailSheet({
  ticket,
  deciding,
  onClose,
  onMove,
  onDecide,
}: {
  ticket: Ticket;
  deciding?: boolean;
  onClose: () => void;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
  onDecide: (
    ticket: Ticket,
    input: { optionId?: string; customAnswer?: string },
  ) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const storedPendingDecision = hasPendingTicketDecision(ticket) ? ticket.decision : undefined;
  const fallbackDecision =
    !storedPendingDecision &&
    !ticket.decision?.answer &&
    (ticket.status === "blocked" || ticket.status === "review")
      ? {
          question: ticket.title,
          options: [
            { id: "fallback-1", label: t`Approve and proceed`, recommended: true },
            { id: "fallback-2", label: t`Hold — keep blocked` },
            { id: "fallback-3", label: t`Close task` },
          ],
        }
      : undefined;
  const pendingDecision = storedPendingDecision ?? fallbackDecision;
  const answeredDecision = ticket.decision?.answer ? ticket.decision : undefined;

  async function submitDecision(value: string) {
    if (!pendingDecision) return;
    const matched = pendingDecision.options.find((option) => option.id === value);
    if (storedPendingDecision && matched) {
      await onDecide(ticket, { optionId: matched.id });
    } else {
      await onDecide(ticket, { customAnswer: matched ? matched.label : value });
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: native.groupedPage }]}>
        <View style={[styles.header, { borderBottomColor: tokens.border }]}>
          <Text style={[styles.ref, { color: tokens.mutedForeground }]}>{ticket.ref}</Text>
          <NativeActionButton label={t`Done`} prominence="plain" size="compact" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.title, { color: tokens.foreground }]}>{ticket.title}</Text>
          <View style={styles.metaRow}>
            <View style={[styles.badge, { backgroundColor: tokens.muted }]}>
              <Text style={[styles.badgeText, { color: tokens.foreground }]}>
                {ticketStatusLabel(ticket.status)}
              </Text>
            </View>
          </View>

          {pendingDecision ? (
            <View
              style={[
                styles.decisionCard,
                { backgroundColor: tokens.card, borderColor: tokens.border },
              ]}
            >
              <Text style={[styles.eyebrow, { color: tokens.mutedForeground }]}>
                {t`Needs your decision`}
              </Text>
              <Text style={[styles.question, { color: tokens.foreground }]}>
                {pendingDecision.question}
              </Text>
              <AskActions
                actions={pendingDecision.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  recommended: option.recommended,
                }))}
                approval={false}
                allowOther
                disabled={deciding}
                onAnswer={submitDecision}
              />
            </View>
          ) : answeredDecision ? (
            <View
              style={[
                styles.answeredBox,
                { backgroundColor: tokens.card, borderColor: tokens.border },
              ]}
            >
              <Text style={[styles.answeredText, { color: tokens.mutedForeground }]}>
                {t`Answered: ${answeredDecision.answer}`}
              </Text>
            </View>
          ) : null}

          {ticket.description?.trim() ? (
            <Text style={[styles.description, { color: tokens.foreground }]}>
              {ticket.description}
            </Text>
          ) : null}

          {ticket.pullRequests.length > 0 ? (
            <View style={styles.linksSection}>
              <Text style={[styles.eyebrow, { color: tokens.mutedForeground }]}>
                {t`Pull requests`}
              </Text>
              {ticket.pullRequests.map((pullRequest) => (
                <Pressable
                  key={pullRequest.url}
                  accessibilityRole="link"
                  onPress={() => void Linking.openURL(pullRequest.url)}
                  style={styles.linkRow}
                >
                  <Text numberOfLines={1} style={[styles.linkLabel, { color: tokens.foreground }]}>
                    {pullRequestLabel(pullRequest.url)}
                  </Text>
                  <View style={[styles.badge, { backgroundColor: tokens.muted }]}>
                    <Text
                      style={[
                        styles.badgeText,
                        {
                          color:
                            pullRequest.state === "merged"
                              ? tokens.success
                              : pullRequest.state === "closed"
                                ? tokens.mutedForeground
                                : tokens.foreground,
                        },
                      ]}
                    >
                      {ticketPullRequestStateLabel(pullRequest.state)}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.moveSection}>
            <Text style={[styles.eyebrow, { color: tokens.mutedForeground }]}>{t`Move to`}</Text>
            <View style={styles.moveRow}>
              {TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => (
                <NativeActionButton
                  key={status}
                  label={ticketStatusLabel(status)}
                  prominence="secondary"
                  size="compact"
                  fill={false}
                  onPress={() => onMove(ticket, status)}
                />
              ))}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function createStyles() {
  return StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    ref: { ...typeScale.secondary, fontWeight: fontWeight.medium },
    content: { padding: 16, gap: 16, paddingBottom: 36 },
    title: { ...typeScale.title, fontWeight: fontWeight.semibold },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
    badgeText: { ...typeScale.caption, fontWeight: fontWeight.medium },
    decisionCard: {
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 14,
      gap: 6,
    },
    eyebrow: { ...typeScale.caption, fontWeight: fontWeight.medium },
    question: { ...typeScale.cardTitle },
    answeredBox: {
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    answeredText: { ...typeScale.secondary },
    description: { ...typeScale.body, lineHeight: 22 },
    linksSection: { gap: 8 },
    linkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    linkLabel: { ...typeScale.secondary, flexShrink: 1, textDecorationLine: "underline" },
    moveSection: { gap: 8, marginTop: 4 },
    moveRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  });
}
