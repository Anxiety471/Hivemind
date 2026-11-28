import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Board, BoardRepositoryInput } from "@rakazo/contracts";
import { BOARD_MAX_REPOSITORIES, normalizeRepositoryUrl, ticketLinkLabel } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useMobileTokens, useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import type { SettingsTarget } from "../../lib/query/settings-target";
import { NativeActionButton } from "../native/native-action-button";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

/**
 * The repositories a Space's board works in, which link PR, commit and ticket references in its
 * chats. Edited on the Space's own copy of the board; the account's settings do not show it.
 */
export function BoardRepositoriesSection({
  target,
  spaceId,
  enabled,
}: {
  target: SettingsTarget;
  spaceId: string;
  enabled: boolean;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const boardRead = rpcQuery("boards/get", undefined, spaceId);
  const boardQuery = useQuery({ ...boardRead, enabled }, queryClient);
  const board = boardQuery.data;
  const [url, setUrl] = useState("");
  const [aliases, setAliases] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const save = useSave<BoardRepositoryInput[], Board>({
    target,
    save: (repositories, send) => send("boards/rename", { repositories }),
    onSaved: (saved) => {
      queryClient.setQueryData(boardRead.queryKey, saved);
      setUrl("");
      setAliases("");
    },
  });

  if (!enabled || !board) return null;

  // While a save runs, the list shows what is being saved.
  const repositories = (save.pending && save.input) || board.repositories;
  const failure = formError ?? (save.error ? errorText(save.error, t`Try again.`) : null);

  function add() {
    const normalized = normalizeRepositoryUrl(url);
    if (!normalized) {
      setFormError(t`Enter a repository URL, such as https://example.com/owner/repo`);
      return;
    }
    if (repositories.some((repo) => repo.url === normalized)) {
      setFormError(t`That repository is already added`);
      return;
    }
    if (repositories.length >= BOARD_MAX_REPOSITORIES) {
      setFormError(t`A board can have up to ${ph({ count: BOARD_MAX_REPOSITORIES })} repositories`);
      return;
    }
    setFormError(null);
    const entry = {
      url: normalized,
      aliases: aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
      // The first repository added is the default until another is chosen.
      isDefault: repositories.length === 0,
    };
    save.run([...repositories, entry]);
  }

  return (
    <SettingsGroup label={t`Repositories`} accessibilityLabel={t`Repositories`}>
      {repositories.map((repo) => (
        <SettingsRow
          key={repo.url}
          title={ticketLinkLabel(repo.url)}
          detail={repo.aliases.length > 0 ? repo.aliases.join(", ") : undefined}
          dimmed={save.pending}
          trailing={
            <View style={styles.actions}>
              {repo.isDefault ? (
                <Text
                  style={[styles.pill, { backgroundColor: tokens.muted, color: tokens.foreground }]}
                >
                  {t`Default`}
                </Text>
              ) : (
                <NativeActionButton
                  accessibilityLabel={t`Make ${ph({ name: ticketLinkLabel(repo.url) })} default`}
                  disabled={save.pending}
                  fill={false}
                  label={t`Make default`}
                  onPress={() =>
                    save.run(
                      repositories.map((row) => ({ ...row, isDefault: row.url === repo.url })),
                    )
                  }
                  prominence="secondary"
                  size="compact"
                />
              )}
              <NativeActionButton
                accessibilityLabel={t`Remove ${ph({ name: ticketLinkLabel(repo.url) })}`}
                disabled={save.pending}
                fill={false}
                label={t`Remove`}
                onPress={() => save.run(repositories.filter((row) => row.url !== repo.url))}
                prominence="destructive"
                size="compact"
              />
            </View>
          }
        />
      ))}
      <SettingsInputRow
        accessibilityLabel={t`Repository URL`}
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="url"
        onChangeText={(value) => {
          setUrl(value);
          setFormError(null);
        }}
        placeholder="https://example.com/owner/repo"
        value={url}
      />
      <SettingsInputRow
        accessibilityLabel={t`Aliases`}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setAliases}
        placeholder={t`Aliases, separated by commas`}
        value={aliases}
      />
      <View style={styles.form}>
        {failure ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
            {failure}
          </Text>
        ) : null}
        <NativeActionButton
          busy={save.pending}
          disabled={!url.trim()}
          fill={false}
          label={t`Add`}
          onPress={add}
          prominence="secondary"
        />
      </View>
    </SettingsGroup>
  );
}

function createStyles() {
  return StyleSheet.create({
    actions: { flexDirection: "row", alignItems: "center", gap: 8 },
    pill: {
      overflow: "hidden",
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
      fontSize: 12,
    },
    form: { gap: 8, paddingHorizontal: 16, paddingVertical: 12, alignItems: "flex-start" },
    error: { fontSize: 14 },
  });
}
