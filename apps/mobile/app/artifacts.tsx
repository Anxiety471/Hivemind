import type { MenuAction } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { DriveFile } from "@rakazo/contracts";
import { ARTIFACT_NAME_MAX_LENGTH, fileUploadMaxBytes } from "@rakazo/contracts";
import { artifactTypeLabel } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTextEditDialog } from "../components/bots/profile-edit-dialog";
import { NativeActionButton } from "../components/native/native-action-button";
import { NativeSymbol } from "../components/native/native-symbol";
import { LoadFailure } from "../components/ui/load-failure";
import { LongPressMenu } from "../components/ui/long-press-menu";
import { selectedSpaceId } from "../lib/api/api";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { downloadMobileArtifact, shareLocalFile } from "../lib/artifacts/artifact-open";
import { pickDocuments } from "../lib/composer/pick-attachments";
import { offerDriveFile } from "../lib/files/drive-file-pick";
import { uploadMobileFile } from "../lib/files/file-upload";
import type { DriveListItem, DrivePage } from "../lib/files/files";
import { driveFolderChoices, driveRows, isDriveFolder } from "../lib/files/files";
import { formatActivityRelativeTime } from "../lib/inbox/activity";
import { useContentBottomInset } from "../lib/layout/content-bottom-inset";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

const PAGE_SIZE = 50;
/** A picker selection uploads this many files at once; each becomes its own Drive file. */
const UPLOAD_MAX_FILES = 20;

type DriveSaveAction =
  | { kind: "createFolder"; name: string }
  | { kind: "rename"; id: string; folder: boolean; name: string }
  | { kind: "move"; id: string; folder: boolean; parentId: string | null }
  | { kind: "trash"; id: string; folder: boolean }
  | { kind: "restore"; id: string; folder: boolean }
  | { kind: "delete"; id: string; folder: boolean };

function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.round((size / (1024 * 1024)) * 10) / 10} MB`;
}

function skippedText(skipped: ReadonlyArray<{ name: string; reason: string }>): string {
  return skipped.map((item) => `${item.name} (${item.reason})`).join("\n");
}

/**
 * The Space's Drive: folders, breadcrumbs and files, with an upload, a new folder and the Trash.
 * Opened from a chat composer with `pick=1`, it hands the tapped file back to that chat instead
 * of previewing it.
 */
export default function FilesScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const contentBottomInset = useContentBottomInset();
  const router = useRouter();
  const focused = useIsFocused();
  const colorScheme = useResolvedAppearance();
  const { folderId, botId, pick, threadKey } = useLocalSearchParams<{
    folderId?: string;
    botId?: string;
    pick?: string;
    threadKey?: string;
  }>();
  const folder = folderId || null;
  const picking = pick === "1" && Boolean(threadKey);
  const [trashed, setTrashed] = useState(false);
  useScreenHeader({ title: trashed ? t`Trash` : t`Files` });

  const me = useScreenQuery(rpcQuery("me"), { onForeground: false }).data;
  const listInput = {
    folderId: trashed ? null : folder,
    ...(trashed ? { trashed: true } : {}),
    ...(botId ? { botId } : {}),
    limit: PAGE_SIZE,
  };
  const listRead = rpcQuery("files/list", listInput);
  const listQuery = useScreenQuery(listRead);
  const page = listQuery.data;
  const treeRead = rpcQuery("files/folderTree", {});
  const treeQuery = useScreenQuery(treeRead);
  const folders = treeQuery.data?.folders ?? [];

  // A server signal for a changed Drive re-reads the page; there is no timed refresh.
  useSpaceChanges(
    "files",
    () => {
      void listQuery.refetch();
      void treeQuery.refetch();
    },
    focused,
  );

  // Extra pages extend the first one; any re-read of the first page starts over so nothing
  // appears twice after an upload or a change signal.
  const [extraPages, setExtraPages] = useState<DrivePage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  useEffect(() => {
    setExtraPages([]);
    setLoadMoreFailed(false);
  }, [page]);
  const nextCursor = extraPages.at(-1)?.nextCursor ?? page?.nextCursor ?? null;
  const rows = useMemo(() => {
    const folders = [...(page?.folders ?? []), ...extraPages.flatMap((item) => item.folders)];
    const files = [...(page?.files ?? []), ...extraPages.flatMap((item) => item.files)];
    return driveRows({ folders, files });
  }, [page, extraPages]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await queryClient.fetchQuery(
        rpcQuery("files/list", { ...listInput, cursor: nextCursor }),
      );
      setExtraPages((current) => [...current, next]);
      setLoadMoreFailed(false);
    } catch {
      // The footer offers the retry; a scroll alone does not hammer a failing server.
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const change = useSave<DriveSaveAction>({
    save: (action, send) => {
      switch (action.kind) {
        case "createFolder":
          return send("files/createFolder", { parentId: folder, name: action.name });
        case "rename":
          return action.folder
            ? send("files/renameFolder", { folderId: action.id, name: action.name })
            : send("files/rename", { fileId: action.id, name: action.name });
        case "move":
          return action.folder
            ? send("files/moveFolder", { folderId: action.id, parentId: action.parentId })
            : send("files/move", { fileId: action.id, folderId: action.parentId });
        case "trash":
          return action.folder
            ? send("files/trashFolder", { folderId: action.id })
            : send("files/trash", { fileId: action.id });
        case "restore":
          return action.folder
            ? send("files/restoreFolder", { folderId: action.id })
            : send("files/restore", { fileId: action.id });
        case "delete":
          return action.folder
            ? send("files/deleteFolder", { folderId: action.id })
            : send("files/deletePermanent", { fileId: action.id });
      }
    },
    stale: [listRead.queryKey, treeRead.queryKey],
    onFailed: (cause) => Alert.alert(t`Could not update files`, errorText(cause, t`Try again.`)),
  });

  const [uploading, setUploading] = useState(false);
  const renameDialog = useTextEditDialog(t`Rename`, ARTIFACT_NAME_MAX_LENGTH);
  const newFolderDialog = useTextEditDialog(t`New folder`, ARTIFACT_NAME_MAX_LENGTH);

  function confirmDelete(row: DriveListItem) {
    Alert.alert(t`Delete "${ph({ name: row.name })}"?`, t`This can't be undone.`, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Delete`,
        style: "destructive",
        onPress: () => change.run({ kind: "delete", id: row.id, folder: isDriveFolder(row) }),
      },
    ]);
  }

  function move(row: DriveListItem, parentId: string | null) {
    change.run({ kind: "move", id: row.id, folder: isDriveFolder(row), parentId });
  }

  function menuActions(row: DriveListItem): MenuAction[] {
    const folderRow = isDriveFolder(row);
    if (trashed) {
      return [
        { id: "restore", title: t`Restore` },
        { id: "delete", title: t`Delete permanently`, attributes: { destructive: true } },
      ];
    }
    const choices = driveFolderChoices(folders, folderRow ? row.id : null);
    return [
      { id: "rename", title: t`Rename` },
      {
        id: "move",
        title: t`Move to`,
        subactions: [
          { id: "move-root", title: t`Files` },
          ...choices.map((choice) => ({ id: `move:${choice.id}`, title: choice.label })),
        ],
      },
      ...(folderRow ? [] : [{ id: "download", title: t`Download` }]),
      { id: "trash", title: t`Move to Trash`, attributes: { destructive: true } },
    ];
  }

  function onMenuAction(row: DriveListItem, action: string) {
    const folderRow = isDriveFolder(row);
    if (action === "rename") {
      renameDialog.ask(row.name, (name) => {
        if (!name || name === row.name) return;
        change.run({ kind: "rename", id: row.id, folder: folderRow, name });
      });
    } else if (action === "move-root") {
      move(row, null);
    } else if (action.startsWith("move:")) {
      move(row, action.slice("move:".length));
    } else if (action === "trash") {
      change.run({ kind: "trash", id: row.id, folder: folderRow });
    } else if (action === "restore") {
      change.run({ kind: "restore", id: row.id, folder: folderRow });
    } else if (action === "delete") {
      confirmDelete(row);
    } else if (action === "download" && !folderRow) {
      void download(row);
    }
  }

  async function download(row: DriveFile) {
    try {
      const file = await downloadMobileArtifact(null, row.id, row.mimeType);
      await shareLocalFile(file.uri, row.mimeType, row.name);
    } catch (error) {
      Alert.alert(t`Could not download this file`, errorText(error, t`Try again.`));
    }
  }

  function openFolder(id: string | null) {
    router.setParams({ folderId: id ?? "" });
  }

  function openRow(row: DriveListItem) {
    if (isDriveFolder(row)) {
      openFolder(row.id);
      return;
    }
    if (picking && threadKey) {
      offerDriveFile(threadKey, row);
      router.back();
      return;
    }
    router.push({ pathname: "/artifact", params: { artifactId: row.id, exact: "1" } });
  }

  async function uploadFiles() {
    if (uploading) return;
    const result = await pickDocuments(0, fileUploadMaxBytes(me), UPLOAD_MAX_FILES).catch(
      (error: unknown) => {
        Alert.alert(t`Could not choose files`, errorText(error, t`Try again.`));
        return null;
      },
    );
    if (!result) return;
    if (result.skipped.length) {
      Alert.alert(t`Some files were skipped`, skippedText(result.skipped));
    }
    if (!result.attachments.length) return;
    setUploading(true);
    try {
      for (const file of result.attachments) {
        if (!file.uri) continue;
        await uploadMobileFile({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          folderId: trashed ? null : folder,
          source: "upload",
          spaceId: selectedSpaceId(),
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listRead.queryKey }),
        queryClient.invalidateQueries({ queryKey: treeRead.queryKey }),
      ]);
    } catch (error) {
      Alert.alert(t`Could not upload files`, errorText(error, t`Try again.`));
    } finally {
      setUploading(false);
    }
  }

  function createFolder(name: string) {
    if (name) change.run({ kind: "createFolder", name });
  }

  const error = listQuery.error ? errorText(listQuery.error, t`Could not load files.`) : null;
  const loading = listQuery.isPending && !page;
  const breadcrumbs = trashed ? [] : (page?.breadcrumbs ?? []);
  const title = trashed ? t`Trash` : t`Files`;

  const header = (
    <View>
      <View style={styles.toolbar}>
        {trashed ? null : (
          <>
            <NativeActionButton
              busy={uploading}
              disabled={change.pending}
              label={t`Upload`}
              onPress={() => void uploadFiles()}
              size="compact"
            />
            <NativeActionButton
              disabled={change.pending || uploading}
              label={t`New folder`}
              onPress={() => newFolderDialog.ask("", createFolder)}
              prominence="secondary"
              size="compact"
            />
          </>
        )}
        <View style={styles.toolbarSpacer} />
        <NativeActionButton
          disabled={change.pending || uploading}
          label={trashed ? t`Done` : t`Trash`}
          onPress={() => setTrashed((current) => !current)}
          prominence="quiet"
          size="compact"
        />
      </View>
      {trashed ? null : (
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.crumbsScroll}
          contentContainerStyle={styles.crumbs}
        >
          {breadcrumbs.length ? (
            <Pressable accessibilityRole="button" onPress={() => openFolder(null)}>
              <Text style={styles.crumb}>{title}</Text>
            </Pressable>
          ) : (
            <Text style={[styles.crumb, styles.crumbCurrent]}>{title}</Text>
          )}
          {breadcrumbs.map((crumb, index) => {
            const current = index === breadcrumbs.length - 1;
            return (
              <View key={crumb.id} style={styles.crumbPart}>
                <NativeSymbol
                  android="chevron-forward"
                  color={native.tertiaryLabel}
                  ios="chevron.right"
                  size={11}
                />
                {current ? (
                  <Text style={[styles.crumb, styles.crumbCurrent]} numberOfLines={1}>
                    {crumb.name}
                  </Text>
                ) : (
                  <Pressable accessibilityRole="button" onPress={() => openFolder(crumb.id)}>
                    <Text style={styles.crumb} numberOfLines={1}>
                      {crumb.name}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
      {error ? (
        <View style={styles.notice}>
          <LoadFailure message={error} onRetry={() => void listQuery.refetch()} />
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList<DriveListItem>
        contentContainerStyle={[styles.list, { paddingBottom: 32 + contentBottomInset }]}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        indicatorStyle="default"
        keyExtractor={(row) => row.id}
        ListEmptyComponent={
          loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : error ? undefined : (
            <Text style={styles.empty}>
              {trashed ? t`Trash is empty` : picking ? t`No files to attach yet` : t`No files yet`}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : loadMoreFailed ? (
            <View style={styles.footer}>
              <NativeActionButton
                label={t`Try again`}
                onPress={() => void loadMore()}
                prominence="secondary"
                size="compact"
              />
            </View>
          ) : undefined
        }
        ListHeaderComponent={header}
        onEndReached={() => {
          if (!loadMoreFailed) void loadMore();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            onRefresh={() => void listQuery.refetch()}
            refreshing={listQuery.isRefetching && !loadingMore}
            tintColor={native.secondaryLabel}
          />
        }
        renderItem={({ item }) => {
          const folderRow = isDriveFolder(item);
          return (
            <LongPressMenu
              actions={menuActions(item)}
              colorScheme={colorScheme}
              key={item.id}
              onPressAction={({ nativeEvent }) => onMenuAction(item, nativeEvent.event)}
            >
              {(onLongPress) => (
                <Pressable
                  accessibilityHint={t`Long press for more`}
                  accessibilityLabel={item.name}
                  accessibilityRole="button"
                  onLongPress={onLongPress}
                  onPress={() => openRow(item)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={styles.rowIcon}>
                    <NativeSymbol
                      android={folderRow ? "folder-outline" : "document-outline"}
                      ios={folderRow ? "folder" : "doc.text"}
                      size={17}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <Text numberOfLines={1} style={styles.rowName}>
                      {item.name}
                    </Text>
                    {folderRow ? (
                      <Text numberOfLines={1} style={styles.rowDetail}>
                        {t`Folder`}
                      </Text>
                    ) : (
                      <View style={styles.rowDetailRow}>
                        <Text numberOfLines={1} style={styles.rowDetail}>
                          {artifactTypeLabel(item.mimeType, item.name)}
                        </Text>
                        <Text numberOfLines={1} style={styles.rowDetail}>
                          {fileSizeLabel(item.size)}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.rowMeta}>{formatActivityRelativeTime(item.updatedAt)}</Text>
                </Pressable>
              )}
            </LongPressMenu>
          );
        }}
        style={[styles.listView, sideInsets]}
      />
      {renameDialog.dialog}
      {newFolderDialog.dialog}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    listView: { flex: 1 },
    list: { flexGrow: 1 },
    toolbar: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4,
    },
    toolbarSpacer: { flex: 1 },
    crumbsScroll: { flexGrow: 0, flexShrink: 0 },
    crumbs: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    crumbPart: { alignItems: "center", flexDirection: "row", gap: 6 },
    crumb: { color: native.secondaryLabel, fontSize: 14 },
    crumbCurrent: { color: native.label, flexShrink: 1, fontWeight: "600" },
    notice: { paddingHorizontal: 16, paddingVertical: 12 },
    centered: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      paddingHorizontal: 24,
      paddingTop: 40,
      textAlign: "center",
    },
    footer: { paddingVertical: 20 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    rowPressed: { opacity: 0.6 },
    rowIcon: {
      alignItems: "center",
      backgroundColor: native.fill,
      borderRadius: 10,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    rowBody: { flex: 1, gap: 2, minWidth: 0 },
    rowName: { color: native.label, fontSize: 15, fontWeight: "600" },
    rowDetail: { color: native.secondaryLabel, fontSize: 12 },
    rowDetailRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    rowMeta: { color: native.secondaryLabel, fontSize: 11.5 },
  });
}
