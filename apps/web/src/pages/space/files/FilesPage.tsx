import { Trans, useLingui } from "@lingui/react/macro";
import type {
  DriveFile,
  FileCategory,
  FileFolder,
  FileSortBy,
  FileSortDir,
} from "@rakazo/contracts";
import { attachmentSizeLabel } from "@rakazo/contracts";
import { formatFileSize, inferAttachmentMimeType } from "@rakazo/core";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  ListSearchInput,
  OptionSelect,
  Spinner,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileArchive,
  FileAudio,
  FileCode2,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SearchX,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { IconTooltip } from "../../../components/IconTooltip";
import { WindowChrome } from "../../../components/WindowChrome";
import { getMaxFileUploadSizeBytes } from "../../../lib/bootstrap";
import { attachmentPickerAccept } from "../../../lib/composer/attachment-picker-accept";
import { isFileDrag } from "../../../lib/composer/pending-attachments";
import { fileContentUrl, uploadSpaceFile } from "../../../lib/files/file-client";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import { downloadArtifact } from "../../../lib/pages/artifact-open";
import { desktopBridge } from "../../../lib/platform/desktop";
import { driveViewPreference } from "../../../lib/preferences/drive-view-pref";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorDetails, errorText } from "../../../lib/query/user-error";
import { FilePreviewPane } from "./FilePreviewPane";
import type { MoveTarget } from "./MoveDialog";
import { MoveDialog } from "./MoveDialog";

const PAGE_SIZE = 50;
const FILES_ACCEPT = attachmentPickerAccept();
type SortValue = "updatedAt:desc" | "updatedAt:asc" | "name:asc" | "size:desc";

type DriveItem =
  | {
      kind: "folder";
      id: string;
      name: string;
      parentId: string | null;
      botId: string | null;
      trashedAt: string | null;
      updatedAt: string;
    }
  | {
      kind: "file";
      id: string;
      name: string;
      slug: string | null;
      description: string | null;
      botId: string | null;
      mimeType: string;
      size: number;
      parentId: string | null;
      trashedAt: string | null;
      updatedAt: string;
    };

function folderItem(folder: FileFolder): DriveItem {
  return {
    kind: "folder",
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    botId: folder.botId,
    trashedAt: folder.trashedAt,
    updatedAt: folder.updatedAt,
  };
}

function fileItem(file: DriveFile): DriveItem {
  return {
    kind: "file",
    id: file.id,
    name: file.name,
    slug: file.slug,
    description: file.description,
    botId: file.botId,
    mimeType: file.mimeType,
    size: file.size,
    parentId: file.folderId,
    trashedAt: file.trashedAt,
    updatedAt: file.updatedAt,
  };
}

/**
 * The Space Drive: folders, files, trash, and an inline preview. `drive` is the Drive app's
 * chrome, which has its own sidebar and layout switch; `trashView` then fixes the trash view
 * from the route instead of the header's toggle.
 */
export function FilesPage({ drive = false, trashView }: { drive?: boolean; trashView?: boolean }) {
  const params = useParams<{ folderId?: string; artifactId?: string }>();
  const folderId = params.folderId;
  const artifactId = params.artifactId;
  const { t } = useLingui();
  const sortOptions: { value: SortValue; label: string }[] = [
    { value: "updatedAt:desc", label: t`Newest` },
    { value: "updatedAt:asc", label: t`Oldest` },
    { value: "name:asc", label: t`Name` },
    { value: "size:desc", label: t`Largest` },
  ];
  const categoryOptions: { value: FileCategory; label: string }[] = [
    { value: "all", label: t`All types` },
    { value: "image", label: t`Images` },
    { value: "video", label: t`Video` },
    { value: "audio", label: t`Audio` },
    { value: "document", label: t`Documents` },
    { value: "code", label: t`Code` },
    { value: "archive", label: t`Archives` },
  ];
  const queries = useSpaceQueries();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [category, setCategory] = useState<FileCategory>("all");
  const [sort, setSort] = useState<SortValue>("updatedAt:desc");
  const [trashToggle, setTrashed] = useState(false);
  const trashed = trashView ?? trashToggle;
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<DriveItem | null>(null);
  const [renameName, setRenameName] = useState("");
  const [editTarget, setEditTarget] = useState<Extract<DriveItem, { kind: "file" }> | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DriveItem | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flat = trashed || category !== "all" || deferredSearch.length > 0;
  const [sortBy, sortDir] = sort.split(":") as [FileSortBy, FileSortDir];
  const listing = useInfiniteQuery(
    queries.files.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        ...(folderId && !flat ? { folderId } : {}),
        ...(flat ? { allFolders: true } : {}),
        ...(deferredSearch ? { query: deferredSearch } : {}),
        ...(category !== "all" ? { category } : {}),
        ...(trashed ? { trashed: true } : {}),
        sortBy,
        sortDir,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const firstPage = listing.data?.pages[0];
  const folders = useMemo(
    () => listing.data?.pages.flatMap((page) => page.folders.map(folderItem)) ?? null,
    [listing.data],
  );
  const files = useMemo(
    () => listing.data?.pages.flatMap((page) => page.files.map(fileItem)) ?? null,
    [listing.data],
  );
  const items = folders && files ? [...folders, ...files] : null;
  const breadcrumbs = firstPage?.breadcrumbs ?? [];
  const nextCursor = listing.data?.pages.at(-1)?.nextCursor ?? null;
  const stale = [queries.files.list.key(), queries.files.folderTree.key()];

  const upload = useSave({
    save: async ({ pending, destination }: { pending: File[]; destination: string | null }) => {
      for (const file of pending) {
        await uploadSpaceFile({
          file,
          folderId: destination,
          source: "upload",
          onProgress: (fraction) => setUploadProgress(fraction),
        });
      }
    },
    stale,
    onSaved: () => setUploadProgress(null),
    onFailed: () => setUploadProgress(null),
  });
  const createFolder = useSave({
    save: (name: string, rpc) => rpc.files.createFolder({ parentId: folderId ?? null, name }),
    stale,
    onSaved: () => {
      setNewFolderOpen(false);
      setNewFolderName("");
    },
  });
  const rename = useSave({
    save: async ({ target, name }: { target: DriveItem; name: string }, rpc) => {
      if (target.kind === "folder") await rpc.files.renameFolder({ folderId: target.id, name });
      else await rpc.files.rename({ fileId: target.id, name });
    },
    stale,
    onSaved: () => {
      setRenameTarget(null);
      setRenameName("");
    },
  });
  const updateFile = useSave({
    save: (
      input: { fileId: string; name: string; slug: string | null; description: string | null },
      rpc,
    ) => rpc.files.update(input),
    stale,
    onSaved: () => {
      setEditTarget(null);
    },
  });
  const trash = useSave({
    save: async (target: DriveItem, rpc) => {
      if (target.kind === "folder") await rpc.files.trashFolder({ folderId: target.id });
      else await rpc.files.trash({ fileId: target.id });
    },
    stale,
  });
  const restore = useSave({
    save: async (target: DriveItem, rpc) => {
      if (target.kind === "folder") await rpc.files.restoreFolder({ folderId: target.id });
      else await rpc.files.restore({ fileId: target.id });
    },
    stale,
  });
  const remove = useSave({
    save: async (target: DriveItem, rpc) => {
      if (target.kind === "folder") await rpc.files.deleteFolder({ folderId: target.id });
      else await rpc.files.deletePermanent({ fileId: target.id });
    },
    stale,
    onSaved: () => setDeleteTarget(null),
  });
  const emptyTrash = useSave({
    save: (_input: undefined, rpc) => rpc.files.emptyTrash(),
    stale,
    onSaved: () => setEmptyTrashOpen(false),
  });

  function startUpload(picked: FileList | readonly File[] | null) {
    if (!picked?.length || trashed) return;
    const max = getMaxFileUploadSizeBytes();
    const accepted: File[] = [];
    const skipped: string[] = [];
    for (const file of Array.from(picked)) {
      if (!inferAttachmentMimeType(file.name, file.type)) {
        skipped.push(file.name);
        continue;
      }
      if (file.size > max) {
        skipped.push(t`${file.name} (over ${attachmentSizeLabel(max)})`);
        continue;
      }
      accepted.push(file);
    }
    setNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
    if (accepted.length) upload.run({ pending: accepted, destination: folderId ?? null });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleTrash() {
    setTrashed((current) => !current);
    setNotice(null);
  }

  const actionError =
    upload.error ??
    createFolder.error ??
    rename.error ??
    updateFile.error ??
    trash.error ??
    restore.error ??
    remove.error ??
    emptyTrash.error ??
    (listing.error && listing.data ? listing.error : null);
  const loadError =
    listing.error && !listing.data ? errorDetails(listing.error, t`Could not load files.`) : null;

  function itemActions(item: DriveItem): ItemActions {
    return {
      trashed,
      onRename: () => {
        if (item.kind === "file") {
          setEditTarget(item);
          setEditName(item.name);
          setEditSlug(item.slug ?? "");
          setEditDescription(item.description ?? "");
        } else {
          setRenameTarget(item);
          setRenameName(item.name);
        }
      },
      onMove: () =>
        setMoveTarget({
          kind: item.kind,
          id: item.id,
          name: item.name,
          parentId: item.parentId,
        }),
      onDownload: item.kind === "file" ? () => downloadArtifact(item.id, item.name) : undefined,
      onTrash: () => trash.run(item),
      onRestore: () => restore.run(item),
      onDelete: () => setDeleteTarget(item),
    };
  }

  const view = driveViewPreference.use();
  const grid = drive && view === "grid" && !artifactId;
  const searchInput = (
    <ListSearchInput
      query={search}
      setQuery={setSearch}
      label={t`Search files`}
      placeholder={t`Search files…`}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {desktopBridge() ? <WindowChrome /> : null}
        {drive ? (
          <div className="min-w-48 max-w-xl flex-1">{searchInput}</div>
        ) : (
          <div className="flex min-w-fit flex-1 items-center gap-1">
            <IconTooltip label={t`Back`}>
              <Link
                to="/app"
                aria-label={t`Back`}
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "text-muted-foreground",
                })}
              >
                <ChevronLeft />
              </Link>
            </IconTooltip>
            <h1 className="font-medium text-foreground">
              <Trans>Files</Trans>
            </h1>
          </div>
        )}
        <div className="app-no-drag flex items-center gap-1">
          {drive ? null : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Trash`}
              aria-pressed={trashed}
              className={trashed ? "bg-accent text-foreground" : "text-muted-foreground"}
              onClick={toggleTrash}
            >
              <Trash2 />
            </Button>
          )}
          <IconTooltip label={t`New folder`}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`New folder`}
              className="text-muted-foreground"
              disabled={trashed}
              onClick={() => {
                setNewFolderName("");
                setNewFolderOpen(true);
              }}
            >
              <FolderPlus />
            </Button>
          </IconTooltip>
          <Button
            size="sm"
            disabled={trashed || upload.pending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="me-1.5" size={15} strokeWidth={1.9} />
            {upload.pending ? t`Uploading ${Math.round((uploadProgress ?? 0) * 100)}%` : t`Upload`}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILES_ACCEPT}
            className="hidden"
            onChange={(event) => startUpload(event.target.files)}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <nav
          aria-label={t`Breadcrumbs`}
          className="flex w-full min-w-0 items-center gap-1 overflow-x-auto text-body-sm text-muted-foreground empty:hidden sm:w-auto sm:flex-1"
        >
          {trashed ? (
            <>
              <span className="font-medium text-foreground">{t`Trash`}</span>
              <span className="flex-1" />
              {items && items.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={emptyTrash.pending}
                  onClick={() => setEmptyTrashOpen(true)}
                >
                  {t`Empty trash`}
                </Button>
              ) : null}
            </>
          ) : drive && breadcrumbs.length === 0 ? (
            <span className="font-medium text-foreground">{t`My files`}</span>
          ) : breadcrumbs.length ? (
            <>
              <Link to="/app/files" aria-label={t`All files`} className="hover:text-foreground">
                {drive ? t`My files` : <Folder size={14} strokeWidth={1.8} />}
              </Link>
              {breadcrumbs.map((crumb, index) => {
                const current = index === breadcrumbs.length - 1;
                return (
                  <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                    <ChevronRight size={13} strokeWidth={1.9} />
                    {current ? (
                      <span className="max-w-48 truncate font-medium text-foreground">
                        {crumb.name}
                      </span>
                    ) : (
                      <Link
                        to={`/app/files/folder/${encodeURIComponent(crumb.id)}`}
                        className="max-w-48 truncate hover:text-foreground"
                      >
                        {crumb.name}
                      </Link>
                    )}
                  </span>
                );
              })}
            </>
          ) : null}
        </nav>
        {!trashed && breadcrumbs.length === 0 ? (
          <div className="hidden sm:block sm:flex-1" />
        ) : null}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          {drive ? null : <div className="w-40 max-w-full sm:w-56">{searchInput}</div>}
          <OptionSelect
            aria-label={t`Filter by type`}
            className="w-fit"
            value={category}
            onValueChange={setCategory}
            options={categoryOptions}
          />
          <OptionSelect
            aria-label={t`Sort files`}
            className="w-fit"
            value={sort}
            onValueChange={setSort}
            options={sortOptions}
          />
          {drive && !artifactId ? (
            <fieldset aria-label={t`Layout`} className="flex rounded-lg border border-border p-0.5">
              {(["list", "grid"] as const).map((option) => (
                <Button
                  key={option}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={option === "list" ? t`List view` : t`Grid view`}
                  aria-pressed={view === option}
                  className={
                    view === option ? "bg-accent text-foreground" : "text-muted-foreground"
                  }
                  onClick={() => driveViewPreference.set(option)}
                >
                  {option === "list" ? <List /> : <LayoutGrid />}
                </Button>
              ))}
            </fieldset>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p className="border-b border-border bg-muted/60 px-4 py-2 text-body-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-body-sm text-destructive">
          {errorText(actionError, t`Could not complete this action.`)}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section
          aria-label={t`Files`}
          data-testid="files-list"
          className={`min-w-0 flex-col overflow-y-auto ${
            artifactId ? "hidden w-[340px] shrink-0 md:flex" : "flex flex-1"
          } ${dragging ? "ring-2 ring-inset ring-ring" : ""}`}
          onDragOver={(event) => {
            if (trashed || !isFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(event) => {
            if (!isFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            setDragging(false);
            if (!trashed) startUpload(event.dataTransfer.files);
          }}
        >
          {items === null ? (
            <div className="grid flex-1 place-items-center p-6 text-muted-foreground">
              {loadError ? (
                <ErrorNotice error={loadError} onRetry={() => listing.refetch()} />
              ) : (
                <Spinner aria-label={t`Loading…`} />
              )}
            </div>
          ) : items.length === 0 ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>
                  {trashed
                    ? t`Trash is empty`
                    : deferredSearch || category !== "all"
                      ? t`No matching files`
                      : t`No files yet`}
                </EmptyTitle>
                {!trashed && !deferredSearch && category === "all" ? (
                  <EmptyDescription>{t`Upload a file or ask a bot to save one.`}</EmptyDescription>
                ) : null}
              </EmptyHeader>
            </Empty>
          ) : grid ? (
            <div className="flex flex-col gap-5 p-4">
              {items.some((item) => item.kind === "folder") ? (
                <ul
                  aria-label={t`Folders`}
                  className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2"
                >
                  {items
                    .filter((item) => item.kind === "folder")
                    .map((item) => (
                      <ItemTile key={`folder:${item.id}`} item={item} {...itemActions(item)} />
                    ))}
                </ul>
              ) : null}
              {items.some((item) => item.kind === "file") ? (
                <ul
                  aria-label={t`Files`}
                  className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3"
                >
                  {items
                    .filter((item) => item.kind === "file")
                    .map((item) => (
                      <ItemTile key={`file:${item.id}`} item={item} {...itemActions(item)} />
                    ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {items.map((item) => (
                <ItemRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  active={item.kind === "file" && item.id === artifactId}
                  {...itemActions(item)}
                />
              ))}
            </div>
          )}
          {nextCursor ? (
            <div className="flex justify-center p-4">
              <Button
                variant="outline"
                size="sm"
                disabled={listing.isFetchingNextPage}
                onClick={() => void listing.fetchNextPage()}
              >
                {listing.isFetchingNextPage ? <Spinner aria-label={t`Loading…`} /> : null}
                {t`Load more`}
              </Button>
            </div>
          ) : null}
        </section>
        {artifactId ? (
          <FilePreviewPane key={artifactId} artifactId={artifactId} backTo="/app/files" />
        ) : null}
      </div>

      <NameDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) createFolder.reset();
        }}
        title={t`New folder`}
        label={t`Folder name`}
        value={newFolderName}
        onValueChange={setNewFolderName}
        pending={createFolder.pending}
        error={
          createFolder.error ? errorText(createFolder.error, t`Could not create the folder.`) : null
        }
        confirmLabel={t`Create`}
        onConfirm={() => {
          if (newFolderName.trim()) createFolder.run(newFolderName.trim());
        }}
      />
      <NameDialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            rename.reset();
          }
        }}
        title={t`Rename`}
        label={t`Name`}
        value={renameName}
        onValueChange={setRenameName}
        pending={rename.pending}
        error={rename.error ? errorText(rename.error, t`Could not rename this item.`) : null}
        confirmLabel={t`Save`}
        onConfirm={() => {
          if (renameTarget && renameName.trim())
            rename.run({ target: renameTarget, name: renameName.trim() });
        }}
      />
      <EditFileDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
            updateFile.reset();
          }
        }}
        name={editName}
        onNameChange={setEditName}
        slug={editSlug}
        onSlugChange={setEditSlug}
        description={editDescription}
        onDescriptionChange={setEditDescription}
        pending={updateFile.pending}
        error={
          updateFile.error ? errorText(updateFile.error, t`Could not update file details.`) : null
        }
        onConfirm={() => {
          if (editTarget && editName.trim()) {
            updateFile.run({
              fileId: editTarget.id,
              name: editName.trim(),
              slug: editSlug.trim() || null,
              description: editDescription.trim() || null,
            });
          }
        }}
      />
      <MoveDialog
        target={moveTarget}
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null);
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onCancel={() => {
          setDeleteTarget(null);
          remove.reset();
        }}
        title={
          deleteTarget
            ? deleteTarget.kind === "folder"
              ? t`Delete the folder "${deleteTarget.name}"?`
              : t`Delete "${deleteTarget.name}"?`
            : t`Delete?`
        }
        description={
          deleteTarget?.kind === "folder"
            ? t`This deletes the folder and everything in it. This can't be undone.`
            : t`This can't be undone.`
        }
        error={remove.error ? errorText(remove.error, t`Could not delete this item.`) : null}
        busy={remove.pending}
        onConfirm={() => deleteTarget && remove.run(deleteTarget)}
        confirmLabel={remove.pending ? t`Deleting…` : t`Delete`}
      />
      <ConfirmDialog
        open={emptyTrashOpen}
        onCancel={() => {
          setEmptyTrashOpen(false);
          emptyTrash.reset();
        }}
        title={t`Empty trash?`}
        description={t`This deletes every file in the trash. This can't be undone.`}
        error={emptyTrash.error ? errorText(emptyTrash.error, t`Could not empty the trash.`) : null}
        busy={emptyTrash.pending}
        onConfirm={() => emptyTrash.run(undefined)}
        confirmLabel={emptyTrash.pending ? t`Deleting…` : t`Empty trash`}
      />
    </div>
  );
}

type ItemActions = {
  trashed: boolean;
  onRename: () => void;
  onMove: () => void;
  onDownload?: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function itemHref(item: DriveItem): string {
  return item.kind === "folder"
    ? `/app/files/folder/${encodeURIComponent(item.id)}`
    : `/app/files/${encodeURIComponent(item.id)}`;
}

function ItemMenu({
  item,
  className,
  trashed,
  onRename,
  onMove,
  onDownload,
  onTrash,
  onRestore,
  onDelete,
}: { item: DriveItem; className: string } & ItemActions) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Actions for ${item.name}`}
            className={`text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100 ${className}`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {!trashed ? (
          <>
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              {item.kind === "file" ? t`Edit details` : t`Rename`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onMove}>
              <FolderInput />
              {t`Move`}
            </DropdownMenuItem>
            {onDownload ? (
              <DropdownMenuItem onClick={onDownload}>
                <Download />
                {t`Download`}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onTrash}>
              <Trash2 />
              {t`Move to Trash`}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={onRestore}>
              <RotateCcw />
              {t`Restore`}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {t`Delete permanently`}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({ item, active, ...actions }: { item: DriveItem; active: boolean } & ItemActions) {
  return (
    <div
      className={`group flex items-center gap-2 pe-2 ${
        active ? "bg-accent/60" : "hover:bg-accent/40"
      }`}
    >
      <Link to={itemHref(item)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          {item.kind === "folder" ? <Folder /> : <MimeIcon mimeType={item.mimeType} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium">{item.name}</span>
          {item.kind === "file" && item.description ? (
            <span className="block truncate text-body-sm text-muted-foreground">
              {item.description}
            </span>
          ) : null}
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-label text-muted-foreground">
            {item.kind === "file" ? <span>{formatFileSize(item.size)}</span> : null}
            <span>{formatRelativeTime(item.updatedAt)}</span>
            {item.kind === "file" && item.slug ? (
              <span className="truncate font-mono">{item.slug}</span>
            ) : null}
          </span>
        </span>
      </Link>
      <ItemMenu item={item} className="" {...actions} />
    </div>
  );
}

/** One folder or file in the Drive app's grid: a folder is a compact tile, a file a card. */
function ItemTile({ item, ...actions }: { item: DriveItem } & ItemActions) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  if (item.kind === "folder") {
    return (
      <li className="group flex items-center rounded-xl border border-border bg-card hover:bg-accent/40">
        <Link to={itemHref(item)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
          <Folder className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-body font-medium">{item.name}</span>
        </Link>
        <ItemMenu item={item} className="me-1" {...actions} />
      </li>
    );
  }
  const thumbnail = item.mimeType.startsWith("image/") && !thumbnailFailed;
  return (
    <li className="group relative overflow-hidden rounded-xl border border-border bg-card hover:bg-accent/40">
      <Link to={itemHref(item)} className="block">
        <span className="grid aspect-[4/3] place-items-center overflow-hidden bg-muted text-muted-foreground [&_svg]:size-8">
          {thumbnail ? (
            <img
              src={fileContentUrl(item.id)}
              alt=""
              loading="lazy"
              onError={() => setThumbnailFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <MimeIcon mimeType={item.mimeType} />
          )}
        </span>
        <span className="block px-3 py-2">
          <span className="block truncate text-body font-medium">{item.name}</span>
          <span className="block truncate text-label text-muted-foreground">
            {formatFileSize(item.size)} · {formatRelativeTime(item.updatedAt)}
          </span>
        </span>
      </Link>
      <ItemMenu
        item={item}
        className="absolute end-1.5 top-1.5 bg-background/85 backdrop-blur"
        {...actions}
      />
    </li>
  );
}

function MimeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon />;
  if (mimeType.startsWith("video/")) return <Video />;
  if (mimeType.startsWith("audio/")) return <FileAudio />;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip"))
    return <FileArchive />;
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("javascript") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("sql")
  )
    return <FileCode2 />;
  return <FileText />;
}

function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  value,
  onValueChange,
  pending,
  error,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  pending: boolean;
  error: string | null;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  const id = "drive-name";
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="w-[min(420px,94vw)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && value.trim()) onConfirm();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              <Input
                id={id}
                value={value}
                autoFocus
                disabled={pending}
                onChange={(event) => onValueChange(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {error ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={pending || !value.trim()}>
              {pending ? t`Saving…` : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditFileDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  slug,
  onSlugChange,
  description,
  onDescriptionChange,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  slug: string;
  onSlugChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="w-[min(440px,94vw)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t`Edit file details`}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && name.trim()) onConfirm();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="drive-edit-name">{t`Name`}</FieldLabel>
              <Input
                id="drive-edit-name"
                value={name}
                autoFocus
                disabled={pending}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="drive-edit-slug">{t`Slug`}</FieldLabel>
              <Input
                id="drive-edit-slug"
                value={slug}
                placeholder="example-search-slug"
                disabled={pending}
                onChange={(event) => onSlugChange(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="drive-edit-description">{t`Description`}</FieldLabel>
              <Input
                id="drive-edit-description"
                value={description}
                maxLength={280}
                disabled={pending}
                onChange={(event) => onDescriptionChange(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {error ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? t`Saving…` : t`Save`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
