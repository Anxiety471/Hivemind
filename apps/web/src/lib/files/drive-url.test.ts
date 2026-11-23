import { describe, expect, it, vi } from "vitest";
import { applyDriveSpaceLink, driveFilesUrl } from "./drive-url";

describe("driveFilesUrl", () => {
  it("opens the Files page of the Drive app for a Space", () => {
    expect(driveFilesUrl("https://drive.example.com", "space 1")).toBe(
      "https://drive.example.com/app/files?space=space+1",
    );
  });
});

describe("applyDriveSpaceLink", () => {
  it("selects the linked Space and removes it from the address, keeping the rest", () => {
    const select = vi.fn();
    const replaceState = vi.fn();
    applyDriveSpaceLink(
      { href: "https://drive.example.com/app/files/folder/f1?space=s1&q=a#top" },
      { replaceState, state: { k: 1 } },
      select,
    );
    expect(select).toHaveBeenCalledWith("s1");
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/app/files/folder/f1?q=a#top");
  });

  it("leaves the address and the selected Space alone without a link", () => {
    const select = vi.fn();
    const replaceState = vi.fn();
    applyDriveSpaceLink(
      { href: "https://drive.example.com/app/files" },
      { replaceState, state: null },
      select,
    );
    expect(select).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
