import { describe, expect, it, vi } from "vitest";
import { applyDriveSpaceLink, driveOpenPath } from "./drive-url";

describe("driveOpenPath", () => {
  it("points at the session hand-over with the Space", () => {
    expect(driveOpenPath("space 1")).toBe("/api/drive/open?space=space+1");
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
