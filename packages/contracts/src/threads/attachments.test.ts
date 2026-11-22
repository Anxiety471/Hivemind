import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ARCHIVE_MIME_TYPES,
  ATTACHMENT_AUDIO_MIME_TYPES,
  ATTACHMENT_VIDEO_MIME_TYPES,
  appContract,
  artifactPreviewKind,
  attachmentMaxCount,
  FILE_UPLOAD_MAX_BYTES,
  fileUploadMaxBytes,
  isAllowedAttachmentMimeType,
  isAttachmentArchiveMimeType,
  isAttachmentAudioMimeType,
  isAttachmentVideoMimeType,
  MessageBlock,
  validateThreadsSendInput,
} from "../index.js";

describe("attachment contracts", () => {
  it("falls back to four attachments for older servers", () => {
    expect(attachmentMaxCount()).toBe(4);
    expect(attachmentMaxCount(null)).toBe(4);
    expect(attachmentMaxCount({})).toBe(4);
    expect(attachmentMaxCount({ maxAttachmentsPerMessage: 8 })).toBe(8);
  });

  it("advertises streaming Drive file upload limit with fallback", () => {
    expect(fileUploadMaxBytes()).toBe(FILE_UPLOAD_MAX_BYTES);
    expect(fileUploadMaxBytes({ maxFileUploadSizeBytes: 500 * 1024 * 1024 })).toBe(
      500 * 1024 * 1024,
    );
  });

  it("allows configured counts through the RPC schema up to the hard ceiling", () => {
    const schema = appContract.threads.send["~orpc"].inputSchema!;
    for (const count of [4, 5, 100]) {
      expect(
        schema.safeParse({
          botId: "bot-1",
          artifactIds: Array.from({ length: count }, (_, i) => `artifact-${i}`),
        }).success,
      ).toBe(true);
    }
    expect(
      schema.safeParse({
        botId: "bot-1",
        artifactIds: Array.from({ length: 101 }, (_, i) => `artifact-${i}`),
      }).success,
    ).toBe(false);
  });

  it.each(ATTACHMENT_AUDIO_MIME_TYPES)("allows %s as an audio file block", (mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect(isAttachmentAudioMimeType(mimeType)).toBe(true);
    expect(
      MessageBlock.parse({ kind: "file", artifactId: "audio-1", mimeType, name: "clip", size: 42 }),
    ).toMatchObject({ kind: "file", mimeType });
  });

  it.each(ATTACHMENT_VIDEO_MIME_TYPES)("allows %s as a video file block", (mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect(isAttachmentVideoMimeType(mimeType)).toBe(true);
    expect(artifactPreviewKind(mimeType)).toBe("video");
  });

  it("rejects blocked executable MIME types and malformed MIME strings", () => {
    expect(isAllowedAttachmentMimeType("application/x-msdownload")).toBe(false);
    expect(isAllowedAttachmentMimeType("application/x-dosexec")).toBe(false);
    expect(isAllowedAttachmentMimeType("not-a-mime-type")).toBe(false);
    expect(isAttachmentAudioMimeType("video/mp4")).toBe(false);
  });

  it.each(ATTACHMENT_ARCHIVE_MIME_TYPES)("allows %s as an archive file block", (mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect(isAttachmentArchiveMimeType(mimeType)).toBe(true);
    expect(artifactPreviewKind(mimeType)).toBe("none");
    expect(
      MessageBlock.parse({
        kind: "file",
        artifactId: "archive-1",
        mimeType,
        name: "bundle",
        size: 42,
      }),
    ).toMatchObject({ kind: "file", mimeType });
  });

  it("distinguishes archives from documents", () => {
    expect(isAttachmentArchiveMimeType("application/pdf")).toBe(false);
    expect(isAllowedAttachmentMimeType("application/x-sh")).toBe(true);
    expect(isAllowedAttachmentMimeType("application/octet-stream")).toBe(true);
  });

  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });

  it("previews text, scripts, videos, and documents consistently across clients", () => {
    expect(artifactPreviewKind("text/plain")).toBe("text");
    expect(artifactPreviewKind("text/csv; charset=utf-8")).toBe("text");
    expect(artifactPreviewKind("application/json")).toBe("text");
    expect(artifactPreviewKind("application/x-sh")).toBe("text");
    expect(artifactPreviewKind("application/toml")).toBe("text");
    expect(artifactPreviewKind("text/x-python")).toBe("text");
    expect(artifactPreviewKind("text/markdown")).toBe("markdown");
    expect(artifactPreviewKind("text/html")).toBe("html");
    expect(artifactPreviewKind("video/mp4")).toBe("video");
    expect(artifactPreviewKind("video/quicktime")).toBe("video");
    expect(artifactPreviewKind("video/webm")).toBe("video");
    expect(artifactPreviewKind("application/pdf")).toBe("pdf");
    expect(artifactPreviewKind("image/png")).toBe("image");
    expect(artifactPreviewKind("image/svg+xml")).toBe("none");
    expect(artifactPreviewKind("application/zip")).toBe("none");
  });
});
