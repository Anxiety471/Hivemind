import { useLingui } from "@lingui/react/macro";
import { displayName as safeDisplayName } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SelectTextSheet } from "../components/messages/select-text-sheet";
import { NativeActionButton } from "../components/native/native-action-button";
import {
  ThreadErrorNotice,
  ThreadFetchErrorNotice,
} from "../components/thread/thread-error-notice";
import { useLatestRowActions, useThreadRows } from "../components/thread/thread-rows";
import type { MobileBot } from "../lib/api/mobile-types";
import { mobileTokens } from "../lib/appearance/appearance";
import { readableGutters } from "../lib/layout/adaptive-layout";
import { useContentBottomInset } from "../lib/layout/content-bottom-inset";
import { useSplitView } from "../lib/layout/split-view";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { useAppForeground } from "../lib/platform/app-foreground";
import type { HelperThreadTarget } from "../lib/thread/helper-thread";
import { helperThreadParams, helperThreadTargetFromParams } from "../lib/thread/helper-thread";
import { useHelperThreadLive } from "../lib/thread/helper-thread-live";
import { threadColumnPadding } from "../lib/thread/scroll/thread-edges";
import { useThreadTranscript } from "../lib/thread/thread-transcript";
import { useSpeakMessages } from "../lib/thread/thread-voice";

const noBots: MobileBot[] = [];
const messageListPosition = { minIndexForVisible: 0 };

/** A background helper's own thread: the card's task over its transcript, live and read-only. */
export default function HelperThreadScreen() {
  const params = useLocalSearchParams<{
    messageId?: string | string[];
    name?: string | string[];
    task?: string | string[];
    status?: string | string[];
  }>();
  const target = helperThreadTargetFromParams(params);
  const { t } = useLingui();
  const router = useRouter();
  const tokens = mobileTokens();
  const insets = useSafeAreaInsets();
  const { inboxShown, contentWidth } = useSplitView();
  const bottomInset = useContentBottomInset();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const name = safeDisplayName(target?.name, t`Subagent`);
  useScreenHeader({ title: name });
  const { snapshot, status, error, retry } = useHelperThreadLive({
    messageId: target?.messageId ?? "",
    initialStatus: target?.status ?? "completed",
    active: focused && foreground,
  });
  const transcript = useThreadTranscript(snapshot?.messages, false);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const speak = useSpeakMessages({
    visibleMessages: transcript.visibleMessages,
    botId: snapshot?.botId,
    members: snapshot?.members,
    displayName: name,
    mentionBots: noBots,
  });
  const helperBot = useMemo(
    () => (snapshot?.botId ? ({ id: snapshot.botId, name } as MobileBot) : undefined),
    [snapshot?.botId, name],
  );
  const openHelper = useCallback(
    (next: HelperThreadTarget) =>
      router.push({ pathname: "/helper-thread", params: helperThreadParams(next) }),
    [router],
  );
  const rowActions = useLatestRowActions({
    helperToggle: (_measure, toggle) => toggle(),
    openHelper,
    reply: () => {},
    quote: () => {},
    select: setSelectableText,
    speak,
    react: async () => false,
    markUnread: () => {},
    answer: async () => {},
    openBot: (botId, botName) =>
      router.push({ pathname: "/thread", params: { botId, name: botName } }),
    openComputer: (botId, botName) =>
      router.push({ pathname: "/computer", params: { botId, name: botName } }),
    previewFile: (artifactId) =>
      router.push({ pathname: "/artifact", params: { artifactId, exact: "1" } }),
    previewImage: (image) => {
      if (snapshot?.botId)
        router.push({ pathname: "/image", params: { ...image, botId: snapshot.botId } });
    },
    jump: () => {},
    dismissChoice: transcript.dismissChoice,
    openPeerChat: (peer) => {
      if (!snapshot?.botId) return;
      router.push({
        pathname: "/peer-chat",
        params: { ...peer, botId: snapshot.botId, botName: name },
      });
    },
    layout: () => {},
  });
  const columnInsets = useMemo(
    () =>
      readableGutters(contentWidth, { left: inboxShown ? 0 : insets.left, right: insets.right }),
    [contentWidth, inboxShown, insets.left, insets.right],
  );
  const columnPadding = useMemo(
    () => threadColumnPadding(columnInsets, I18nManager.isRTL),
    [columnInsets.left, columnInsets.right],
  );
  const columnWidth = contentWidth - columnInsets.left - columnInsets.right;
  const { liveItems, renderItem } = useThreadRows({
    snap: snapshot,
    userId: "",
    transcript,
    rowActions,
    botId: snapshot?.botId,
    inGroup: false,
    readOnly: true,
    onCall: false,
    displayName: name,
    mentionBots: noBots,
    currentBot: helperBot,
    currentBotStatus: snapshot?.run?.status,
    columnWidth,
    readSeq: null,
    highlightedMessageId: null,
  });
  const statusLabel =
    status === "running"
      ? t`Running`
      : status === "completed"
        ? t`Completed`
        : status === "stopped"
          ? t`Stopped`
          : t`Failed`;
  const statusTint =
    status === "running"
      ? tokens.warning
      : status === "completed"
        ? tokens.success
        : status === "stopped"
          ? tokens.mutedForeground
          : tokens.destructive;
  const listContentStyle = useMemo(
    () => ({
      paddingTop: bottomInset + 16,
      paddingBottom: 16,
      // An inverted Android list mirrors with scale: -1, so asymmetric padding swaps sides.
      paddingStart:
        Platform.OS === "android" ? columnPadding.paddingEnd : columnPadding.paddingStart,
      paddingEnd: Platform.OS === "android" ? columnPadding.paddingStart : columnPadding.paddingEnd,
    }),
    [bottomInset, columnPadding],
  );
  if (!target)
    return (
      <View style={[styles.centered, { backgroundColor: tokens.background }]}>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.body }}>
          {t`Could not open this helper`}
        </Text>
      </View>
    );
  if (!snapshot && !error)
    return (
      <View style={[styles.centered, { backgroundColor: tokens.background }]}>
        <ActivityIndicator color={tokens.foreground} />
      </View>
    );
  if (!snapshot)
    return (
      <View style={[styles.centered, { backgroundColor: tokens.background }]}>
        <ThreadErrorNotice error={error} summary={null} />
        <NativeActionButton label={t`Try again`} prominence="secondary" onPress={retry} />
      </View>
    );
  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingStart: columnPadding.paddingStart,
            paddingEnd: columnPadding.paddingEnd,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <Text style={{ flexShrink: 1, color: tokens.foreground, ...typeScale.cardTitle }}>
            {name}
          </Text>
          <View style={styles.headerRow}>
            {status === "running" ? (
              <ActivityIndicator size="small" color={tokens.warning} />
            ) : null}
            <Text style={{ color: statusTint, ...typeScale.caption }}>{statusLabel}</Text>
          </View>
        </View>
        {target.task ? (
          <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
            {target.task}
          </Text>
        ) : null}
      </View>
      <FlatList
        inverted
        style={styles.list}
        data={liveItems}
        keyExtractor={(item) => (item.kind === "voiceChat" ? item.key : item.message.id)}
        extraData={renderItem}
        renderItem={renderItem}
        maintainVisibleContentPosition={messageListPosition}
        contentContainerStyle={listContentStyle}
        ListHeaderComponent={<ThreadFetchErrorNotice error={error} showingSaved />}
      />
      {selectableText !== null ? (
        <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
  list: { flex: 1 },
  header: { paddingTop: 4, paddingBottom: 8, gap: 6 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
