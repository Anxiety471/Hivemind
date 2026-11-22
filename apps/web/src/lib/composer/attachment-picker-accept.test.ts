import { describe, expect, it } from "vitest";
import { attachmentPickerAccept } from "./attachment-picker-accept.js";

describe("attachmentPickerAccept", () => {
  it("offers every file type and leaves validation to the composer", () => {
    expect(attachmentPickerAccept()).toBe("*/*");
  });
});
