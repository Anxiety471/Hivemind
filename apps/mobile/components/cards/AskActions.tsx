import { useLingui } from "@lingui/react/macro";
import type { AskItem } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { formatBatchAskAnswer, resolveAskChoice } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, Text, TextInput, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { AskAction } from "../../lib/cards/ask-action-label";
import { askActionLabel } from "../../lib/cards/ask-action-label";
import { native } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";

/**
 * A batch ask: each item is its own question. Actionable items pick a choice or type their own
 * answer; FYI items are read-only. One submit sends every answer together.
 */
export function AskItemsActions({
  items,
  answered,
  disabled,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  items: AskItem[];
  /** The ask is decided: items show their recorded answers and take no input. */
  answered: boolean;
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const [picked, setPicked] = useState<Record<string, string | undefined>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const decided = answered || sent;
  const actionable = items.filter((item) => item.actions?.length);
  const answerFor = (id: string) =>
    otherOpen[id] ? otherText[id]?.trim() || undefined : picked[id];
  const answers = Object.fromEntries(
    actionable.flatMap((item) => {
      const value = answerFor(item.id);
      return value ? [[item.id, value]] : [];
    }),
  );
  const answeredCount = Object.keys(answers).length;
  const ready = answeredCount === actionable.length;

  async function submit() {
    if (pending || decided || disabled || !ready) return;
    setPending(true);
    try {
      await onAnswer(formatBatchAskAnswer(answers));
      setSent(true);
    } catch (error) {
      Alert.alert(t`Could not submit answer`, errorText(error, t`Please try again.`));
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={{ gap: 14, marginTop: 12 }}>
      {items.map((item) => {
        const detail = item.detail ? (
          <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
            {item.detail}
          </Text>
        ) : null;
        if (!item.actions?.length)
          return (
            <View key={item.id} style={{ gap: 2 }}>
              <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
                {item.question}
              </Text>
              {detail}
            </View>
          );
        const actions = item.actions;
        const value = decided ? (item.answer ?? answerFor(item.id)) : undefined;
        if (decided)
          return (
            <View key={item.id} style={{ gap: 2 }}>
              <Text style={{ color: tokens.foreground, ...typeScale.cardTitle }}>
                {item.question}
              </Text>
              {detail}
              {value ? (
                <Text
                  style={{
                    color: tokens.foreground,
                    ...typeScale.secondary,
                    fontWeight: fontWeight.medium,
                  }}
                >
                  {resolveAskChoice(value, actions)?.label ?? value}
                </Text>
              ) : null}
            </View>
          );
        return (
          <View key={item.id} style={{ gap: 6 }}>
            <Text style={{ color: tokens.foreground, ...typeScale.cardTitle }}>
              {item.question}
            </Text>
            {detail}
            {actions.map((action) => (
              <View key={action.id} style={{ gap: 2 }}>
                <NativeActionButton
                  accessibilityActions={accessibilityActions}
                  onAccessibilityAction={onAccessibilityAction}
                  label={askActionLabel(action, { approval: false })}
                  prominence="secondary"
                  fill
                  align="start"
                  selected={!otherOpen[item.id] && picked[item.id] === action.id}
                  disabled={disabled || pending}
                  onPress={() => {
                    setPicked((current) => ({ ...current, [item.id]: action.id }));
                    setOtherOpen((current) => ({ ...current, [item.id]: false }));
                  }}
                />
                {action.description ? (
                  <Text
                    style={{
                      color: tokens.mutedForeground,
                      ...typeScale.secondary,
                      paddingHorizontal: 16,
                    }}
                  >
                    {action.description}
                  </Text>
                ) : null}
              </View>
            ))}
            <NativeActionButton
              label={t`Other`}
              prominence="secondary"
              size="compact"
              fill={false}
              align="start"
              selected={otherOpen[item.id]}
              disabled={disabled || pending}
              onPress={() => {
                setOtherOpen((current) => ({ ...current, [item.id]: !current[item.id] }));
                setPicked((current) => ({ ...current, [item.id]: undefined }));
              }}
            />
            {otherOpen[item.id] ? (
              <TextInput
                accessibilityLabel={t`Other answer`}
                placeholder={t`Type your answer…`}
                placeholderTextColor={tokens.faintForeground}
                multiline
                editable={!disabled && !pending}
                value={otherText[item.id] ?? ""}
                onChangeText={(text) =>
                  setOtherText((current) => ({ ...current, [item.id]: text }))
                }
                style={{
                  color: tokens.foreground,
                  backgroundColor: native.fill,
                  borderRadius: 10,
                  padding: 12,
                }}
              />
            ) : null}
          </View>
        );
      })}
      {decided || disabled || actionable.length === 0 ? null : (
        <NativeActionButton
          label={
            actionable.length > 1
              ? t`Send answers (${answeredCount}/${actionable.length})`
              : t`Send answer`
          }
          prominence="primary"
          fill={false}
          disabled={!ready || pending}
          busy={pending}
          onPress={() => void submit()}
        />
      )}
    </View>
  );
}

export function AskActions({
  actions,
  site,
  approval,
  instructions,
  disabled,
  allowOther = false,
  selectedAnswer,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  site?: string;
  approval: boolean;
  instructions?: string;
  disabled?: boolean;
  allowOther?: boolean;
  selectedAnswer?: string;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [draft, setDraft] = useState(instructions ?? "");
  const submitting = pendingAction !== null;
  const displayActions =
    instructions !== undefined
      ? actions.flatMap((action) =>
          action.id === "allow"
            ? [action, { id: "edit", label: editing ? t`Cancel` : t`Edit` }]
            : [action],
        )
      : actions;

  async function submit(answer: string) {
    if (disabled || submitting) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(t`Could not submit answer`, errorText(error, t`Please try again.`));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {editing ? (
        <TextInput
          accessibilityLabel={t`Instructions`}
          multiline
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          value={draft}
          onChangeText={setDraft}
          style={{ color: tokens.foreground, backgroundColor: native.fill, padding: 12 }}
        />
      ) : null}
      <View
        style={{
          flexDirection: approval ? "row" : "column",
          // Option buttons stack full width; a wrapping column sizes its line to the
          // widest button's own width, which collapses stretched buttons.
          flexWrap: approval ? "wrap" : "nowrap",
          gap: 6,
        }}
      >
        {displayActions.map((action) => {
          const emphasized = action.id === "allow" || action.id === "always";
          if (instructions !== undefined)
            return (
              <NativeActionButton
                key={action.id}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={
                  action.id === "edit"
                    ? action.label
                    : action.id === "allow"
                      ? t`Apply`
                      : t`Dismiss`
                }
                prominence={emphasized ? "primary" : "secondary"}
                fill={false}
                disabled={disabled || submitting}
                busy={pendingAction === action.id || (action.id === "allow" && submitting)}
                onPress={() =>
                  action.id === "edit"
                    ? setEditing((value) => !value)
                    : void submit(
                        editing && action.id === "allow"
                          ? JSON.stringify({ instructions: draft })
                          : action.id,
                      )
                }
              />
            );
          const option = (
            <NativeActionButton
              key={action.id}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={onAccessibilityAction}
              label={askActionLabel(action, { approval, site })}
              prominence={emphasized ? "primary" : "secondary"}
              fill={!approval}
              selected={
                approval || selectedAnswer === undefined
                  ? undefined
                  : resolveAskChoice(selectedAnswer, actions)?.id === action.id
              }
              align={approval ? "center" : "start"}
              disabled={disabled || submitting}
              busy={pendingAction === action.id}
              onPress={() => void submit(action.id)}
            />
          );
          // The native button keeps one label line; a description sits calmly beneath it.
          if (approval || !action.description) return option;
          return (
            <View key={action.id} style={{ gap: 2 }}>
              {option}
              <Text
                style={{
                  color: tokens.mutedForeground,
                  fontSize: 14,
                  paddingHorizontal: 16,
                }}
              >
                {action.description}
              </Text>
            </View>
          );
        })}
        {allowOther && !approval && instructions === undefined && !disabled ? (
          <NativeActionButton
            label={t`Other`}
            prominence="secondary"
            fill
            selected={otherOpen}
            align="start"
            disabled={submitting}
            onPress={() => setOtherOpen((value) => !value)}
          />
        ) : null}
      </View>
      {allowOther && otherOpen && !disabled ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          <TextInput
            accessibilityLabel={t`Other answer`}
            placeholder={t`Type your answer…`}
            multiline
            value={otherDraft}
            onChangeText={setOtherDraft}
            style={{
              color: tokens.foreground,
              backgroundColor: native.fill,
              borderRadius: 10,
              padding: 12,
            }}
          />
          <NativeActionButton
            label={t`Send`}
            prominence="primary"
            fill={false}
            disabled={submitting || !otherDraft.trim()}
            busy={submitting && pendingAction !== null}
            onPress={() => void submit(otherDraft.trim())}
          />
        </View>
      ) : null}
    </View>
  );
}
