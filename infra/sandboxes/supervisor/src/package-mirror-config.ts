import { packageMirrorBase } from "@rakazo/core/node/desktop-runtime";

/**
 * Cargo and Composer cannot be pointed at a registry mirror by environment variables (Cargo's
 * source replacement has no environment form; Composer reads repositories from config files),
 * so a computer created with a package mirror carries their config files in its own filesystem,
 * outside the saved home.
 */

/** Composer reads its global config.json from here; set as COMPOSER_HOME when a mirror is set. */
export const COMPOSER_MIRROR_HOME = "/etc/rakazo-composer";
/** Marks a computer as built for one mirror URL, so changing or removing it replaces the computer. */
export const PACKAGE_MIRROR_MARKER_ENV = "RAKAZO_PACKAGE_MIRROR_URL";

interface MirrorFile {
  path: string;
  content: string;
}

/** The config files for `mirrorUrl`, paths relative to the container root. */
export function packageMirrorConfigFiles(mirrorUrl: string): MirrorFile[] {
  const base = packageMirrorBase(mirrorUrl);
  if (!base) return [];
  return [
    {
      // Cargo merges every .cargo/config.toml from the working directory up to /.
      path: ".cargo/config.toml",
      content: [
        "[source.crates-io]",
        'replace-with = "rakazo-mirror"',
        "",
        "[source.rakazo-mirror]",
        `registry = "sparse+${base}/crates/index/"`,
        "",
      ].join("\n"),
    },
    {
      path: `${COMPOSER_MIRROR_HOME.slice(1)}/config.json`,
      content: `${JSON.stringify(
        {
          repositories: [{ "packagist.org": false }, { type: "composer", url: `${base}/composer` }],
          // The mirror is reached over plain http from the host's bridge network.
          config: { "secure-http": base.startsWith("https://") },
        },
        null,
        2,
      )}\n`,
    },
  ];
}

const BLOCK = 512;

function field(header: Buffer, offset: number, width: number, value: string) {
  header.write(value, offset, width, "ascii");
}

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarEntry(name: string, type: "0" | "5", content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(BLOCK);
  field(header, 0, 100, name);
  field(header, 100, 8, octal(type === "5" ? 0o755 : 0o644, 8));
  field(header, 108, 8, octal(0, 8));
  field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(content.length, 12));
  field(header, 136, 12, octal(0, 12));
  field(header, 148, 8, "        ");
  field(header, 156, 1, type);
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK);
  return Buffer.concat([header, content, padding]);
}

/**
 * A tar archive of the config files and their directories, owned by root and readable by all,
 * for Docker's putArchive at "/".
 */
export function packageMirrorConfigArchive(mirrorUrl: string): Buffer {
  const entries: Buffer[] = [];
  const directories = new Set<string>();
  for (const file of packageMirrorConfigFiles(mirrorUrl)) {
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = `${parts.slice(0, depth).join("/")}/`;
      if (directories.has(directory)) continue;
      directories.add(directory);
      entries.push(tarEntry(directory, "5", Buffer.alloc(0)));
    }
    entries.push(tarEntry(file.path, "0", Buffer.from(file.content)));
  }
  return Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)]);
}
