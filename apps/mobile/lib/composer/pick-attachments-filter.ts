import {
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
  fileUploadMaxBytes,
  isBlockedAttachmentExtension,
  isBlockedAttachmentMimeType,
} from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";

export type PickedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  contentBase64: string;
  /** The picked file, streamed as it is instead of being read into memory. */
  uri?: string;
  size?: number;
  /** A Space Drive file attached as it is, without uploading it again. */
  artifactId?: string;
  previewUri?: string;
};

export type PickSkip = { name: string; reason: string };

export function attachmentCountSkipReason(maxCount = ATTACHMENT_MAX_COUNT): string {
  return `max ${maxCount} attachments`;
}

export function attachmentSizeSkipReason(maxBytes: number): string {
  return `over ${attachmentSizeLabel(maxBytes)}`;
}

/**
 * Why a candidate cannot become an attachment, or null when it can. Callers can
 * ask before reading the content, so a rejected file is never loaded.
 */
export function attachmentSkipReason(
  candidate: {
    name: string;
    size: number;
    mimeType: string | null;
    artifactId?: string;
  },
  existingCount: number,
  acceptedCount: number,
  maxBytes = fileUploadMaxBytes(),
  maxCount = ATTACHMENT_MAX_COUNT,
): string | null {
  if (existingCount + acceptedCount >= maxCount) {
    return attachmentCountSkipReason(maxCount);
  }
  // An existing Drive file arrives by reference, so its size never passes through an upload.
  if (candidate.artifactId) return null;
  if (candidate.size > maxBytes) return attachmentSizeSkipReason(maxBytes);
  if (!candidate.mimeType) return "unsupported type";
  if (isBlockedAttachmentExtension(candidate.name)) return "unsupported type";
  if (isBlockedAttachmentMimeType(candidate.mimeType)) return "unsupported type";
  return null;
}

export function filterPickedAttachments(
  existingCount: number,
  candidates: Array<{
    name: string;
    mimeType: string | null;
    size: number;
    contentBase64?: string;
    uri?: string;
    artifactId?: string;
    previewUri?: string;
  }>,
  maxBytes = fileUploadMaxBytes(),
  maxCount = ATTACHMENT_MAX_COUNT,
): { attachments: PickedAttachment[]; skipped: PickSkip[] } {
  const attachments: PickedAttachment[] = [];
  const skipped: PickSkip[] = [];
  for (const candidate of candidates) {
    const reason = attachmentSkipReason(
      candidate,
      existingCount,
      attachments.length,
      maxBytes,
      maxCount,
    );
    if (reason) {
      skipped.push({ name: candidate.name, reason });
      continue;
    }
    attachments.push(pickedAttachment(candidate));
  }
  return { attachments, skipped };
}

export function pickedAttachment(
  candidate: Parameters<typeof filterPickedAttachments>[1][number],
): PickedAttachment {
  return {
    id: newClientId(),
    name: candidate.name,
    mimeType: candidate.mimeType ?? "application/octet-stream",
    contentBase64: candidate.contentBase64 ?? "",
    uri: candidate.uri,
    size: candidate.size,
    artifactId: candidate.artifactId,
    previewUri: candidate.previewUri,
  };
}
