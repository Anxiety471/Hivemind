import { describe, expect, it } from "vitest";
import { computerPackageMirrorMatches, containerCreateOptions } from "./computer-spec.js";
import {
  COMPOSER_MIRROR_HOME,
  PACKAGE_MIRROR_MARKER_ENV,
  packageMirrorConfigArchive,
  packageMirrorConfigFiles,
} from "./package-mirror-config.js";

const MIRROR = "http://172.17.0.1:8099";

/** Reads a ustar archive back: name, type flag, checksum-validated, and body. */
function readTar(archive: Buffer) {
  const entries: { name: string; type: string; body: string }[] = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString("ascii", 0, 100).replace(/\0.*$/, "");
    const size = Number.parseInt(header.toString("ascii", 124, 135), 8);
    const stored = Number.parseInt(header.toString("ascii", 148, 154), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    expect(stored).toBe(copy.reduce((sum, byte) => sum + byte, 0));
    entries.push({
      name,
      type: header.toString("ascii", 156, 157),
      body: archive.toString("utf8", offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("package mirror config files", () => {
  it("points Cargo's crates.io at the mirror's sparse index", () => {
    const cargo = packageMirrorConfigFiles(`${MIRROR}/`).find(
      (file) => file.path === ".cargo/config.toml",
    );
    expect(cargo?.content).toContain('replace-with = "rakazo-mirror"');
    expect(cargo?.content).toContain(`registry = "sparse+${MIRROR}/crates/index/"`);
  });

  it("replaces Packagist with the mirror and allows plain http only for an http mirror", () => {
    const composer = (url: string) =>
      JSON.parse(
        packageMirrorConfigFiles(url).find((file) => file.path.endsWith("config.json"))!.content,
      );
    expect(composer(MIRROR)).toEqual({
      repositories: [{ "packagist.org": false }, { type: "composer", url: `${MIRROR}/composer` }],
      config: { "secure-http": false },
    });
    expect(composer("https://mirror.example").config).toEqual({ "secure-http": true });
  });

  it("packs the files and their parent directories into a valid tar archive", () => {
    const entries = readTar(packageMirrorConfigArchive(MIRROR));
    expect(entries.map(({ name, type }) => [name, type])).toEqual([
      [".cargo/", "5"],
      [".cargo/config.toml", "0"],
      ["etc/", "5"],
      ["etc/rakazo-composer/", "5"],
      ["etc/rakazo-composer/config.json", "0"],
    ]);
    expect(entries[1]?.body).toContain("sparse+");
  });
});

describe("package mirror on a computer", () => {
  const create = (packageMirrorUrl?: string) =>
    containerCreateOptions({
      image: "image",
      name: "name",
      botId: "bot",
      spaceId: "space",
      homePath: "/home-path",
      packageMirrorUrl,
    }).Env;

  it("marks the computer and points Composer at the mounted config only when a mirror is set", () => {
    expect(create(MIRROR)).toEqual(
      expect.arrayContaining([
        `${PACKAGE_MIRROR_MARKER_ENV}=${MIRROR}`,
        `COMPOSER_HOME=${COMPOSER_MIRROR_HOME}`,
      ]),
    );
    expect(
      create().some((entry) => /^(RAKAZO_PACKAGE_MIRROR_URL|COMPOSER_HOME)=/.test(entry)),
    ).toBe(false);
  });

  it("replaces a computer when the mirror is enabled, changed or removed", () => {
    expect(computerPackageMirrorMatches(create(MIRROR), MIRROR)).toBe(true);
    expect(computerPackageMirrorMatches(create(), undefined)).toBe(true);
    expect(computerPackageMirrorMatches(create(), MIRROR)).toBe(false);
    expect(computerPackageMirrorMatches(create(MIRROR), undefined)).toBe(false);
    expect(computerPackageMirrorMatches(create(MIRROR), "http://other:1")).toBe(false);
  });
});
