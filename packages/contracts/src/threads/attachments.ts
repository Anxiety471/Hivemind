/** Default for legacy base64 RPC uploads and clients connected to older servers. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Default per-file limit for streaming Space Drive & file uploads. */
export const FILE_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
/** Hard ceiling within Postgres INT4 for single-file streaming uploads (2000 MiB). */
export const FILE_UPLOAD_MAX_CEILING_BYTES = 2000 * 1024 * 1024;
/** Turn attachments larger than this stay in Drive instead of auto-copying onto sandboxes. */
export const SANDBOX_AUTO_MATERIALIZE_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
/** Hard ceiling for the configurable per-message limit. */
export const ATTACHMENT_COUNT_CEILING = 100;
/** Shared photo preparation policy for web and mobile composers. */
export const ATTACHMENT_IMAGE_MAX_EDGE = 1_600;
export const ATTACHMENT_IMAGE_QUALITY = 0.7;
export const ARTIFACT_NAME_MAX_LENGTH = 255;
export const ARTIFACT_DESCRIPTION_MAX_LENGTH = 280;
export const ARTIFACT_SLUG_MAX_LENGTH = 120;
/** Base64 expands payload by 4/3; cap before decode to reject oversize uploads cheaply. */
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

/** Vision-capable raster images sent inline to LLM providers. */
export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AttachmentImageMimeType = (typeof ATTACHMENT_IMAGE_MIME_TYPES)[number];
const STEP_SCREENSHOT_PROFILE = ";profile=step-screenshot";
/**
 * A screenshot a reply kept so its later turns can see it again. Stored and read like an image
 * attachment, but this type keeps it out of every file list, search and version history.
 */
export const STEP_SCREENSHOT_MIME_TYPES = ATTACHMENT_IMAGE_MIME_TYPES.map(
  (type) => `${type}${STEP_SCREENSHOT_PROFILE}`,
);
export function stepScreenshotMimeType(imageType: AttachmentImageMimeType): string {
  return `${imageType}${STEP_SCREENSHOT_PROFILE}`;
}
export function isStepScreenshotMimeType(mimeType: string): boolean {
  return mimeType.endsWith(STEP_SCREENSHOT_PROFILE);
}
/** The image type a kept screenshot, or an image attachment, shows as; else undefined. */
export function storedImageMimeType(mimeType: string): AttachmentImageMimeType | undefined {
  const type = mimeType.endsWith(STEP_SCREENSHOT_PROFILE)
    ? mimeType.slice(0, -STEP_SCREENSHOT_PROFILE.length)
    : mimeType;
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)
    ? (type as AttachmentImageMimeType)
    : undefined;
}

export const ATTACHMENT_EXTRA_IMAGE_MIME_TYPES = [
  "image/avif",
  "image/heic",
  "image/heif",
  "image/svg+xml",
  "image/x-icon",
] as const;

export const ATTACHMENT_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/ogg",
  "video/x-m4v",
] as const;

export const ATTACHMENT_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
  "audio/flac",
  "audio/aac",
] as const;

export const ATTACHMENT_ARCHIVE_MIME_TYPES = [
  "application/zip",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
] as const;

export const ATTACHMENT_CODE_MIME_TYPES = [
  "application/x-sh",
  "application/javascript",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-httpd-php",
  "text/typescript",
  "text/x-python",
  "text/x-go",
  "text/x-rust",
  "text/x-c",
  "text/x-c++",
  "text/x-java",
  "text/x-ruby",
  "text/x-swift",
  "text/x-kotlin",
  "text/css",
  "text/x-diff",
] as const;

export const ATTACHMENT_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  ...ATTACHMENT_EXTRA_IMAGE_MIME_TYPES,
  ...ATTACHMENT_VIDEO_MIME_TYPES,
  ...ATTACHMENT_AUDIO_MIME_TYPES,
  ...ATTACHMENT_DOCUMENT_MIME_TYPES,
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  ...ATTACHMENT_CODE_MIME_TYPES,
  ...ATTACHMENT_ARCHIVE_MIME_TYPES,
  "application/octet-stream",
] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_FILE_MIME_TYPES,
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export const BLOCKED_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-dosexec",
  "application/x-msdos-program",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
]);

export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".msi",
  ".scr",
  ".com",
  ".pif",
]);

const MIME_SYNTAX_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isBlockedAttachmentMimeType(mimeType: string): boolean {
  return BLOCKED_ATTACHMENT_MIME_TYPES.has(normalizeMimeType(mimeType));
}

export function isBlockedAttachmentExtension(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return BLOCKED_ATTACHMENT_EXTENSIONS.has(lower.slice(dot));
}

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export function isAttachmentVideoMimeType(mimeType: string): boolean {
  return (ATTACHMENT_VIDEO_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export type ArtifactPreviewKind = "html" | "markdown" | "pdf" | "image" | "video" | "text" | "none";

const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/x-httpd-php",
]);

/** How every client previews a saved file, so web and mobile show the same types. */
export function artifactPreviewKind(mimeType: string): ArtifactPreviewKind {
  const type = normalizeMimeType(mimeType);
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "application/pdf") return "pdf";
  if (isAttachmentImageMimeType(type) || type === "image/avif") return "image";
  if (isAttachmentVideoMimeType(type)) return "video";
  if (type.startsWith("text/") || TEXT_APPLICATION_MIME_TYPES.has(type)) return "text";
  return "none";
}

export function isAttachmentAudioMimeType(mimeType: string): boolean {
  return (ATTACHMENT_AUDIO_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export function isAttachmentArchiveMimeType(mimeType: string): boolean {
  return (ATTACHMENT_ARCHIVE_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export function isAllowedAttachmentMimeType(mimeType: string): boolean {
  const type = normalizeMimeType(mimeType);
  if (!type || !MIME_SYNTAX_PATTERN.test(type)) return false;
  if (BLOCKED_ATTACHMENT_MIME_TYPES.has(type)) return false;
  if (type.startsWith("text/")) return true;
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(type);
}

export function validateThreadsSendInput(input: {
  text?: string;
  artifactIds?: string[];
}): boolean {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  return Boolean(text || artifactIds.length);
}

/** Effective per-file base64 RPC upload limit advertised in me/bootstrap. */
export function attachmentMaxBytes(config?: { maxUploadSizeBytes?: number } | null): number {
  return config?.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
}

/** Effective per-file streaming upload limit advertised in me/bootstrap. */
export function fileUploadMaxBytes(
  config?: { maxFileUploadSizeBytes?: number; maxUploadSizeBytes?: number } | null,
): number {
  return config?.maxFileUploadSizeBytes ?? FILE_UPLOAD_MAX_BYTES;
}

export function attachmentSizeLabel(maxBytes: number): string {
  return `${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MiB`;
}

/** Effective per-message limit, including the fallback for older servers. */
export function attachmentMaxCount(config?: { maxAttachmentsPerMessage?: number } | null): number {
  return config?.maxAttachmentsPerMessage ?? ATTACHMENT_MAX_COUNT;
}
