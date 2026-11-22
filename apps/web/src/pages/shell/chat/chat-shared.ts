import { t } from "@lingui/core/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { previewMessageText as previewText } from "@rakazo/core";

/** A file already in the Space Drive, attached to a message by reference. */
export type PendingDriveFile = {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
};

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file?: File;
  driveFile?: PendingDriveFile;
  previewUrl?: string;
};

export function pendingAttachmentName(attachment: PendingAttachment): string {
  return attachment.file?.name ?? attachment.driveFile?.name ?? "";
}

/** Identity colour for bots the roster no longer knows about. */
export const FALLBACK_BOT_COLOR = "#85858A";

export function previewMessageText(message: ThreadMessage): string {
  return previewText(message, { photo: t`Photo`, attachment: t`Attachment`, message: t`Message` });
}
