// Deterministic A-label mutation inputs for the WHATWG URL parity lane.
//
// Writes an input-only JSON array ({"input","base"}) to stdout. Fill in the
// Node expectations and compress the result with:
//
//   node_modules/.bin/tsx apps/api-go/tools/whatwg-url-alabel-cases.mts > /tmp/alabel-input.json
//   node_modules/.bin/tsx apps/api-go/tools/whatwg-url-oracle.mts /tmp/alabel-input.json \
//     | gzip -9 > apps/api-go/internal/whatwgurl/testdata/alabel-corpus.json.gz
//
// The cases cover the classes Node/ICU rejects but x/net/idna's punycode
// fallback accepts or mis-normalizes: non-ASCII inside an `xn--` label,
// uppercase/mapped ACE prefixes, empty and trailing-hyphen A-labels, all-ASCII
// invalid punycode, ASCII that decodes to a disallowed code point, mapped
// fullwidth/soft-hyphen prefixes, dot variants, percent escapes, special and
// opaque schemes, file URLs and relative references.

interface Case {
  input: string;
  base?: string;
}

let state = 0x9e3779b9 >>> 0;
function rand(): number {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
}
function pick<T>(values: readonly T[]): T {
  return values[rand() % values.length]!;
}

const prefixes = ["xn--", "XN--", "xN--", "Xn--", "ｘｎ－－", "ＸＮ－－", "x\u00adn--", "xn\u00ad--", "\u00adxn--"];
const nonASCII = [
  "ü", "ト", "Ж", "😀", "é", "ß", "中", "😀", "\u200d", "\u00a0", "\u3002", "\uff0e",
  "\uff61", "\u0301", "\u2003", "\u2028", "\ufffd", "\u0435", "\u0661", "\uff55", "\uff58",
  "\u00ad", "\u2024", "\u2160", "\u24e7", "\ufb00", "\u1e9e", "\u117c", "\u0081",
];
const asciiParts = ["", "a", "b", "0", "-", "kva", "bcher", "a-b", "x", "ls8h", "u-kva", "abc-", "a!", "a-"];
const suffixes = ["", ".example", ".EXAMPLE", ".example.", ".example。", "..example", ".ü", ".BÜCHER", ".ü.example", "。example", "\uff0eexample"];
const ports = ["", ":443", ":65536", ":0", ":８０", "::80"];
const paths = ["", "/", "/x", "/?", "/#f", "?q", "#f", "\\x", "/a/../b"];
const schemes = ["https://", "http://", "HTTPS://", "HtTp://", "file://", "file:///", "file:", "ws://", "wss://", "ftp://", "foo://", "blob:", ""];
const hosts = [
  "xn--bcher-kva.example", "XN--BCHER-KVA.EXAMPLE.", "xn--bcher-kva。example", "xn--bcｕer-kva.example",
  "xn--bcher-kva.ü", "xn--ls8h.ü", "xn--a!.ü", "xn--abc-.ü", "xn--.ü", "xn--a。example",
  "xn--bcüer-kva.example", "xn---е-.example。", "xn--xト-.EXAMPLE", "xN--xü-", "xn--ｕ.ü",
  "xn--bcüer.example./", "xn--bcüer..example/", "xn--a%2Db/", "xn--a%FF/", "xn%2D%2Dbc%C3%BCer/",
  "xn--bc%2eüer.example/", "\u00adxn--bcüer.example/", "xn--bc\u00adüer.example/",
  "xn--bcｕer.example/", "xn--bcher-kｖa.example/", "ａ--bcüer.example/", "xn＿＿bcüer.example/",
  "xn--bcher-kva.example:443/", "user:pass@xn--bcüer.example/", "xn--bcüer@example.com/",
  "example.com@xn--bcüer/", "[::1]", "127.0.0.1", "xn--bcüer.1", "xn--.example",
];

const cases: Case[] = [];
const seen = new Set<string>();
function add(input: string, base?: string): void {
  const key = `${input}\u0000${base ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  cases.push(base === undefined ? { input } : { input, base });
}

// Fixed controls named by the review.
for (const input of [
  "https://xn--bcüer-kva.example/",
  "https://xN--xü-/?",
  "https://xn--xト-.EXAMPLE",
  "https://xn---е-.example。/x",
  "https://xn--bcher-kva.example",
  "https://XN--BCHER-KVA.EXAMPLE.",
  "https://xn--a!/",
  "https://xn--abc-/",
  "https://xn--/",
  "https://xn--a-/",
  "https://xn--ls8h/",
  "https://xn--u/",
  "https://xn--。example/",
  "https://xn--.example/",
  "https://foo://xn--bcüer.example/",
  "file://xn--bcüer.example/",
  "file:///xn--bcüer.example/",
]) {
  add(input);
}

// Structured A-label mutations.
for (const prefix of prefixes) {
  for (const left of asciiParts) {
    for (const mark of nonASCII) {
      const label = prefix + left + mark + pick(asciiParts);
      add(`https://${label}${pick(suffixes)}${pick(ports)}${pick(paths)}`);
    }
  }
}

// All-ASCII invalid punycode and decoded-disallowed forms, with and without a
// non-ASCII sibling that forces UTS #46 processing.
const allASCIILabels = [
  "xn--", "xn--a", "xn--a-", "xn--abc-", "xn--a!", "xn--u", "xn--u-kva", "xn--ls8h",
  "xn--0ca", "xn--a-ecp", "xn--bcher-kva", "xn--bcher-ka", "xn--bcher-Rkva",
  "xn--bcher-kvaexamgle", "xn--cher1kva", "xn--bcherkva", "xn--xn--a", "xn---",
];
for (const label of allASCIILabels) {
  for (const suffix of [".example", ".example.", ".ü", "。example", ""]) {
    add(`https://${label}${suffix}/`);
  }
}

// Scheme, host, port and path combinations.
for (const scheme of schemes) {
  for (const host of hosts) {
    add(`${scheme}${host}${pick(ports)}${pick(paths)}`);
  }
}

// Relative references against special and opaque bases.
const bases = ["https://base.example/a/", "http://base.example/", "file:///a/b", "foo://base.example/a/", "blob:https://base.example/"];
const refs = [
  "//xn--bcüer.example/", "\\\\xn--bcüer.example/", "/\\xn--bcüer.example/", "///xn--bcüer.example/",
  "//@xn--bcüer.example/", "//xn--。example/", "//xn--.example/", "xn--bcüer.example", "/xn--bcüer.example",
  "\\xn--bcüer.example", "?q", "#f", "//", "",
];
for (const base of bases) {
  for (const ref of refs) add(ref, base);
}

// Seeded byte-level mutations of a valid A-label and its siblings.
const seeds = [
  "https://xn--bcher-kva.example/",
  "https://xn--bcher-kva.ü/",
  "https://xn--bcüer-kva.example/",
  "https://xn--。example/",
  "https://XN--BCHER-KVA.EXAMPLE./",
  "file://xn--bcher-kva.example/x",
];
const alphabet = [
  ..."abxXnN0-_.:/\\@%[]!?=&#",
  ..."\u00a0\u00ad\u0301\u200d\u2024\u3002\uff0e\uff55\uff58\uff0d\u00fc\u4e2d",
];
while (cases.length < 6000) {
  const chars = [...pick(seeds)];
  for (let edits = 1 + (rand() % 3); edits > 0; edits--) {
    const position = rand() % (chars.length + 1);
    switch (rand() % 3) {
      case 0:
        if (chars.length > 0) chars.splice(Math.min(position, chars.length - 1), 1);
        break;
      case 1:
        chars.splice(position, 0, pick(alphabet));
        break;
      default:
        if (chars.length > 0) chars[Math.min(position, chars.length - 1)] = pick(alphabet);
        break;
    }
  }
  add(chars.join(""));
}

process.stdout.write(`${JSON.stringify(cases)}\n`);
