import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Fetch the Unicode Character Database files used to regenerate the
// ContextJ/NFC probe outputs. These files are inputs to generation only and
// are not committed; the generated ranges and their provenance are committed
// under testdata.
//
// Usage: node --experimental-strip-types tools/fetch-ucd.mts [outDir]
// Default: internal/whatwgurl/testdata/ucd/17.0.0 (gitignored).

const UCD_VERSION = "17.0.0";
const BASE = `https://www.unicode.org/Public/${UCD_VERSION}/ucd`;
const FILES = [
  {
    name: "UnicodeData.txt",
    url: `${BASE}/UnicodeData.txt`,
    sha256: "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c",
  },
  {
    name: "DerivedCombiningClass.txt",
    url: `${BASE}/extracted/DerivedCombiningClass.txt`,
    sha256: "191463abfbd202703c6fd6776a92a23ac44ec65e0476a7f95aa91ca492cef29b",
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutDir = join(here, "..", "internal", "whatwgurl", "testdata", "ucd", UCD_VERSION);
const outDir = process.argv[2] || defaultOutDir;
mkdirSync(outDir, { recursive: true });

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

for (const file of FILES) {
  const path = join(outDir, file.name);
  if (existsSync(path) && digest(readFileSync(path)) === file.sha256) {
    console.log(`ok      ${path}`);
    continue;
  }
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`${file.url}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== file.sha256) {
    throw new Error(`${file.url}: sha256 ${actual}, expected ${file.sha256}`);
  }
  writeFileSync(path, bytes);
  console.log(`fetched ${path}`);
}

console.log(`UCD ${UCD_VERSION} ready at ${outDir}`);
