import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native/native-action-button";
import {
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";

/** The notes every bot in this space shares. A bot's own notes live in its chat settings. */
export default function MemoryScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const read = rpcQuery("memory/list", { scope: "user" });
  // A refetch replaces one still running, so a slow earlier read cannot bring back a deleted note.
  const { data: notes, error: failure, refetch } = useQuery(read, queryClient);
  const error = failure ? errorText(failure, t`Could not load memory`) : null;
  const roamerRead = rpcQuery("memory/roamer");
  const { data: roamer, error: roamerFailure } = useQuery(roamerRead, queryClient);
  const roamerChange = useSave({
    save: async (input: { enabled: boolean; intervalMinutes?: number }, send) =>
      send("memory/setRoamer", input),
    stale: [roamerRead.queryKey],
    onSaved: (saved) => queryClient.setQueryData(roamerRead.queryKey, saved),
  });
  const [intervalDraft, setIntervalDraft] = useState("360");
  useEffect(() => {
    if (roamer) setIntervalDraft(String(roamer.intervalMinutes));
  }, [roamer?.intervalMinutes]);
  const saveInterval = () => {
    const minutes = Number(intervalDraft);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 10_080) {
      setIntervalDraft(String(roamer?.intervalMinutes ?? 360));
      return;
    }
    if (minutes === roamer?.intervalMinutes) return;
    roamerChange.run({ enabled: roamer?.enabled ?? false, intervalMinutes: minutes });
  };
  const intervalForToggle = () => {
    const minutes = Number(intervalDraft);
    return Number.isInteger(minutes) && minutes >= 15 && minutes <= 10_080
      ? minutes
      : roamer?.intervalMinutes;
  };
  const roamerStatus = !roamer
    ? roamerFailure
      ? errorText(roamerFailure, t`Could not load the memory roamer`)
      : t`Loading…`
    : roamer.lastError
      ? t`Last run failed: ${roamer.lastError}`
      : roamer.lastRunAt
        ? t`Last run ${new Date(roamer.lastRunAt).toLocaleString()}`
        : roamer.enabled
          ? t`Waiting for the first run`
          : t`Off`;
  const [refreshing, setRefreshing] = useState(false);

  // Bots write memory as they run, and a note may have changed in its editor.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  async function refresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {!notes && !error ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {notes?.length === 0 ? (
          <Text style={styles.secondary}>{t`Nothing remembered yet`}</Text>
        ) : null}
        {notes?.length ? (
          <SettingsGroup>
            {notes.map((note) => (
              <SettingsRow
                key={note.id}
                accessibilityRole="button"
                chevron="right"
                onPress={() => router.push({ pathname: "/memory-note", params: { id: note.id } })}
                title={note.path}
              />
            ))}
          </SettingsGroup>
        ) : null}
        <SettingsGroup footer={roamerStatus}>
          <SettingsSwitch
            label={t`Background memory roamer`}
            detail={t`Uses your main model, and tidies only MEMORY.md, USER.md, Instructions, and shared memory.`}
            value={roamer?.enabled ?? false}
            disabled={!roamer || roamerChange.pending}
            onChange={(enabled) =>
              roamerChange.run({ enabled, intervalMinutes: intervalForToggle() })
            }
          />
          <SettingsRow
            title={t`Check every (minutes)`}
            trailing={
              <TextInput
                accessibilityLabel={t`Memory roamer interval in minutes`}
                keyboardType="number-pad"
                value={intervalDraft}
                editable={Boolean(roamer) && !roamerChange.pending}
                onChangeText={setIntervalDraft}
                onEndEditing={saveInterval}
                style={styles.intervalInput}
              />
            }
          />
        </SettingsGroup>
        {roamer?.lastRunAt && !roamer.lastError ? (
          <SettingsFooter>
            {roamer.lastChanges === 1 ? t`1 change` : t`${roamer.lastChanges} changes`}
          </SettingsFooter>
        ) : null}
        {roamer?.lastReport?.length ? (
          <SettingsGroup label={t`Last run details`}>
            {roamer.lastReport.map((target) => (
              <SettingsRow
                key={`${target.kind}:${target.id}`}
                title={
                  target.kind === "shared"
                    ? t`Shared memory (${target.name})`
                    : target.name
                }
                detail={
                  target.status === "failed"
                    ? (target.error ?? t`Failed`)
                    : target.changes.length
                      ? target.changes.map((change) => change.path).join(", ")
                      : t`No changes`
                }
              />
            ))}
          </SettingsGroup>
        ) : roamer?.lastFailures?.length ? (
          <SettingsGroup label={t`Last run failures`}>
            {roamer.lastFailures.map((failure) => (
              <SettingsRow
                key={`${failure.kind}:${failure.id}`}
                title={
                  failure.kind === "shared" ? t`Shared memory (${failure.name})` : failure.name
                }
                detail={failure.error}
              />
            ))}
          </SettingsGroup>
        ) : null}
        {roamer?.retryAt ? (
          <SettingsFooter>
            {t`Retrying ${new Date(roamer.retryAt).toLocaleString()} (attempt ${roamer.retryAttempt})`}
          </SettingsFooter>
        ) : null}
        <SettingsFooter>{t`Minutes, 15 to 10,080.`}</SettingsFooter>
        {roamerChange.error ? (
          <SettingsFooter>
            {errorText(roamerChange.error, t`Could not save the memory roamer`)}
          </SettingsFooter>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {error && !notes ? (
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            // Back to the spinner while it reads again.
            onPress={() => void queryClient.resetQueries({ queryKey: read.queryKey })}
            prominence="secondary"
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    intervalInput: {
      minWidth: 64,
      color: native.label,
      fontSize: 17,
      textAlign: "right",
      paddingVertical: 0,
    },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
