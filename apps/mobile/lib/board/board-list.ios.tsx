import { Button, ContextMenu, Section, Text, VStack } from "@expo/ui/swift-ui";
import {
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  multilineTextAlignment,
  refreshable,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { useLingui } from "@lingui/react/macro";
import { hasPendingTicketDecision, TICKET_STATUSES } from "@rakazo/contracts";
import { NativeInsetList, useInsetListEdges } from "../../components/native/native-inset-list";
import { useFloatingHeaderInset } from "../layout/floating-header";
import { native, useMobileTokens, useResolvedAppearance } from "../native/native";
import { ticketStatusLabel } from "./board";
import type { BoardListProps } from "./board-list";

/** A SwiftUI inset list: a section per column, tap to view/decide and hold to move. */
export function BoardList({ sections, error, onSelect, onMove, onRefresh }: BoardListProps) {
  const { t } = useLingui();
  const headerInset = useFloatingHeaderInset();
  const edges = useInsetListEdges();
  const tokens = useMobileTokens();
  // Re-rendered with the appearance, so the rows read the new theme's `native` colours.
  useResolvedAppearance();
  const lastStatus = sections.at(-1)?.status;
  return (
    <NativeInsetList
      background={native.groupedPage}
      seedColor={tokens.foreground}
      modifiers={[refreshable(onRefresh)]}
    >
      {headerInset > 0 || error ? (
        <Section
          modifiers={edges.modifiers}
          header={edges.header}
          footer={
            error ? <Text modifiers={[font({ textStyle: "footnote" })]}>{error}</Text> : undefined
          }
        >
          {null}
        </Section>
      ) : null}
      {sections.map((section) => (
        <Section
          key={section.status}
          title={ticketStatusLabel(section.status)}
          footer={section.status === lastStatus ? edges.footer : undefined}
        >
          {section.tickets.map((ticket) => (
            <ContextMenu key={ticket.id} modifiers={[contentShape(shapes.rectangle())]}>
              <ContextMenu.Trigger>
                <Button onPress={() => onSelect?.(ticket)}>
                  <VStack
                    alignment="leading"
                    spacing={2}
                    modifiers={[
                      frame({ maxWidth: Number.POSITIVE_INFINITY, alignment: "leading" }),
                      contentShape(shapes.rectangle()),
                    ]}
                  >
                    <Text
                      modifiers={[
                        font({ textStyle: "footnote" }),
                        foregroundStyle({ type: "hierarchical", style: "secondary" }),
                      ]}
                    >
                      {hasPendingTicketDecision(ticket)
                        ? `${ticket.ref} — ${t`Needs decision`}`
                        : ticket.ref}
                    </Text>
                    <Text
                      modifiers={[
                        lineLimit(2),
                        multilineTextAlignment("leading"),
                        foregroundStyle(tokens.foreground),
                      ]}
                    >
                      {ticket.title}
                    </Text>
                  </VStack>
                </Button>
              </ContextMenu.Trigger>
              <ContextMenu.Items>
                <Section title={t`Move to`}>
                  {TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => (
                    <Button
                      key={status}
                      label={ticketStatusLabel(status)}
                      onPress={() => onMove(ticket, status)}
                    />
                  ))}
                </Section>
              </ContextMenu.Items>
            </ContextMenu>
          ))}
        </Section>
      ))}
    </NativeInsetList>
  );
}
