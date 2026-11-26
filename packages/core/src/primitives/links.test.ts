import { describe, expect, it } from "vitest";
import { httpsUrl } from "./links.js";

describe("httpsUrl", () => {
  it("keeps an https address", () => {
    expect(httpsUrl("https://code.example.test/worktrees/1")).toBe(
      "https://code.example.test/worktrees/1",
    );
    expect(httpsUrl("  https://code.example.test  ")).toBe("https://code.example.test");
  });

  it("drops anything that is not an https address without credentials", () => {
    expect(httpsUrl("http://code.example.test")).toBeUndefined();
    expect(httpsUrl("file:///etc/passwd")).toBeUndefined();
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpsUrl("https://user:secret@code.example.test")).toBeUndefined();
    expect(httpsUrl("not a url")).toBeUndefined();
    expect(httpsUrl("")).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});
