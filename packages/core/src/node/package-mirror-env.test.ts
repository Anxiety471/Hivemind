import { describe, expect, it } from "vitest";
import { computerPackageMirrorEnv } from "./desktop-runtime.js";

describe("computerPackageMirrorEnv", () => {
  it("leaves every package manager on its default when no mirror is configured", () => {
    expect(computerPackageMirrorEnv(undefined)).toEqual({});
    expect(computerPackageMirrorEnv("")).toEqual({});
    expect(computerPackageMirrorEnv("   ")).toEqual({});
  });

  it("points npm, Go and Python at the mirror", () => {
    expect(computerPackageMirrorEnv("https://mirror.example/")).toEqual({
      npm_config_registry: "https://mirror.example/npm/",
      NPM_CONFIG_REGISTRY: "https://mirror.example/npm/",
      GOPROXY: "https://mirror.example/go,direct",
      UV_INDEX_URL: "https://mirror.example/pypi/simple",
      UV_DEFAULT_INDEX: "https://mirror.example/pypi/simple",
      PIP_INDEX_URL: "https://mirror.example/pypi/simple",
    });
  });

  it("keeps a base path in front of each ecosystem", () => {
    expect(computerPackageMirrorEnv("https://example.test/packages").npm_config_registry).toBe(
      "https://example.test/packages/npm/",
    );
  });

  it("rejects values that are not a plain http(s) URL", () => {
    for (const value of [
      "not a url",
      "ftp://mirror.example",
      "https://user:secret@mirror.example",
      "https://mirror.example/?token=1",
      "https://mirror.example/#fragment",
    ])
      expect(() => computerPackageMirrorEnv(value), value).toThrow();
  });
});
