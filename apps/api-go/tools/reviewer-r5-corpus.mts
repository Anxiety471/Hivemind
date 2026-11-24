import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { MessageBlock } from "../../../packages/contracts/src/threads/message-blocks.js";

// Round-5 independent A-label generator. Different seed and operators from the
// fixer's corpus and from the round-4 generator: label splicing, codepoint
// warps, escape interleaving, dot transforms and case swaps, rather than only
// prefix + character mutation. Uses Node's real new URL and the real zod schema.

let state = 0x6d2b79f5 >>> 0;
function rand() {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
}
function pick(a) {
  return a[rand() % a.length];
}
function chance(n) {
  return rand() % n === 0;
}

const acePrefixes = ["xn--", "XN--", "xN--", "Xn--", "ｘｎ－－"];
const asciiPayloads = [
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
  "a-b",
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
  "a%b0",
  "a%2eb",
  "a%00b",
];
const unicodeLabels = [
  "ü",
  "é",
  "ß",
  "中",
  "例え",
  "テスト",
  "😀",
  "Ж",
  "עברית",
  "a\u00a0b",
  "a\u200db",
  "a\u0301",
  "a\ufeffb",
  "a\u2028b",
  "a\u3002b",
  "a\uff0eb",
  "a\uff61b",
  "xn--tda",
  "xn--bcher-kva",
  "xn--csfe",
  "xn--a",
  "i.ü",
  "80c1_.ü",
  "ywn2lno_.ü",
  "~k93j.ü",
  "K",
  "K\u00fc",
];
const suffixes = ["", ".example", ".EXAMPLE", ".example.", ".ü", ".例え", "。example", "．example"];
const paths = ["/", "/x", "/?q", "/#f", "/a/../b", "/%2e%2e/", ":443", "", "/a\\b"];
const bases = [
  "https://example.com/a/b?x=1#f",
  "http://[::1]:8080/a",
  "blob:https://example.com/id",
];

const curated = [
  "https://xn--csfe.ü/",
  "https://xn--kyb8m.ü/",
  "https://xn--pqbhw.80c1_.ü/",
  "https://xn--3wb.ywn2lno_.ü/",
  "https://xn--g7-h9e.~k93j.ü/",
  "https://xn--nybvznylx.i.ü/",
  "https://xn--bcher-kva.example/",
  "https://XN--BCHER-KVA.EXAMPLE./",
  "https://xn--bcüer-kva.example/",
  "https://xN--xü-/?",
  "https://xn---tda.ü/",
  "https://xn--a!/",
  "https://xn--a.example/",
  "https://xn--.ü/",
  "https://xn---.ü/",
  "https://xn----tda.ü/",
  "https://\uFF38\uFF2E\uFF0D\uFF0D-\u2160ls8h.EXAMPLE/x",
  "https://xn--a%2eb.ü/",
  "https://xn--a%00b.ü/",
  "https://xn--x\u00fc-/?",
  "https://xn--x\u30c8-.EXAMPLE",
].map((input) => ({ input, base: "", tag: "curated" }));

function payload() {
  if (chance(3)) return pick(asciiPayloads);
  let s = "";
  const n = 1 + (rand() % 12);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
  for (let i = 0; i < n; i++) s += alphabet[rand() % alphabet.length];
  return s;
}
function label() {
  switch (rand() % 8) {
    case 0:
      return pick(unicodeLabels);
    case 1:
      return pick(acePrefixes) + payload();
    case 2:
      return pick(acePrefixes) + payload() + "-" + payload();
    case 3:
      return "xn--" + payload() + "." + pick(unicodeLabels);
    case 4:
      return pick(unicodeLabels) + "." + pick(unicodeLabels);
    case 5:
      return pick(acePrefixes) + payload() + pick(suffixes);
    case 6:
      return pick(unicodeLabels).replace(".", pick(["\u3002", "\uff0e", "\uff61", "."]));
    default:
      return pick(unicodeLabels) + pick(asciiPayloads);
  }
}
function escapeSplice(host) {
  const chars = host.split("");
  const n = 1 + (rand() % 2);
  for (let i = 0; i < n && chars.length; i++) {
    const at = rand() % chars.length;
    const c = chars[at]!;
    const code = c.codePointAt(0)!;
    chars[at] = chance(2)
      ? `%${code.toString(16).padStart(2, "0")}`
      : `%u${code.toString(16).padStart(4, "0")}`;
  }
  return chars.join("");
}
function warpCodepoint(s) {
  const chars = Array.from(s);
  if (chars.length === 0) return s;
  const at = rand() % chars.length;
  const codepoints = [
    "\u0301",
    "\u200d",
    "\ufeff",
    "\u2028",
    "\u00a0",
    "\u3002",
    "\uff0e",
    "\uff61",
    "\u24e7",
    "\u2160",
    "\u00ad",
    "\ufffd",
    "\u{1f600}",
    "~",
    "_",
    "!",
  ];
  chars[at] = pick(codepoints);
  return chars.join("");
}
function build() {
  if (chance(4)) {
    const base = pick(bases);
    const ref = pick(["//", "\\", "///"]) + label() + pick(paths);
    return { input: ref, base, tag: "reference" };
  }
  let host = label();
  switch (rand() % 5) {
    case 0:
      host += "." + label();
      break;
    case 1:
      host = label() + "." + host;
      break;
    case 2:
      host = host.toUpperCase();
      break;
    case 3:
      host = escapeSplice(host);
      break;
    case 4:
      host = warpCodepoint(host);
      break;
  }
  const scheme = pick(["https", "https", "https", "http", "HTTPS", "ws", "ftp", "file", "foo"]);
  const slashes = pick(["//", "//", "//", "\\\\", "///"]);
  let input = `${scheme}:${slashes}${host}${pick(suffixes)}${pick(paths)}`;
  if (chance(4)) input = warpCodepoint(input);
  if (chance(5)) input = input.replace(".", pick(["。", "．", "｡"]));
  return { input, base: "", tag: "generated" };
}

const cases = [...curated];
const target = 22000;
while (cases.length < target) {
  if (chance(3)) {
    const seed = pick(curated).input;
    let s = seed;
    const op = rand() % 4;
    if (op === 0) s = warpCodepoint(s);
    else if (op === 1) s = escapeSplice(s);
    else if (op === 2) s = s.replace(/\./g, pick(["。", "．", "｡"]));
    else s = s.replace(/[A-Za-z]/g, (c) => (chance(2) ? c.toUpperCase() : c.toLowerCase()));
    cases.push({ input: s, base: chance(5) ? pick(bases) : "", tag: "mutated" });
  } else {
    cases.push(build());
  }
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
function credBlock(origin) {
  return {
    kind: "ask",
    text: "fresh credential card",
    credential: { name: "site_login", origin, auth: { type: "bearer" } },
  };
}
function otpBlock(origin) {
  return { kind: "ask", text: "fresh code card", oneTimeCode: { origin } };
}
const expected = cases.map((c) => ({
  input: c.input,
  base: c.base,
  tag: c.tag,
  node: nodeResult(c.input, c.base),
  zod: {
    cred: MessageBlock.array().safeParse([credBlock(c.input)]).success,
    otp: MessageBlock.array().safeParse([otpBlock(c.input)]).success,
  },
}));
const rows = expected.map((c, index) => ({
  id: `r5-${index}`,
  input: c.input,
  base: c.base,
  tag: c.tag,
  ...c.node,
  cred: c.zod.cred,
  otp: c.zod.otp,
}));
const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "..", "internal", "whatwgurl", "testdata");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "reviewer-r5-corpus.json.gz");
writeFileSync(outPath, gzipSync(Buffer.from(JSON.stringify(rows)), { level: 9 }));
console.log(`generated ${rows.length} cases into ${outPath}`);
