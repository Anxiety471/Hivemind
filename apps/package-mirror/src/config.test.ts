import { describe, expect, it } from "vitest";
import { mirrorConfigFromEnv } from "./config.js";

describe("mirror configuration", () => {
  it("requires the public URL clients use", () => {
    expect(() => mirrorConfigFromEnv({})).toThrow("PACKAGE_MIRROR_PUBLIC_URL");
    expect(() => mirrorConfigFromEnv({ PACKAGE_MIRROR_PUBLIC_URL: " " })).toThrow(
      "PACKAGE_MIRROR_PUBLIC_URL",
    );
  });

  it("defaults to the fixed upstreams and a 20 GiB cache", () => {
    const config = mirrorConfigFromEnv({ PACKAGE_MIRROR_PUBLIC_URL: "https://mirror.example/" });
    expect(config.publicUrl).toBe("https://mirror.example");
    expect(config.npmUpstream).toBe("https://registry.npmjs.org");
    expect(config.goUpstream).toBe("https://proxy.golang.org");
    expect(config.pypiUpstream).toBe("https://pypi.org");
    expect(config.pypiFilesUpstream).toBe("https://files.pythonhosted.org");
    expect(config.maxBytes).toBe(20 * 1024 ** 3);
    expect(config.port).toBe(8099);
    expect(config.host).toBe("127.0.0.1");
  });

  it("reads operator overrides", () => {
    const config = mirrorConfigFromEnv({
      PACKAGE_MIRROR_PUBLIC_URL: "https://mirror.example",
      PACKAGE_MIRROR_DATA_DIR: "/srv/package-mirror",
      PACKAGE_MIRROR_HOST: "0.0.0.0",
      PACKAGE_MIRROR_PORT: "9000",
      PACKAGE_MIRROR_MAX_GB: "1.5",
      PACKAGE_MIRROR_NPM_UPSTREAM: "http://127.0.0.1:5000",
    });
    expect(config.dataDir).toBe("/srv/package-mirror");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.maxBytes).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(config.npmUpstream).toBe("http://127.0.0.1:5000");
  });

  it("rejects URLs with credentials, a query or a fragment", () => {
    for (const value of [
      "https://user:secret@mirror.example",
      "https://mirror.example/?token=1",
      "https://mirror.example/#x",
      "ftp://mirror.example",
      "not a url",
    ])
      expect(() => mirrorConfigFromEnv({ PACKAGE_MIRROR_PUBLIC_URL: value }), value).toThrow();
  });

  it("rejects a malformed port or size", () => {
    expect(() =>
      mirrorConfigFromEnv({
        PACKAGE_MIRROR_PUBLIC_URL: "https://m.example",
        PACKAGE_MIRROR_PORT: "0",
      }),
    ).toThrow("PACKAGE_MIRROR_PORT");
    expect(() =>
      mirrorConfigFromEnv({
        PACKAGE_MIRROR_PUBLIC_URL: "https://m.example",
        PACKAGE_MIRROR_MAX_GB: "0",
      }),
    ).toThrow("PACKAGE_MIRROR_MAX_GB");
  });
});
