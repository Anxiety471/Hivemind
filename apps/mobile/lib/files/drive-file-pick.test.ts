import type { DriveFile } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { offerDriveFile, subscribeDriveFilePick } from "./drive-file-pick";

const file = {
  id: "file-1",
  name: "report.pdf",
  mimeType: "application/pdf",
} as DriveFile;

describe("Drive file handoff", () => {
  it("reaches only the chat that waits for the pick", () => {
    const waiting = vi.fn();
    const other = vi.fn();
    const stop = subscribeDriveFilePick("bot-a", waiting);
    const stopOther = subscribeDriveFilePick("bot-b", other);
    offerDriveFile("bot-a", file);
    stop();
    offerDriveFile("bot-a", { ...file, id: "file-2" });
    expect(waiting).toHaveBeenCalledOnce();
    expect(waiting).toHaveBeenCalledWith(file);
    expect(other).not.toHaveBeenCalled();
    stopOther();
  });
});
