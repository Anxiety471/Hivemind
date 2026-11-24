import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Deterministic 50,000-case host/URL corpus aimed at the classes the UTS #46
// implementation must match: random punycode payloads and prefixes, Bidi
// labels (R/AL, AN, EN, NSM, neutral, emoji, and ICU's unexpected effective-L
// Arabic code points), ContextJ joiners with/without Virama and joining
// contexts, dot variants, escapes, case, and special-scheme references.
// Expected values come from Node's real `new URL`.
//
// Usage: node --experimental-strip-types tools/idna-random-cases.mts [outDir]

let state = 0x9e3779b9 >>> 0;
function rand() {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
}
function pick(list) {
  return list[rand() % list.length];
}
function chance(n) {
  return rand() % n === 0;
}

const HOST_CPS = [
  "a",
  "b",
  "c",
  "x",
  "y",
  "z",
  "0",
  "1",
  "-",
  "_",
  "~",
  "!",
  "$",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  ";",
  "=",
  "一",
  "ü",
  "é",
  "ß",
  "ς",
  "א",
  "ב",
  "ا",
  "ب",
  "ـ",
  "١",
  "٢",
  "́",
  "ً",
  "😀",
  "🇺🇸",
  "\u089B",
  "\u089E",
  "\u08B5",
  "\u08BC",
  "\u061D",
  "\u078C",
  "\u1AE5",
  "\u1AE7",
  "\u08E8",
  "क",
  "\u094D",
  "\u200C",
  "\u200D",
  "カ",
  "ｱ",
  "Ａ",
  "１",
  "\u3002",
  "\uFF0E",
  "\uFF61",
  "\u00AD",
  "\uFEFF",
  "\u00A0",
  "\u2024",
  "\uFFFD",
];
const START = [
  "a",
  "b",
  "x",
  "0",
  "1",
  "一",
  "ü",
  "א",
  "ا",
  "😀",
  "क",
  "\u08B5",
  "\u061D",
  "\u089B",
];
const JOINERS = ["\u200C", "\u200D"];
const VIRAMAS = ["\u094D", "\u09CD", "\u0A4D"];
const JOINING = ["ا", "ب", "ـ", "\u0710", "\u064B", "ً"];
const DOTS = [".", "\u3002", "\uFF0E", "\uFF61"];
const PAYLOADS = [
  "bcher-kva",
  "csfe",
  "kyb8m",
  "nybvznylx",
  "pqbhw",
  "3wb",
  "g7-h9e",
  "tda",
  "a",
  "abc",
  "abc-",
  "-abc",
  "0-jv3s",
  "x-lgu",
  "bcer-0rab",
  "a!b",
  "a~b",
  "a_b",
  "a--b",
  "a.b",
  "a%b",
  "80c1_",
  "ywn2lno_",
  "~k93j",
  "a%2eb",
  "a%00b",
  "a\u0301",
  "xn--tda",
];
const PREFIXES = ["xn--", "XN--", "xN--", "Xn--", "ｘｎ－－"];
const BASES = [
  "https://example.com/a/b?x=1#f",
  "http://[::1]:8080/a",
  "blob:https://example.com/id",
  "file:///base",
  "file://example.com/base",
  "foo://host/base",
  "data:text/plain,abc",
];
const SCHEMES = ["https", "https", "http", "HTTPS", "ws", "ftp", "file", "foo"];
const SLASHES = ["//", "//", "//", "///", "\\\\", "\\", ""];
const SUFFIXES = [
  "",
  ".example",
  ".EXAMPLE",
  ".example.",
  ".ü",
  ".例え",
  "。example",
  "．example",
  ":443",
  ":0",
  ".com",
];
const PATHS = ["/", "/x", "/?q", "/#f", "/a/../b", "/%2e%2e/", "/a\\b", ""];

function payload() {
  if (chance(2)) return pick(PAYLOADS);
  let s = "";
  const n = rand() % 12;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
  for (let i = 0; i < n; i++) s += alphabet[rand() % alphabet.length];
  if (chance(8)) s += pick(["!", "~", "_", "%", "%u0061", "%GG", "ü", "\u0301"]);
  return s;
}
function joinerLabel() {
  const kind = rand() % 6;
  if (kind === 0) return pick(VIRAMAS) + pick(JOINERS) + pick(START); // valid after Virama
  if (kind === 1) return pick(START) + pick(VIRAMAS) + pick(JOINERS); // valid at end
  if (kind === 2) return pick(JOINING) + pick(JOINERS) + pick(JOINING); // ZWNJ joining context
  if (kind === 3)
    return pick(JOINING) + pick(JOINERS) + pick(JOINING) + pick(JOINERS) + pick(JOINING);
  if (kind === 4) return pick(START) + pick(JOINERS) + pick(START); // usually invalid
  return pick(JOINERS) + pick(START); // invalid at start
}
function label() {
  const kind = rand() % 10;
  if (kind < 3) return pick(PREFIXES) + payload();
  if (kind < 4) return pick(PREFIXES) + payload() + "-" + payload();
  if (kind < 5) return pick(PREFIXES) + pick(["ü", "例", "\u08B5", "\u089B"]) + payload();
  if (kind < 7) return joinerLabel();
  let s = "";
  const n = 1 + (rand() % 5);
  for (let i = 0; i < n; i++) s += pick(HOST_CPS);
  return s;
}
function escapeSplice(host) {
  if (chance(3)) return host;
  const chars = Array.from(host);
  const n = 1 + (rand() % 3);
  for (let i = 0; i < n && chars.length; i++) {
    const at = rand() % chars.length;
    const cp = chars[at].codePointAt(0);
    if (chance(2)) {
      chars[at] = `%${cp.toString(16).padStart(2, "0")}`;
    } else {
      let bytes = "";
      for (const b of Buffer.from(chars[at], "utf8")) {
        bytes += `%${b.toString(16).padStart(2, "0").toUpperCase()}`;
      }
      chars[at] = bytes;
    }
  }
  return chars.join("");
}
function host() {
  const count = 1 + (rand() % 4);
  const labels = [];
  for (let i = 0; i < count; i++) labels.push(label());
  let out = labels.join(pick(DOTS));
  if (chance(6)) out = pick(DOTS) + out;
  if (chance(6)) out = out + pick(DOTS);
  if (chance(3)) out = out.toUpperCase();
  return escapeSplice(out);
}
function nodeResult(input, base) {
  try {
    const u = base ? new URL(input, base) : new URL(input);
    return {
      throws: false,
      href: u.href,
      origin: u.origin,
      protocol: u.protocol,
      username: u.username,
      password: u.password,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
    };
  } catch {
    return { throws: true };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "..", "internal", "whatwgurl", "testdata");
mkdirSync(outDir, { recursive: true });
const rows = [];
for (let i = 0; i < 50000; i++) {
  let input: string;
  let base = "";
  if (chance(7)) {
    base = pick(BASES);
    const ref = pick(["//", "///", "\\\\", "\\", "/", ""]) + host() + pick(PATHS);
    input = ref;
    if (chance(4)) input = pick(SCHEMES) + ":/" + ref.replace(/^[\\/]+/, "");
  } else {
    input = pick(SCHEMES) + ":" + pick(SLASHES) + host() + pick(SUFFIXES) + pick(PATHS);
  }
  rows.push({ id: `rand-${i}`, input, base, ...nodeResult(input, base) });
}
const outPath = join(outDir, "random-idna-corpus.json.gz");
writeFileSync(outPath, gzipSync(Buffer.from(JSON.stringify(rows)), { level: 9 }));
console.log(`generated ${rows.length} cases into ${outPath}`);
