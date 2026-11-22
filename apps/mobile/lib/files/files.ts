import type { DriveFile, DriveFolderTreeEntry, FileFolder, RpcOutput } from "@rakazo/contracts";
import { rpc } from "../api/api";

export type DrivePage = RpcOutput<"files/list">;
export type DriveListItem = DriveFile | FileFolder;

export function getDriveFile(fileId: string) {
  return rpc("files/get", { fileId });
}

/** A folder a file or folder can move into, named by its full path. */
export type DriveFolderChoice = { id: string; label: string };

/**
 * Every folder a move may target, as a path from the top. A folder being moved and everything
 * under it are left out: the server refuses those moves, so the menu does not offer them.
 */
export function driveFolderChoices(
  folders: readonly DriveFolderTreeEntry[],
  excludeFolderId?: string | null,
): DriveFolderChoice[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string | null, string[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    children.set(folder.parentId, siblings);
  }
  const excluded = new Set<string>();
  const pending = excludeFolderId ? [excludeFolderId] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  const pathOf = (folder: DriveFolderTreeEntry): string => {
    const names: string[] = [];
    let current: DriveFolderTreeEntry | undefined = folder;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(" / ");
  };
  return folders
    .filter((folder) => !excluded.has(folder.id))
    .map((folder) => ({ id: folder.id, label: pathOf(folder) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Folders before files, each alphabetically, as a file browser shows them. */
export function driveRows(page: Pick<DrivePage, "files" | "folders">): DriveListItem[] {
  return [
    ...[...page.folders].sort((a, b) => a.name.localeCompare(b.name)),
    ...[...page.files].sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/** A folder row, told apart from a file by the parent it carries. */
export function isDriveFolder(row: DriveListItem): row is FileFolder {
  return "parentId" in row;
}
