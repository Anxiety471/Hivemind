import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Authoritative UTS #46 mapping and leading-code-point probe for the URL
// Standard host parser, using the Node/ICU that this machine actually runs.
//
// Every non-surrogate code point is placed, percent-encoded, in a host label
// surrounded by neutral sentinels that force the non-ASCII IDNA path. The real
// `new URL` host parser then supplies:
//   - status: valid / mapped / ignored / disallowed,
//   - mapping: the mapped code point sequence for a single code point,
//   - first:  whether this code point may begin a label (ICU's effective
//             leading-mark rule, which is not General_Category=Mark),
//   - single-cp-host.json: the exact hostname (or throw) for the neutral
//     context `https://一<cp>一.ü/`, used as an exhaustive parity fixture.
//
// Dots and joiners are context-dependent and are handled explicitly; the
// companion idna-bidi-cases.mts derives the effective coarse Bidi classes.
//
// Usage: node --experimental-strip-types tools/idna-mapping-cases.mts [outDir]
// The outDir defaults to internal/whatwgurl/testdata. Regeneration is
// byte-identical on the same Node/ICU.

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "..", "internal", "whatwgurl", "testdata");
mkdirSync(outDir, { recursive: true });

const SENT_L = "一";
const SENT_R = "א";
const SENT_R2 = "ב";
const DOT_LIKE = new Set([0x2e, 0x3002, 0xff0e, 0xff61]);
const JOINERS = new Set([0x200c, 0x200d]);

const pctCache = new Map();
function pct(cp) {
  let v = pctCache.get(cp);
  if (v !== undefined) return v;
  v = "";
  for (const b of Buffer.from(String.fromCodePoint(cp), "utf8")) v += `%${b.toString(16).padStart(2, "0").toUpperCase()}`;
  pctCache.set(cp, v);
  return v;
}

function host(input) {
  try {
    return new URL(input).hostname;
  } catch {
    return null;
  }
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
    const length = out.length + 1;
    bias = adapt(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    i %= length;
    out.splice(i, 0, String.fromCodePoint(n));
    i++;
  }
  return out.join("");
}

function middle(h, lead, tail) {
  if (h === null) return null;
  const label = h.split(".")[0];
  let decoded = label;
  if (label.startsWith("xn--")) {
    decoded = decodePuny(label.slice(4));
    if (decoded === null) return null;
  }
  if (!decoded.startsWith(lead) || !decoded.endsWith(tail)) return null;
  if (decoded.length < lead.length + tail.length) return null;
  return decoded.slice(lead.length, decoded.length - tail.length);
}

const STATUS = { valid: 0, mapped: 1, ignored: 2, disallowed: 3 };
const mappings = [""];
const mappingIndex = new Map([["", 0]]);
const ranges = [];
const fixture = new Array(0x110000);
const anomalies = [];
let cur = null;
let count = 0;
const started = Date.now();

function flush() {
  if (cur) ranges.push(cur);
  cur = null;
}

for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  const enc = pct(cp);
  const ltr = host(`https://${SENT_L}${enc}${SENT_L}.ü`);
  fixture[cp] = ltr;
  let status, mapped = "", first;
  if (DOT_LIKE.has(cp)) {
    status = STATUS.mapped; mapped = "."; first = false;
  } else if (JOINERS.has(cp)) {
    status = STATUS.valid; first = false;
  } else {
    let m = middle(ltr, SENT_L, SENT_L);
    if (m === null) {
      const rtl = host(`https://${SENT_R}${enc}${SENT_R2}.ü`);
      m = middle(rtl, SENT_R, SENT_R2);
      if (m === null && (ltr !== null || rtl !== null)) {
        anomalies.push({ cp, ltr, rtl });
      }
    }
    if (m === null) {
      status = STATUS.disallowed; first = false;
    } else {
      mapped = m;
      status = m === ch ? STATUS.valid : m === "" ? STATUS.ignored : STATUS.mapped;
      const firstL = host(`https://${enc}a.ü`);
      const firstR = host(`https://${enc}${SENT_R2}.ü`);
      first = firstL !== null || firstR !== null;
    }
  }
  let mapIdx = 0;
  if (status === STATUS.mapped) {
    mapIdx = mappingIndex.get(mapped);
    if (mapIdx === undefined) {
      mapIdx = mappings.length;
      mappings.push(mapped);
      mappingIndex.set(mapped, mapIdx);
    }
  }
  const firstBit = first ? 1 : 0;
  if (cur && cur[2] === status && cur[3] === firstBit && cur[4] === mapIdx && cur[1] + 1 === cp) {
    cur[1] = cp;
  } else {
    flush();
    cur = [cp, cp, status, firstBit, mapIdx];
  }
  count++;
  if (count % 100000 === 0) console.error(`progress ${cp.toString(16)} ${Math.round((Date.now() - started) / 1000)}s`);
}
flush();

if (anomalies.length) {
  console.error("unexpected probe outcomes", JSON.stringify(anomalies.slice(0, 40)));
  process.exitCode = 1;
}

const meta = {
  source: "Node/ICU URL host parser, one non-surrogate code point per label",
  node: process.versions.node,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  v8: process.versions.v8,
  codepoints: count,
  ranges: ranges.length,
  mappings: mappings.length,
  anomalies: anomalies.length,
};
const mapping = { meta, mappings, ranges };
const hostFixture = { meta, hosts: fixture };
writeFileSync(join(outDir, "idna-mapping.json.gz"), gzipSync(Buffer.from(JSON.stringify(mapping)), { level: 9 }));
writeFileSync(join(outDir, "single-cp-host.json.gz"), gzipSync(Buffer.from(JSON.stringify(hostFixture)), { level: 9 }));
console.error(`wrote ${ranges.length} ranges, ${mappings.length} mappings, ${count} code points in ${Math.round((Date.now() - started) / 1000)}s`);
