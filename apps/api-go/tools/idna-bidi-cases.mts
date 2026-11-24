import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

// Derive the effective coarse Bidi class every valid code point has under the
// Node/ICU host parser's UTS #46 CheckBidi step. UCD Bidi_Class data can differ
// from the ICU data Node actually uses (U+08B5 is neutral in ICU while
// DerivedBidiClass-17 says AL), so the real host parser is the oracle.
//
// Coarse classes are all RFC 5893 needs: L, R/AL (RT), EN, AN, NSM, and
// neutral (ES/CS/ET/ON/BN). Sentinels U+4E00 (L) and U+05D0 (R) do not compose
// with combining marks, and every probe puts the subject after a starter so
// the leading-mark criterion cannot interfere.
//
// Usage: node --experimental-strip-types tools/idna-bidi-cases.mts [testdataDir]
// Reads idna-mapping.json.gz, writes idna-bidi.json.gz.

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(here, "..", "internal", "whatwgurl", "testdata");
mkdirSync(dir, { recursive: true });
const mapping = JSON.parse(gunzipSync(readFileSync(join(dir, "idna-mapping.json.gz"))));

function lookup(cp) {
  let lo = 0,
    hi = mapping.ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = mapping.ranges[mid];
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return r;
  }
  return null;
}
function statusOf(cp) {
  const r = lookup(cp);
  return r === null ? "disallowed" : ["valid", "mapped", "ignored", "disallowed"][r[2]];
}
function accepts(label) {
  try {
    new URL(`https://${label}.ü/`);
    return true;
  } catch {
    return false;
  }
}

const L = 0,
  RT = 1,
  EN = 2,
  AN = 3,
  NSM = 4,
  NEUTRAL = 5,
  INVALID = 6;
const classNames = ["L", "RT", "EN", "AN", "NSM", "NEUTRAL", "INVALID"];
const JOINERS = new Set([0x200c, 0x200d]);
const cls = new Uint8Array(0x110000);
cls.fill(INVALID);
const anomalies = [];
let valid = 0;
const started = Date.now();
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (statusOf(cp) !== "valid") continue;
  valid++;
  if (JOINERS.has(cp)) {
    cls[cp] = NEUTRAL;
    continue;
  }
  const ch = String.fromCodePoint(cp);
  const F = accepts(`一${ch}一`);
  const E = accepts(`א${ch}א`);
  const D = accepts(`一${ch}`);
  const C = accepts(`א${ch}`);
  const H = accepts(`א${ch}1`);
  const I = accepts(`א${ch}١`);
  let k = -1;
  if (F && !E && D && !C) k = L;
  else if (F && E && D && C) k = I ? NSM : EN;
  else if (F && E && D && !C) k = NEUTRAL;
  else if (!F && E && !D && C) k = H ? RT : AN;
  if (k < 0) anomalies.push({ cp, F, E, D, C, H, I });
  else cls[cp] = k;
  if (valid % 50000 === 0)
    console.error(`progress ${valid} ${Math.round((Date.now() - started) / 1000)}s`);
}

if (anomalies.length) {
  console.error("unclassified valid code points", JSON.stringify(anomalies.slice(0, 40)));
  process.exitCode = 1;
}

const ranges = [];
let lo = 0;
for (let cp = 1; cp <= 0x110000; cp++) {
  if (cp === 0x110000 || cls[cp] !== cls[lo]) {
    ranges.push([lo, cp - 1, cls[lo]]);
    lo = cp;
  }
}
const counts = {};
for (const cp of cls) counts[classNames[cp]] = (counts[classNames[cp]] || 0) + 1;
const out = {
  meta: {
    source: "Node/ICU URL host parser Bidi-rule probes (F/E/D/C/H/I matrix)",
    node: process.versions.node,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    classes: { L, RT, EN, AN, NSM, NEUTRAL, INVALID },
    classNames,
    valid,
    anomalies: anomalies.length,
    ranges: ranges.length,
  },
  counts,
  ranges,
};
writeFileSync(
  join(dir, "idna-bidi.json.gz"),
  gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }),
);
console.error(
  `wrote ${ranges.length} ranges for ${valid} valid code points in ${Math.round((Date.now() - started) / 1000)}s`,
  JSON.stringify(counts),
);
