import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Derive the context-dependent UTS #46 data the host parser needs from the
// Node/ICU build this application actually runs:
//
//   - effective ContextJ joining classes (left/D, right/D, or transparent),
//   - effective Virama code points for the ZWJ/ZWNJ context,
//   - combining marks that ICU's UIDNA normalizer does not treat as marks
//     (effective canonical combining class 0) even though UnicodeData says
//     otherwise, so NFC must not reorder them.
//
// UnicodeData.txt supplies the candidate set and the canonical combining
// classes; all decisions are made by the real `new URL` parser. Dots and
// joiners are context-dependent and are excluded from the per-code-point
// probes.
//
// Usage: node --experimental-strip-types tools/idna-context-cases.mts <ucdDir> [testdataDir]
// Reads idna-mapping.json.gz and idna-bidi.json.gz; writes idna-context.json.gz.

const here = dirname(fileURLToPath(import.meta.url));
const ucdDir = process.argv[2] || "/tmp/ucd17";
const dir = process.argv[3] || join(here, "..", "internal", "whatwgurl", "testdata");
mkdirSync(dir, { recursive: true });

const mapping = JSON.parse(gunzipSync(readFileSync(join(dir, "idna-mapping.json.gz"))));
const bidi = JSON.parse(gunzipSync(readFileSync(join(dir, "idna-bidi.json.gz"))));
const unicodeData = readFileSync(join(ucdDir, "UnicodeData.txt"), "utf8");
const combiningHeader = readFileSync(join(ucdDir, "DerivedCombiningClass.txt"), "utf8").split("\n")[0];

function lookup(ranges, cp) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return r;
  }
  return null;
}
function statusOf(cp) {
  const r = lookup(mapping.ranges, cp);
  return r === null ? 3 : r[2];
}
function bidiOf(cp) {
  const r = lookup(bidi.ranges, cp);
  return r === null ? 6 : r[2];
}
function accepts(label) {
  try {
    new URL(`https://${label}.ü/`);
    return true;
  } catch {
    return false;
  }
}

const ccc = new Uint8Array(0x110000);
const canonicalDecomposition = new Map();
for (const line of unicodeData.split("\n")) {
  if (line === "") continue;
  const fields = line.split(";");
  const cp = parseInt(fields[0], 16);
  const value = parseInt(fields[3], 10);
  if (value !== 0) ccc[cp] = value;
  if (fields[5] !== "" && !fields[5].startsWith("<")) canonicalDecomposition.set(cp, fields[5]);
}

function decodePuny(input) {
  const out = [];
  let index = 0;
  const delim = input.lastIndexOf("-");
  if (delim >= 0) {
    for (let i = 0; i < delim; i++) out.push(input[i]);
    index = delim + 1;
  }
  const digit = (c) => {
    const o = c.codePointAt(0);
    if (o >= 0x61 && o <= 0x7a) return o - 0x61;
    if (o >= 0x41 && o <= 0x5a) return o - 0x41;
    if (o >= 0x30 && o <= 0x39) return o - 0x30 + 26;
    return -1;
  };
  let n = 128, i = 0, bias = 72;
  const adapt = (delta, points, first) => {
    delta = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > Math.floor(((36 - 1) * 26) / 2)) { delta = Math.floor(delta / (36 - 1)); k += 36; }
    return k + Math.floor((36 * delta) / (delta + 38));
  };
  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = 36; ; k += 36) {
      if (index >= input.length) return null;
      const d = digit(input[index++]);
      if (d < 0) return null;
      i += d * w;
      let t = k - bias;
      if (t < 1) t = 1;
      else if (t > 26) t = 26;
      if (d < t) break;
      w *= 36 - t;
    }
    if (w === 0) return null;
    const length = out.length + 1;
    bias = adapt(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    out.splice(i, 0, String.fromCodePoint(n));
    i++;
  }
  return out.join("");
}

// Decode the first host label of `https://<input>.ü/`, or return null.
function firstLabel(input) {
  let host;
  try {
    host = new URL(`https://${input}.ü/`).hostname;
  } catch {
    return null;
  }
  const label = host.slice(0, host.indexOf("."));
  if (!label.startsWith("xn--")) return label;
  return decodePuny(label.slice(4));
}

const L = 0, RT = 1, EN = 2, AN = 3, NSM = 4, NEUTRAL = 5, INVALID = 6;
const ZWNJ = "\u200C";
const ZWJ = "\u200D";
const REF = "\u0334"; // COMBINING TILDE OVERLAY, ccc 1
const ANOMALIES = [];
const L_SENT = "\u4E00";
const R_SENT = "\u05D0";
const D_JOIN = "\u0628"; // BEH, Joining_Type D
const R_JOIN = "\u0627"; // ALEF, Joining_Type R

const valid = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (statusOf(cp) === 0) valid.push(cp);
}

const transparent = new Uint8Array(0x110000);
const left = new Uint8Array(0x110000);
const right = new Uint8Array(0x110000);
const virama = new Uint8Array(0x110000);
let leftCount = 0, rightCount = 0, viramaCount = 0;

for (const cp of valid) {
  if (cp === 0x200c || cp === 0x200d) continue;
  const s = String.fromCodePoint(cp);
  const isLeft = accepts(`${L_SENT}${s}${ZWNJ}${R_JOIN}`);
  const isRight = accepts(`${L_SENT}${D_JOIN}${ZWNJ}${s}`);
  const isVirama = accepts(`${L_SENT}${s}${ZWJ}${L_SENT}`);
  if (isVirama) { virama[cp] = 1; viramaCount++; continue; }
  if (isLeft) { left[cp] = 1; leftCount++; }
  if (isRight) { right[cp] = 1; rightCount++; }
  if (!isLeft && !isRight) transparent[cp] = 1;
}

const nfcStarters = new Uint8Array(0x110000);
const nfcCandidates = [];
let nfcStarterCount = 0;
for (const cp of valid) {
  if (cp === 0x200c || cp === 0x200d || cp === 0x334) continue;
  if (ccc[cp] === 0) continue;
  const cls = bidiOf(cp);
  if (cls === INVALID || cls === EN) continue;
  const s = String.fromCodePoint(cp);
  const start = cls === RT || cls === AN ? R_SENT : L_SENT;
  const orderInput = `${start}${s}${REF}`;
  const orderLabel = firstLabel(orderInput);
  if (orderLabel === null) {
    ANOMALIES.push({ probe: "order", cp, cls, reason: "rejected" });
    continue;
  }
  const cpAt = orderLabel.indexOf(s);
  const refAt = orderLabel.indexOf(REF);
  if (cpAt < 0 || refAt < 0) {
    ANOMALIES.push({ probe: "order", cp, cls, reason: "missing", orderLabel: [...orderLabel].map((c) => c.codePointAt(0)) });
    continue;
  }
  if (refAt < cpAt) continue; // behaves as a mark with ccc > 1
  nfcCandidates.push({ cp, cls });
}

for (const { cp, cls } of nfcCandidates) {
  const s = String.fromCodePoint(cp);
  const rtl = cls === RT || cls === AN;
  const start = rtl ? "\u0627" : "a";
  const mark = rtl ? "\u0653" : "\u0301"; // madda / acute, ccc 230
  const composed = rtl ? "\u0622" : "\u00E1";
  const label = firstLabel(`${start}${s}${mark}`);
  if (label === null) {
    ANOMALIES.push({ probe: "compose", cp, cls, reason: "rejected" });
    continue;
  }
  if (label.includes(composed)) continue; // mark with effective ccc 1
  if (canonicalDecomposition.has(cp)) {
    ANOMALIES.push({ probe: "starter", cp, reason: "canonical decomposition", decomposition: canonicalDecomposition.get(cp) });
    continue;
  }
  nfcStarters[cp] = 1;
  nfcStarterCount++;
}

function rangesOf(table) {
  const ranges = [];
  let lo = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const value = cp < 0x110000 ? table[cp] : 0;
    if (value !== 0) {
      if (lo < 0) lo = cp;
    } else if (lo >= 0) {
      ranges.push([lo, cp - 1]);
      lo = -1;
    }
  }
  return ranges;
}

const out = {
  meta: {
    source: "Node/ICU `new URL` host parser probes over every valid code point",
    node: mapping.meta.node,
    icu: mapping.meta.icu,
    unicode: mapping.meta.unicode,
    v8: mapping.meta.v8,
    ucd: `UnicodeData.txt + ${combiningHeader.trim()}`,
    tested: valid.length,
  },
  nfcStarters: rangesOf(nfcStarters),
  joinerLeft: rangesOf(left),
  joinerRight: rangesOf(right),
  viramas: rangesOf(virama),
  transparent: rangesOf(transparent),
  counts: { valid: valid.length, nfcStarters: nfcStarterCount, left: leftCount, right: rightCount, viramas: viramaCount, transparent: valid.length - leftCount - rightCount - viramaCount - 2 },
  anomalies: ANOMALIES,
};
writeFileSync(join(dir, "idna-context.json.gz"), gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
console.error(
  `context: ${valid.length} valid, ${nfcStarterCount} NFC starters, ${leftCount} left, ${rightCount} right, ${viramaCount} viramas, ${ANOMALIES.length} anomalies`,
);
