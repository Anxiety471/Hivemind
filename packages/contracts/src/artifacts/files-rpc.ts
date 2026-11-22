import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import {
  DriveChangeItemSchema,
  DriveFileSchema,
  DriveFolderTreeEntrySchema,
  FileCategorySchema,
  FileFolderNameSchema,
  FileFolderSchema,
  FileNameSchema,
  FileSortBySchema,
  FileSortDirSchema,
  FolderBreadcrumbSchema,
} from "./files.js";

export const filesRpc = {
  files: {
    list: oc
      .input(
        z.object({
          folderId: Id.nullable().optional(),
          /** When true, ignores folder hierarchy to show a flat Space-wide view (used with filters/search). */
          allFolders: z.boolean().optional(),
          botId: Id.optional(),
          madeByBots: z.boolean().optional(),
          category: FileCategorySchema.optional(),
          query: z.string().trim().max(200).optional(),
          trashed: z.boolean().optional(),
          sortBy: FileSortBySchema.optional(),
          sortDir: FileSortDirSchema.optional(),
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      )
      .output(
        z.object({
          breadcrumbs: z.array(FolderBreadcrumbSchema),
          folders: z.array(FileFolderSchema),
          files: z.array(DriveFileSchema),
          nextCursor: z.string().nullable(),
        }),
      ),
    get: oc.input(z.object({ fileId: Id })).output(DriveFileSchema),
    folderTree: oc.output(z.object({ folders: z.array(DriveFolderTreeEntrySchema) })),
    /** Delta feed ordered by (updatedAt ASC, id ASC) for Phase 4 Drive sync clients. */
    changes: oc
      .input(
        z.object({
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(DriveChangeItemSchema),
          nextCursor: z.string().nullable(),
          hasMore: z.boolean(),
        }),
      ),
    createFolder: oc
      .input(z.object({ parentId: Id.nullable().optional(), name: FileFolderNameSchema }))
      .output(FileFolderSchema),
    renameFolder: oc
      .input(z.object({ folderId: Id, name: FileFolderNameSchema }))
      .output(FileFolderSchema),
    moveFolder: oc
      .input(z.object({ folderId: Id, parentId: Id.nullable() }))
      .output(FileFolderSchema),
    trashFolder: oc.input(z.object({ folderId: Id })).output(z.object({ ok: z.literal(true) })),
    restoreFolder: oc.input(z.object({ folderId: Id })).output(FileFolderSchema),
    deleteFolder: oc.input(z.object({ folderId: Id })).output(z.object({ ok: z.literal(true) })),
    rename: oc.input(z.object({ fileId: Id, name: FileNameSchema })).output(DriveFileSchema),
    move: oc.input(z.object({ fileId: Id, folderId: Id.nullable() })).output(DriveFileSchema),
    trash: oc.input(z.object({ fileId: Id })).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(z.object({ fileId: Id })).output(DriveFileSchema),
    deletePermanent: oc.input(z.object({ fileId: Id })).output(z.object({ ok: z.literal(true) })),
    emptyTrash: oc.output(z.object({ ok: z.literal(true), deletedFiles: z.number().int() })),
  },
};
