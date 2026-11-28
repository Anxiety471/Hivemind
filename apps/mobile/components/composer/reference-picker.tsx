import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { TICKET_PULL_REQUEST_STATES, TICKET_STATUSES } from "@rakazo/contracts";
import type { ComposerReferenceOption } from "@rakazo/core";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { ticketLinkStateLabel, ticketStatusLabel } from "../../lib/board/board";
import { useMobileTokens } from "../../lib/native/native";

const ROW_PADDING = 14;
const ROW_GAP = 10;
const DOT_SIZE = 6;

const monospace = Platform.select({ ios: "Menlo", default: "monospace" });

/** A ticket status as the board words it; null for a status the board does not know. */
function ticketStatusOf(status: string): string | null {
  const known = TICKET_STATUSES.find((value) => value === status);
  return known ? ticketStatusLabel(known) : null;
}

/** A pull request state as the ticket words it; null for a state the board does not know. */
function pullRequestStateOf(state: string | undefined): string | null {
  const known = TICKET_PULL_REQUEST_STATES.find((value) => value === state);
  return known ? ticketLinkStateLabel(known) : null;
}

/** Open tasks and linked pull requests for a typed `#`, shown above the input like the mention picker. */
export function ReferencePicker({
  options,
  onSelect,
}: {
  options: readonly ComposerReferenceOption[];
  onSelect: (option: ComposerReferenceOption) => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  return (
    <ScrollView
      testID="reference-picker"
      keyboardShouldPersistTaps="handled"
      style={{
        flexGrow: 0,
        flexShrink: 1,
        marginTop: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        overflow: "hidden",
      }}
    >
      {options.map((option, index) => {
        const status = option.kind === "ticket" ? ticketStatusOf(option.status) : null;
        const state = option.kind === "pull_request" ? pullRequestStateOf(option.state) : null;
        return (
          <View key={option.key}>
            {index > 0 ? (
              <View
                style={{ height: 1, marginStart: ROW_PADDING, backgroundColor: tokens.border }}
              />
            ) : null}
            <Pressable
              accessibilityLabel={
                option.kind === "ticket"
                  ? t`${ph({ name: option.ref })} ${ph({ title: option.title })}`
                  : option.label
              }
              onPress={() => onSelect(option)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: ROW_GAP,
                minHeight: 44,
                paddingHorizontal: ROW_PADDING,
                paddingVertical: 10,
              }}
            >
              {option.kind === "ticket" ? (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text
                      numberOfLines={1}
                      style={{ fontFamily: monospace, color: tokens.foreground, fontSize: 14 }}
                    >
                      {option.ref}
                    </Text>
                    {option.pendingDecision ? (
                      <View
                        testID="reference-pending-decision"
                        style={{
                          width: DOT_SIZE,
                          height: DOT_SIZE,
                          borderRadius: DOT_SIZE / 2,
                          backgroundColor: tokens.warning,
                        }}
                      />
                    ) : null}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, minWidth: 0, color: tokens.foreground, fontSize: 15 }}
                  >
                    {option.title}
                  </Text>
                  {status ? (
                    <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                      {status}
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: monospace, color: tokens.foreground, fontSize: 14 }}
                  >
                    {option.label}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, minWidth: 0, color: tokens.mutedForeground, fontSize: 13 }}
                  >
                    {option.ticketRef ?? ""}
                  </Text>
                  {state ? (
                    <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                      {state}
                    </Text>
                  ) : null}
                </>
              )}
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
