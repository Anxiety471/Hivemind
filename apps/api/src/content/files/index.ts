/**
 * TypeScript fallback for the Go Space Drive service (apps/api-go/internal/drive/service.go).
 * The Go gateway serves `/api/v1/files` and `files.*` first; this module keeps every behavior
 * available when a deployment runs the API alone. Response shapes, validation and error kinds
 * follow the Go implementation, with Prisma in place of pgx.
 *
 * Mutations are signalled by the route layer, as every content route is: the RPC paths are
 * listed in `spaceChangesFor`, and the plain HTTP upload publishes `"files"` after its commit.
 */

export { listDriveChanges } from "./changes.js";
export type {
  DriveByteRange,
  DriveChangesInput,
  DriveDeps,
  DriveListInput,
  DriveUploadParams,
  SpaceFileMeta,
} from "./common.js";
export {
  DriveConflictError,
  DriveFileTooLargeError,
  DriveNotFoundError,
  DriveValidationError,
  formatContentDisposition,
  isSafeInlineMedia,
  matchesIfNoneMatch,
  normalizeUploadFilename,
  parseSingleByteRange,
  sniffSafeUpload,
  validateDriveUploadMimeType,
} from "./common.js";
export { openSpaceFileContent, statSpaceFileContent } from "./content.js";
export {
  createDriveFolder,
  deleteDriveFolderPermanent,
  moveDriveFolder,
  renameDriveFolder,
  restoreDriveFolder,
  trashDriveFolder,
} from "./folders.js";
export {
  deleteDriveFilePermanent,
  emptyDriveTrash,
  getDriveFile,
  moveDriveFile,
  renameDriveFile,
  restoreDriveFile,
  trashDriveFile,
  updateDriveFile,
} from "./items.js";
export { getDriveFolderTree, listDriveFiles } from "./listing.js";
export { uploadSpaceFileStream } from "./upload.js";
