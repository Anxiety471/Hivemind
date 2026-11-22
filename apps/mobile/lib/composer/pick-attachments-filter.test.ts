import { attachmentSizeLabel, fileUploadMaxBytes } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("Drive attachment filter", () => {
  it("blocks executable droppers by name and by MIME type", () => {
    const result = filterPickedAttachments(0, [
      { name: "setup.exe", mimeType: "application/octet-stream", size: 10, uri: "file:///a.exe" },
      {
        name: "installer",
        mimeType: "application/x-msdownload",
        size: 10,
        uri: "file:///installer",
      },
      { name: "clip.mp4", mimeType: "video/mp4", size: 10, uri: "file:///clip.mp4" },
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual(["clip.mp4"]);
    expect(result.skipped).toEqual([
      { name: "setup.exe", reason: "unsupported type" },
      { name: "installer", reason: "unsupported type" },
    ]);
  });

  it("accepts a video up to the streaming upload limit", () => {
    const maxBytes = fileUploadMaxBytes();
    const result = filterPickedAttachments(0, [
      {
        name: "clip.mp4",
        mimeType: "video/mp4",
        size: maxBytes,
        uri: "file:///clip.mp4",
      },
      {
        name: "long.mp4",
        mimeType: "video/mp4",
        size: maxBytes + 1,
        uri: "file:///long.mp4",
      },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: "clip.mp4", mimeType: "video/mp4" });
    expect(result.skipped).toEqual([
      { name: "long.mp4", reason: `over ${attachmentSizeLabel(maxBytes)}` },
    ]);
  });

  it("lets an existing Drive file bypass the upload limit", () => {
    const result = filterPickedAttachments(0, [
      {
        name: "recording.mp4",
        mimeType: "video/mp4",
        size: fileUploadMaxBytes() * 4,
        contentBase64: "",
        artifactId: "file-1",
      },
    ]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ artifactId: "file-1", contentBase64: "" });
  });
});
