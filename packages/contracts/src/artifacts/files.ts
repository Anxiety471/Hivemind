import * as z from "zod";
import { Id, IsoDate } from "../ids.js";
import { ARTIFACT_NAME_MAX_LENGTH, ARTIFACT_SLUG_MAX_LENGTH } from "../threads/attachments.js";

export const FileSourceSchema = z.enum(["upload", "chat", "bot", "email", "messaging"]);
export type FileSource = z.infer<typeof FileSourceSchema>;

export const FileCategorySchema = z.enum([
  "all",
  "video",
  "image",
  "audio",
  "document",
  "code",
  "archive",
]);
export type FileCategory = z.infer<typeof FileCategorySchema>;

export const FileSortBySchema = z.enum(["updatedAt", "name", "size"]);
export type FileSortBy = z.infer<typeof FileSortBySchema>;

export const FileSortDirSchema = z.enum(["asc", "desc"]);
export type FileSortDir = z.infer<typeof FileSortDirSchema>;

/** Slashes, control characters and the bare dot names are not file or folder names. */
function invalidDriveName(name: string): boolean {
  if (name === "." || name === "..") return true;
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || character === "/" || character === "\\") return true;
  }
  return false;
}

export const FileFolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_NAME_MAX_LENGTH)
  .refine(
    (name) => !invalidDriveName(name),
    "Folder name cannot contain slashes or control characters",
  );

export const FileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_NAME_MAX_LENGTH)
  .refine(
    (name) => !invalidDriveName(name),
    "File name cannot contain slashes or control characters",
  );

export const FileSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_SLUG_MAX_LENGTH)
  .refine(
    (slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
    "Slug must use lowercase letters, digits, and hyphens",
  );

export const FileFolderSchema = z.object({
  id: Id,
  parentId: Id.nullable(),
  botId: Id.nullable(),
  name: z.string(),
  trashedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type FileFolder = z.infer<typeof FileFolderSchema>;

export const FolderBreadcrumbSchema = z.object({
  id: Id,
  name: z.string(),
});
export type FolderBreadcrumb = z.infer<typeof FolderBreadcrumbSchema>;

export const DriveFileSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  groupId: Id.nullable(),
  runId: Id.nullable(),
  folderId: Id.nullable(),
  source: FileSourceSchema,
  name: z.string(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  hash: z.string(),
  version: z.number().int().positive(),
  versionCount: z.number().int().positive(),
  trashedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  contentUrl: z.string(),
});
export type DriveFile = z.infer<typeof DriveFileSchema>;

export const DriveFolderTreeEntrySchema = z.object({
  id: Id,
  parentId: Id.nullable(),
  botId: Id.nullable(),
  name: z.string(),
});
export type DriveFolderTreeEntry = z.infer<typeof DriveFolderTreeEntrySchema>;

export const DriveChangeItemSchema = z.object({
  kind: z.enum(["file", "folder"]),
  id: Id,
  parentId: Id.nullable(),
  name: z.string(),
  trashedAt: IsoDate.nullable(),
  updatedAt: IsoDate,
  hash: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
  version: z.number().int().positive().nullable(),
});
export type DriveChangeItem = z.infer<typeof DriveChangeItemSchema>;

export function fileContentPath(artifactId: string): string {
  return `/api/v1/files/${encodeURIComponent(artifactId)}/content`;
}
