/**
 * Differential proof for internal/whatwgurl against Node's WHATWG URL.
 *
 * Corpora:
 *   - web-platform-tests urltestdata.json and setters_tests.json (the copy in the
 *     pinned github.com/nationallibraryofnorway/whatwg-url module, or --wpt);
 *   - web-platform-tests IdnaTestV2.json, each toASCII input as `https://<input>/`;
 *   - a generated corpus (default 200k) of URL records: special, file, blob and
 *     opaque schemes; IDN/UTS-46 labels; IPv4 shorthands; IPv6 literals; ports;
 *     userinfo; path dot segments and percent-encoding; queries and fragments;
 *     relative references; C0 controls, whitespace and backslashes; and every
 *     shape the URL-blocked procedures hand to `new URL` (see
 *     go-port/infra-d-design.md §2, outside this repository);
 *   - setter cases for hostname, pathname, hash, search, host, port, protocol,
 *     username and password;
 *   - zod 4.6.7 `z.string().url()` acceptance and stored value for every parse
 *     case.
 *
 * Both sides report href, origin, protocol, username, password, host, hostname,
 * port, pathname, search, hash, searchParams serialization and zod's result.
 * Zero mismatches is the bar; exits 1 otherwise.
 *
 * Run from apps/api-go:
 *   PATH=~/.local/opt/go/bin:$PATH node tools/infra-d-url-proof.mts \
 *     [--cases 200000] [--work /tmp/infra-d-url-proof] [--seed 0x9e3779b9] \
 *     [--wpt <dir>] [--show 25]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The real write sanitizer the procedure stack applies to every Prisma string.
import { sanitizeUtf16ForJson } from "../../../packages/core/src/messages/events.js";
// The exact zod build packages/contracts pins (pnpm workspace symlink).
import { z } from "../../../packages/contracts/node_modules/zod/index.js";

const zodURL = z.string().url();

// Boundaries: WPT and the Go driver output are external JSON, so they are parsed
// with the same zod the contracts use rather than read through a cast.
const WptRecord = z
  .object({ input: z.string(), base: z.string().nullable().optional() })
  .nullable();
const SetterRow = z.object({ href: z.string(), new_value: z.string() });
const IdnaEntry = z.object({ input: z.string() }).nullable();
const FieldsSchema = z.object({
  href: z.string(),
  origin: z.string(),
  protocol: z.string(),
  username: z.string(),
  password: z.string(),
  host: z.string(),
  hostname: z.string(),
  port: z.string(),
  pathname: z.string(),
  search: z.string(),
  hash: z.string(),
  params: z.string(),
});
const ProofLine = z.object({
  id: z.string(),
  ok: z.boolean(),
  fields: FieldsSchema.optional(),
  get: z.string().optional(),
  zok: z.boolean(),
  zvalue: z.string(),
  zraw: z.string().optional(),
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const DEFAULT_WORK = "/tmp/infra-d-url-proof";
const DEFAULT_WPT = join(GO_DIR, "internal", "whatwgurl", "testdata");
const DEFAULT_CASES = 200_000;

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1]!;
  const prefix = `${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const WORK = option("--work", DEFAULT_WORK);
const GENERATED = Number(option("--cases", String(DEFAULT_CASES)));
const SEED = Number(option("--seed", "0x9e3779b9"));
const WPT_DIR = option("--wpt", DEFAULT_WPT);
const SHOW = Number(option("--show", "25"));
if (!Number.isFinite(GENERATED) || GENERATED < 0) throw new Error("--cases must be >= 0");
mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------- corpus

type Op =
  | "parse"
  | "sethostname"
  | "setpathname"
  | "sethash"
  | "setsearch"
  | "sethost"
  | "setport"
  | "setprotocol"
  | "setusername"
  | "setpassword"
  | "searchparamset"
  | "searchparams-object"
  | "searchparams-multipair"
  | "searchparams-append"
  | "searchparams-delete"
  | "searchparams-get";

type TestCase = {
  id: string;
  op: Op;
  input: string;
  base?: string;
  set?: string;
  name?: string;
  value?: string;
  pairs?: [string, string][];
};

const cases: TestCase[] = [];
const counts: Record<string, number> = {};

/**
 * How a raw JavaScript string reaches Go: the corpus and the API are JSON, and
 * Go's encoding/json decodes an unpaired surrogate escape to U+FFFD. NUL and
 * every other code point survive. URL parsing applies the same USVString
 * conversion in JavaScript, so URL fields agree; the zod stored value is
 * compared on the raw input and on this Go-visible form (see §6 of the design).
 */
function goJSONString(value: string): string {
  return value.toWellFormed ? value.toWellFormed() : value.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function add(tag: string, op: Op, input: string, base?: string, set?: string): void {
  const id = `${tag}-${cases.length}`;
  cases.push({
    id,
    op,
    // Raw, not toWellFormed: zod must see the lone surrogate the wire can carry.
    input,
    ...(base !== undefined ? { base } : {}),
    ...(set !== undefined ? { set } : {}),
  });
  counts[tag] = (counts[tag] ?? 0) + 1;
}

// 1. web-platform-tests urltestdata.json: all records, with their base.
let wptLoaded = false;
try {
  const wpt: unknown = JSON.parse(readFileSync(join(WPT_DIR, "urltestdata.json"), "utf8"));
  if (!Array.isArray(wpt)) throw new Error("urltestdata.json is not an array");
  for (const entry of wpt) {
    const record = WptRecord.safeParse(entry);
    if (!record.success || record.data === null) continue;
    add("wpt", "parse", record.data.input, record.data.base ?? undefined);
  }
  wptLoaded = true;
} catch (error) {
  console.warn(`urltestdata.json not read from ${WPT_DIR}: ${message(error)}`);
}

// 2. web-platform-tests setters_tests.json, all attributes the package exposes.
const SETTER_OPS: Record<string, Op | undefined> = {
  hostname: "sethostname",
  pathname: "setpathname",
  hash: "sethash",
  search: "setsearch",
  host: "sethost",
  port: "setport",
  protocol: "setprotocol",
  username: "setusername",
  password: "setpassword",
};
try {
  const setters: unknown = JSON.parse(readFileSync(join(WPT_DIR, "setters_tests.json"), "utf8"));
  if (typeof setters !== "object" || setters === null)
    throw new Error("setters_tests.json is not an object");
  for (const [attribute, rows] of Object.entries(setters)) {
    const op = SETTER_OPS[attribute];
    if (!op || !Array.isArray(rows)) continue;
    for (const entry of rows) {
      const row = SetterRow.safeParse(entry);
      if (!row.success) continue;
      add(`setter-${attribute}`, op, row.data.href, undefined, row.data.new_value);
    }
  }
} catch (error) {
  console.warn(`setters_tests.json not read: ${message(error)}`);
}

// 3. IDNA conformance: every toASCII input as a host, which is how Node's URL
// host parser calls UTS 46. IdnaTestV2 covers the Unicode data; toascii.json
// adds the URL Standard's assorted cases.
for (const name of ["IdnaTestV2.json", "toascii.json"]) {
  try {
    const idna: unknown = JSON.parse(readFileSync(join(WPT_DIR, name), "utf8"));
    if (!Array.isArray(idna)) throw new Error(`${name} is not an array`);
    for (const entry of idna) {
      const record = IdnaEntry.safeParse(entry);
      if (!record.success || record.data === null) continue;
      add("idna", "parse", `https://${record.data.input}/`);
    }
  } catch (error) {
    console.warn(`${name} not read: ${message(error)}`);
  }
}

// 4. Deterministic PRNG.
function rng32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng32(SEED);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (p: number): boolean => random() < p;

function repeat(random_: () => number, min: number, max: number): number {
  return min + Math.floor(random_() * (max - min + 1));
}

// Component pools. Every entry is a shape the URL parser has a distinct rule for.
const schemes = [
  "http",
  "https",
  "ftp",
  "ws",
  "wss",
  "file",
  "blob",
  "mailto",
  "data",
  "javascript",
  "about",
  "custom",
  "a",
  "git+ssh",
  "HTTP",
  "HtTpS",
  "FILE",
  "web+demo",
  "urn",
  "tel",
  "chrome-extension",
];
const hosts = [
  "example.com",
  "Example.COM",
  "www.example.com",
  "example.com.",
  "example.com..",
  ".example.com",
  "example..com",
  "exa mple.com",
  "a_b.com",
  "-a.com",
  "a-.com",
  "xn--fa-hia.de",
  "faß.de",
  "FAẞ.DE",
  "日本語.jp",
  "例え.テスト",
  "😀.example",
  "e\u0301xample.com",
  "Ⅷ.example",
  "ﬀ.example",
  "a.．b",
  "example。com",
  "ex%61mple.com",
  "ex%2Fample.com",
  "%65xample.com",
  "example%2Ecom",
  "localhost",
  "LOCALHOST",
  "local host",
  "localhost.",
  "a.localhost",
  "127.0.0.1",
  "127.0.0.1.",
  "0x7f.0.0.1",
  "0x7f.1",
  "0177.0.0.1",
  "127.1",
  "127.0.1",
  "2130706433",
  "0xffffffff",
  "0x100000000",
  "256.1.1.1",
  "1.2.3.4.5",
  "1.2.3.4.",
  "1.2.3.4..",
  "999999999",
  "0x",
  "0b101",
  "00",
  "1.2.3.09",
  "1e2",
  "3.14",
  "1.2.3.4%20",
  "1.2.3.4%2e",
  "1.2.3.0x4",
  "[::1]",
  "[::]",
  "[2001:db8::1]",
  "[::ffff:127.0.0.1]",
  "[1:2:3:4:5:6:7:8]",
  "[1::2::3]",
  "[::1].",
  "[::1%25eth0]",
  "[0:0:0:0:0:0:0:1]",
  "[v1.x]",
  "",
  ".",
  "..",
  "-",
  "_",
  "~",
  "!",
  "$&'()*+,;=",
  "a\u0000b",
  "\uFEFFexample.com",
  "buy\u200dnow.com",
  "a\u200cb.com",
  "אa.example",
  "aא.example",
  "\u05d0\u05d1.example",
  "a\u00adb.com",
  "\uff21\uff22.com",
  "İ.example",
  "ı.example",
  "\u212b.example",
  `${"a".repeat(63)}.com`,
  `${"a".repeat(64)}.com`,
  `${"a".repeat(300)}.com`,
  "%",
  "%zz",
  "%41",
  "%C3%A9",
  "%F0%9F%98%80",
  "%ED%A0%80",
  "%00",
];
const ports = [
  "",
  "80",
  "443",
  "21",
  "0",
  "0080",
  "08080",
  "65535",
  "65536",
  "99999999999999999999",
  "-1",
  "+80",
  " 80",
  "80 ",
  "abc",
  "0x50",
  "1e3",
  "80.5",
  "%38%30",
];
const userinfos = [
  "",
  "user",
  "user:pass",
  "us er",
  "user%20name:p%40ss",
  "@",
  "u:@",
  ":p",
  "u:p:q",
  "üser:päss",
  "%",
  "%zz",
  "user:pa#ss",
  "user:pa?ss",
  "user:pa/ss",
];
const paths = [
  "/",
  "",
  "/a/../b",
  "/a/./b",
  "/a//b",
  "/%2e%2e/x",
  "/a\\b",
  "/a%2fb",
  "/a b",
  "/a\u0000b",
  "/a\tb",
  "/a\nb",
  "/p/日本",
  "/%zz",
  "/%",
  "/%41",
  "/....//",
  "/a/b/..",
  "/a/b/.",
  "/a/b/../..",
  "/a/b/../../..",
  "/\\/a",
  "/.%2e/",
  "/%2E%2E/",
  "/|/",
  "/C|/",
  "/C:/x",
  "//x",
  "///x",
  "/a;b=c",
  "/a:b@c",
  "/a!$&'()*+,;=:@",
  '/a"<>`{}',
  "/a^b|c",
  "/a[ b]",
  "/~user/x",
  "/a/b/c/d/e/f/g",
  "/%C3%A9",
  "/%F0%9F%98%80",
  "/\u00e9",
  "/\u{1f600}",
  "/C:/a/../b",
  "/..",
  "/../x",
  "/./x",
  "/a/.hidden/b",
  "/a/b/.../c",
];
const queries = [
  "",
  "?",
  "?a",
  "?a=b",
  "?a=b&c=d",
  "?a=1+2",
  "?a=%zz",
  "?a=%41",
  "?q=😀",
  "?q=日",
  "?q=\u0000",
  "?q=a b",
  '?q="<>`{}',
  "?q='",
  "?a;b",
  "?a=b=c",
  "?&&&",
  "?+=+",
  "?a=%E4%B8%AD",
  "?a=%FF",
  "?a=%C3",
  "?q=#",
  "?q=\\",
  "?q=|^`",
  "?a=%2B",
  "?a=%26",
  "?a=%3D",
];
const fragments = [
  "",
  "#",
  "#f",
  "#a b",
  "#%zz",
  "#日",
  "#a#b",
  "#\u0000",
  '#<>"`{} ',
  "#%E4%B8%AD",
  "#f?g",
  "#f\\g",
  "#a|^",
];

function makeUrl(): string {
  const scheme = pick(schemes);
  if (
    scheme === "mailto" ||
    scheme === "data" ||
    scheme === "javascript" ||
    scheme === "urn" ||
    scheme === "tel"
  ) {
    return `${scheme}:${pick(["", "x", "x@y", "a,b", "text/plain,hi", "alert(1)", "?q", "#f", "x y"])}`;
  }
  if (scheme === "blob") {
    return `blob:${pick(["https://example.com/uuid", "http://h:80/x", "ftp://h/x", "blob:https://h/", "null/x", "file:///x", "", "https://h/x?y"])}`;
  }
  const slashes = pick(["//", "//", "//", "///", "\\\\", "/\\", "//", "///"]);
  const userinfo = pick(userinfos);
  const host = pick(hosts);
  const port = pick(ports);
  const path = pick(paths);
  const query = pick(queries);
  const fragment = pick(fragments);
  return `${scheme}:${slashes}${userinfo}${userinfo ? "@" : ""}${host}${port ? `:${port}` : ""}${path}${query}${fragment}`;
}

// Prefix/suffix noise the parser strips or keeps by rule.
const noisePrefixes = [
  "",
  "",
  "",
  " ",
  "  ",
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u001f",
  "\ufffd",
  "\ufeff",
  "\u00a0",
];
const noiseSuffixes = [
  "",
  "",
  "",
  " ",
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u001f",
  "\u00a0",
  "\ufeff",
  "\u2028",
];

// 5. Generated full URL records.
while ((counts.generatedUrl ?? 0) < Math.floor(GENERATED * 0.34)) {
  const url = makeUrl();
  add("generatedUrl", "parse", pick(noisePrefixes) + url + pick(noiseSuffixes));
}

// 6. Generated relative references against bases the app uses.
const bases = [
  "http://example.org/foo/bar",
  "https://example.org/",
  "https://example.org/a/b/c?q#f",
  "file:///C:/a/b",
  "custom://host/a/b",
  "http://user:pass@example.org:8080/a/b",
  "https://例え.テスト/a/",
  "blob:https://example.org/uuid",
  "http://[::1]:5173/",
  "https://example.com:443/app/",
  "https://example.com/app",
  "about:blank",
  "data:text/plain,x",
];
const refs = [
  "",
  "/",
  "//",
  "///",
  "?q",
  "#f",
  "../",
  "..",
  "../../g",
  "/./g",
  "g",
  "g/../h",
  "\\g",
  "..\\g",
  "/C:/x",
  "C:/x",
  "//host",
  "http:g",
  "https:g",
  "http://host",
  "?",
  "#",
  "////host",
  "%2e%2e/g",
  ".%2e/g",
  "..%2f/g",
  "?x#y",
  " \t/g",
  "g?x",
  "g#f",
  "//@host",
  "//u@h",
  "//h:99999",
  "mailto:x",
  "data:,x",
  "javascript:x",
  "//例え.テスト/p",
  "./a/./b/../c",
  "a b",
  "a%20b",
  "//0x7f.1/",
  "/p/slug-Token",
  "https://ex.com./x",
  "#a#b",
  "?a=b&c=d",
];
while ((counts.generatedRef ?? 0) < Math.floor(GENERATED * 0.22)) {
  add("generatedRef", "parse", pick(refs) + (chance(0.15) ? pick(noiseSuffixes) : ""), pick(bases));
}

// 7. Host and authority fuzz: every scheme against every host/port shape.
while ((counts.generatedHost ?? 0) < Math.floor(GENERATED * 0.18)) {
  const scheme = pick(["http", "https", "ftp", "ws", "wss", "file", "custom", "HTTP"]);
  const host = pick(hosts);
  const port = pick(ports);
  const userinfo = pick(userinfos);
  const slash = pick(["//", "//", "///", "\\\\"]);
  add(
    "generatedHost",
    "parse",
    `${scheme}:${slash}${userinfo}${userinfo ? "@" : ""}${host}${port ? `:${port}` : ""}/x`,
  );
}

// 8. IDN and Unicode labels built from code-point pools, including bidi and
// UTS-46 disallowed characters.
const unicodeRunes = [
  "a",
  "Z",
  "0",
  "-",
  ".",
  "ß",
  "ẞ",
  "é",
  "e\u0301",
  "日",
  "本",
  "\u0301",
  "\u200d",
  "\u200c",
  "\u00ad",
  "\u05d0",
  "\u0627",
  "１",
  "Ａ",
  "İ",
  "ı",
  "ς",
  "Σ",
  "σ",
  "\u2126",
  "\ufffd",
  "\u{1f600}",
  "\u{10ffff}",
  "\ufeff",
  "\u202e",
  "\u2066",
  "\u3002",
  "\uff0e",
  "\uff61",
  "_",
  "~",
];
while ((counts.generatedIdn ?? 0) < Math.floor(GENERATED * 0.12)) {
  const labels: string[] = [];
  for (let i = 0, n = repeat(random, 1, 4); i < n; i++) {
    let label = "";
    for (let j = 0, m = repeat(random, 0, 10); j < m; j++) label += pick(unicodeRunes);
    labels.push(label);
  }
  const host = labels.join(pick([".", "。", "．"]));
  add(
    "generatedIdn",
    "parse",
    `${pick(["https", "http", "custom"])}://${host}${pick(["/", "/x", ""])}`,
  );
}

// 9. Percent-encoding, control characters and backslashes inside each component.
const percentBits = [
  "%",
  "%2",
  "%25",
  "%2e",
  "%2E",
  "%2f",
  "%2F",
  "%5c",
  "%00",
  "%0a",
  "%0d",
  "%09",
  "%20",
  "%7f",
  "%80",
  "%C3",
  "%C3%A9",
  "%E4%B8%AD",
  "%zz",
  "%g0",
  "\t",
  "\n",
  "\r",
  " ",
  "\u0000",
  "\u001f",
  "\u007f",
  "\\",
  "/",
  "..",
  ".",
];
while ((counts.generatedPercent ?? 0) < Math.floor(GENERATED * 0.08)) {
  const pathBits = Array.from({ length: repeat(random, 0, 6) }, () =>
    pick([pick(percentBits), pick(paths)]),
  ).join("");
  const queryBits = Array.from({ length: repeat(random, 0, 4) }, () =>
    pick([pick(percentBits), pick(queries)]),
  ).join("");
  add("generatedPercent", "parse", `https://example.com/${pathBits}${queryBits}${pick(fragments)}`);
}

// 10. Arbitrary strings: parse attempts over ASCII punctuation and controls.
const asciiPool = Array.from({ length: 0x7f - 0x20 + 1 }, (_, index) =>
  String.fromCharCode(0x20 + index),
).concat(["\t", "\n", "\r", "\u0000"]);
while ((counts.generatedArbitrary ?? 0) < Math.floor(GENERATED * 0.04)) {
  let text = "";
  for (let i = 0, n = repeat(random, 0, 60); i < n; i++) text += pick(asciiPool);
  if (chance(0.4)) text = pick(["http:", "https://", "//", "file:", "custom:", "?"]) + text;
  add("generatedArbitrary", "parse", text);
}

// 11. The shapes the URL-blocked procedures actually parse, compare or store.
// vaultImportOrigin cells (contracts/src/integrations/vault-import.ts:243-266).
const vaultCells = [
  "example.com",
  "example.com,other.com",
  "example.com\nother.com",
  " example.com ",
  "https://example.com/login",
  "http://example.com/login",
  "example.com:8080",
  "https://user:pass@example.com/x",
  "https://example.com./x",
  "example.com.",
  "3.14",
  "0x7f.1",
  "127.1",
  "2130706433",
  "localhost",
  "intranet",
  "https://exa mple.com",
  "https://exa\tmple.com",
  "https://exa\nmple.com",
  "HTTPS://EX.COM",
  "https://[::1]/",
  "https://例え.テスト/ログイン",
  "https://example.com/path?q#f",
  "ftp://example.com/x",
  "example.com,",
  ",example.com",
  "my bank.com",
  "https://ex%61mple.com",
  "ex%2Fample.com",
  "https://example.com/%zz",
  "https://example.com:0/",
  "https://example.com:65536/",
];
for (const cell of vaultCells) add("inventoryVaultCell", "parse", cell);
for (const cell of vaultCells) {
  for (const bare of [true, false]) {
    const site = bare ? `https://${cell}` : cell;
    add("inventoryVaultImportURL", "parse", site);
  }
}

// pageUrlOrigin inputs (adapters/src/secrets/bot-secrets.ts:686-700).
const pageOrigins = [
  "https://example.com",
  "https://example.com/",
  "https://example.com/a/b?q#f",
  "http://example.com",
  "HTTP://EXAMPLE.COM:80/",
  "https://example.com:8443/x",
  "https://user:pass@example.com",
  "https://user@example.com/x",
  "https://:pass@example.com",
  "/https://example.com",
  "example.com",
  "example.com.",
  "https://example.com.",
  "blob:https://example.com/x",
  "blob:ftp://example.com/x",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/plain,x",
  "chrome-extension://abc/x",
  "https://[::1]:8080/x",
  "https://[::ffff:127.0.0.1]/",
  "https://127.1/",
  "https://0x7f.1/",
  "https://日本語.jp/パス",
  "https://xn--wgv71a119e.jp/",
  "https://example.com/%2e%2e/x",
  " https://example.com ",
  "\thttps://example.com\n",
  "\u0000https://example.com\u001f",
  "https://example.com\u2028",
  "\u00a0https://example.com",
  "https://example.com:99999",
];
for (const value of pageOrigins) add("inventoryPageOrigin", "parse", value);

// parsePluginSource inputs (adapters/src/integrations/plugin-connectors.ts:151-180).
const pluginSources = [
  "https://github.com/owner/repo",
  "https://github.com/owner/repo.git",
  "https://github.com/owner/repo/",
  "https://github.com/owner/repo/tree/main/sub/dir",
  "https://github.com/Owner/Repo",
  "https://github.com/owner/repo@v1",
  "https://github.com/owner/repo#subdir",
  "https://github.com/owner/repo@v1#subdir",
  "http://github.com/owner/repo",
  "https://user:pass@github.com/owner/repo",
  "https://github.com/owner/repo?x=1",
  "https://github.com:443/owner/repo",
  "https://github.com:8443/owner/repo",
  "https://gitlab.com/owner/repo.git@main",
  "https://example.com/a/b",
  "https://example.com/a",
  "not a url",
  "https://github.com/owner/repo/../other",
  "https://github.com/owner/repo/tree/",
  "https://github.com/owner/repo\\tree\\main",
  "https://例え.テスト/owner/repo",
  "https://github.com/owner/repo%2e",
  "https://github.com/owner/..",
  "",
];
for (const source of pluginSources) add("inventoryPluginSource", "parse", source);

// MCP endpoints (contracts/src/integrations/mcp.ts:10-25) and SSRF values.
const mcpEndpoints = [
  "https://mcp.example.com/sse",
  "http://192.168.1.10:3000/mcp",
  "https://example.com/",
  "https://example.com/#",
  "https://example.com/#frag",
  "https://user:pass@example.com/",
  "ws://example.com/socket",
  "wss://example.com/socket",
  "ftp://example.com/x",
  "https://example.com/?token=abc",
  "https://[::1]:8080/mcp",
  "https://0x7f.1/mcp",
  "https://example.com./mcp",
  "https://mcp.example.com:65535/x",
  "example.com",
  "http://",
  "https://",
  "https://例え.テスト/mcp",
  "blob:https://example.com/x",
];
for (const endpoint of mcpEndpoints) add("inventoryMcpEndpoint", "parse", endpoint);

// Routine watch URLs (contracts/src/routines/routine-watch.ts:66-80).
const watchUrls = [
  "https://example.com/status",
  "http://example.com/status",
  "https://example.com:8443/x",
  "https://user@example.com/x",
  "https://example.com/x#f",
  "https://example.com/",
  "https://example.com./x",
  "https://127.1/x",
  "https://例え.テスト/x",
  "example.com",
  "",
  "https://",
  "ws://example.com/x",
  "HTTPS://EXAMPLE.COM/x",
];
for (const url of watchUrls) add("inventoryRoutineWatch", "parse", url);

// pageShareUrl: new URL(`/p/...`, webOrigin) (contracts/src/artifacts/pages.ts:84).
const webOrigins = [
  "https://bots.bocchi.trade",
  "https://bots.bocchi.trade/",
  "https://bots.bocchi.trade/app",
  "https://bots.bocchi.trade:8443",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
  "https://Example.COM:443",
  "https://example.com:80",
  "https://bücher.example",
  "https://user:pw@example.com",
  "https://example.com/?x=1",
  "https://example.com/#f",
  "example.com",
  "",
];
const sharePaths = [
  "/p/token",
  "/p/my-title-token",
  "/p/",
  "/p/%zz",
  "/p/日本-token",
  "/p/a b-token",
  "/p/../token",
  "//p/token",
  "p/token",
  "/p/token?x=1",
  "/p/token#f",
];
for (const origin of webOrigins) {
  for (const path of sharePaths) add("inventoryPageShare", "parse", path, origin);
}

// Integration catalog: new URL("api/search", base) after a trailing slash is set
// (apps/api/src/integrations/integration-catalog.ts:25-31).
const catalogBases = [
  "https://catalog.example.com",
  "https://catalog.example.com/",
  "https://catalog.example.com/plugins",
  "http://localhost:8080",
  "https://catalog.example.com/api/",
  "https://catalog.example.com?x=1",
];
for (const base of catalogBases) {
  const url = new URL(base);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  add("inventoryCatalogSetPath", "parse", "/", undefined);
  add("inventoryCatalogBase", "parse", base);
  add("inventoryCatalogSearch", "parse", "api/search?q=x&limit=20", url.href);
}

// View-only screen URLs (apps/api/src/computers/computer-control.ts:346-355):
// the parser branch, not the catch fallback.
const screenUrls = [
  "https://screen.example.com/vnc?token=abc",
  "https://screen.example.com/vnc",
  "https://screen.example.com/vnc#f",
  "ws://screen.example.com/vnc?x=1",
  "desktop://local/session",
  "not a url",
  "https://例え.テスト/vnc?a=b",
];
for (const url of screenUrls) add("inventoryScreenUrl", "parse", url);

// auth URL normalization (connection-flows.ts:243) and favicon/new URL(href, base).
const authUrls = [
  "https://provider.example.com/oauth?state=1",
  "javascript:alert(1)",
  " HTTP://EXAMPLE.COM:80/a ",
  "//provider.example.com/x",
];
for (const url of authUrls) add("inventoryAuthUrl", "parse", url);

// 12. Setters on real shapes: hostname trailing-dot removal, pathname
// replacement, hash clearing, searchParams.set.
const setterBases = [
  "https://example.com./x",
  "https://EXAMPLE.com:8443/a/b?q=1#f",
  "http://127.0.0.1:5173/a?x=1",
  "file:///C:/a",
  "custom://host/a?b#c",
  "https://例え.テスト/a",
  "https://user:pass@example.com:80/x?y#z",
  "blob:https://example.com/uuid",
  "mailto:x@y",
];
const setterValues = {
  sethostname: [
    "example.com",
    "example.com.",
    "",
    "0x7f.1",
    "例え.テスト",
    "[::1]",
    "a b",
    "%",
    "localhost",
  ],
  setpathname: ["/a/b", "", "a", "/a/../b", "/a b", "/%2e%2e/x", "/日本", "/a?b", "/a#b"],
  sethash: ["", "#f", "f", "#a#b", "#a b", "#日本", "#%zz"],
  setsearch: ["", "?", "?a=1", "a=1", "?a=1&b=2", "?q=日", "?a=%zz"],
} as const;
for (const op of ["sethostname", "setpathname", "sethash", "setsearch"] as const) {
  for (const base of setterBases) {
    for (const value of setterValues[op]) add(`inventory-${op}`, op, base, undefined, value);
  }
}
for (const base of setterBases) {
  for (const [name, value] of [
    ["view_only", "true"],
    ["view_only", "false"],
    ["a", "1 2"],
    ["a", "日"],
    ["", ""],
  ] as const) {
    const id = `inventory-searchparamset-${cases.length}`;
    cases.push({ id, op: "searchparamset", input: base, name, value });
    counts["inventory-searchparamset"] = (counts["inventory-searchparamset"] ?? 0) + 1;
  }
}

// URLSearchParams construction, as screen-capability.ts:122 and
// slack-install-provider.ts:49 build their query from an object literal, plus
// the pair form, Append, Delete and Get.
const screenBase = "https://screen.example.com/vnc?token=abc";
const slackBase = "https://slack.com/oauth/v2/authorize";
const objectParamCases: [string, [string, string][]][] = [
  [
    screenBase,
    [
      ["autoconnect", "true"],
      ["resize", "scale"],
      ["view_only", "false"],
      ["path", "/novnc/session/control/1700000000.tok/websockify"],
    ],
  ],
  [
    screenBase,
    [
      ["autoconnect", "false"],
      ["resize", "off"],
      ["view_only", "true"],
      ["path", "/novnc/session/view/1.t/websockify?x=1&y=2"],
    ],
  ],
  [
    slackBase,
    [
      ["client_id", "123.456"],
      ["scope", "channels:history,chat:write,groups:read"],
      ["redirect_uri", "https://bots.bocchi.trade/messaging/slack/callback"],
      ["state", "state-中文-😀"],
    ],
  ],
  ["https://example.com/path?old=1#frag", [["a", "1"], ["b", "2 3"], ["c", "日"]]],
  ["https://example.com/", [["empty", ""], ["space", " "], ["plus", "+"], ["reserved", "#&=?"]]],
];
for (const [base, pairs] of objectParamCases) {
  const id = `inventory-searchparams-object-${cases.length}`;
  cases.push({ id, op: "searchparams-object", input: base, pairs });
  counts["inventory-searchparams-object"] = (counts["inventory-searchparams-object"] ?? 0) + 1;
}
const multiPairCases: [string, [string, string][]][] = [
  [
    "https://example.com/",
    [
      ["a", "1"],
      ["a", "2"],
      ["b", "3"],
    ],
  ],
  ["https://example.com/?x=0", [["a", "1"], ["empty", ""], ["space", "1 2"], ["unicode", "日"]]],
  [
    "https://example.com/",
    [
      ["reserved", "#&=+"],
      ["percent", "%20"],
      ["dup", "1"],
      ["dup", "2"],
    ],
  ],
];
for (const [base, pairs] of multiPairCases) {
  const id = `inventory-searchparams-multipair-${cases.length}`;
  cases.push({ id, op: "searchparams-multipair", input: base, pairs });
  counts["inventory-searchparams-multipair"] =
    (counts["inventory-searchparams-multipair"] ?? 0) + 1;
}
for (const [base, pairs] of [
  [screenBase, [["view_only", "false"]]],
  ["https://example.com/?a=1", [["a", "2"], ["a", "3"]]],
  ["https://example.com/", [["empty", ""], ["space", "1 2"]]],
] as [string, [string, string][]][]) {
  const id = `inventory-searchparams-append-${cases.length}`;
  cases.push({ id, op: "searchparams-append", input: base, pairs });
  counts["inventory-searchparams-append"] = (counts["inventory-searchparams-append"] ?? 0) + 1;
}
for (const [base, name] of [
  [screenBase, "token"],
  [screenBase, "view_only"],
  ["https://example.com/?a=1&a=2&b=3", "a"],
  ["https://example.com/?x=1", "absent"],
  ["https://example.com/", ""],
] as [string, string][]) {
  const id = `inventory-searchparams-delete-${cases.length}`;
  cases.push({ id, op: "searchparams-delete", input: base, name });
  counts["inventory-searchparams-delete"] = (counts["inventory-searchparams-delete"] ?? 0) + 1;
}
for (const [base, name] of [
  [screenBase, "token"],
  [screenBase, "absent"],
  ["https://example.com/?a=1&a=2", "a"],
  ["https://example.com/?a=1+2&b=%E6%97%A5", "a"],
  ["https://example.com/?a=1+2&b=%E6%97%A5", "b"],
] as [string, string][]) {
  const id = `inventory-searchparams-get-${cases.length}`;
  cases.push({ id, op: "searchparams-get", input: base, name });
  counts["inventory-searchparams-get"] = (counts["inventory-searchparams-get"] ?? 0) + 1;
}

// Raw UTF-16 that the JSON wire can carry: unpaired surrogates and NUL reach a
// TypeScript procedure as-is (JSON.parse) but Go's encoding/json decodes an
// unpaired surrogate to U+FFFD. URL parsing sees the same USVString on both
// sides; zod's stored value is checked on the raw input and the Go-visible form.
for (const raw of [
  "https://example.com/\ud800",
  "https://example.com/a\udfff",
  "https://example.com/\ud800\udfff", // a valid pair, well formed
  "https://\ud800.example/",
  "https://example.com/?q=\ud800",
  "https://example.com/#\ud800",
  "\ud800https://example.com/",
  "https://exa\ud800mple.com/",
  "https://example.com/\u0000",
  "https://example.com/a\u0000b",
  "https://example.com/?q=\u0000",
  "https://example.com/#\u0000",
  "\u0000https://example.com/",
  "https://example.com/\u0000\ud800",
]) {
  add("generatedUtf16", "parse", raw);
  add("generatedUtf16", "sethash", raw, undefined, "#\ud800");
  add("generatedUtf16", "setpathname", raw, undefined, "/\u0000x");
}

// ---------------------------------------------------------------- expected

type Fields = {
  href: string;
  origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  params: string;
};

function snapshot(url: URL): Fields {
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    params: url.searchParams.toString(),
  };
}

function parseCase(test: TestCase): { ok: boolean; fields?: Fields } {
  try {
    const url = test.base !== undefined ? new URL(test.input, test.base) : new URL(test.input);
    return { ok: true, fields: snapshot(url) };
  } catch {
    return { ok: false };
  }
}

type Expected = { ok: boolean; fields?: Fields; get?: string };

function applySetter(test: TestCase): Expected {
  let url: URL;
  try {
    url = new URL(test.input);
  } catch {
    return { ok: false };
  }
  const value = test.set ?? "";
  switch (test.op) {
    case "sethostname":
      url.hostname = value;
      break;
    case "setpathname":
      url.pathname = value;
      break;
    case "sethash":
      url.hash = value;
      break;
    case "setsearch":
      url.search = value;
      break;
    case "sethost":
      url.host = value;
      break;
    case "setport":
      url.port = value;
      break;
    case "setprotocol":
      url.protocol = value;
      break;
    case "setusername":
      url.username = value;
      break;
    case "setpassword":
      url.password = value;
      break;
    case "searchparamset":
      url.searchParams.set(test.name ?? "", test.value ?? "");
      break;
    case "searchparams-object":
      url.search = new URLSearchParams(Object.fromEntries(test.pairs ?? [])).toString();
      break;
    case "searchparams-multipair":
      url.search = new URLSearchParams(test.pairs ?? []).toString();
      break;
    case "searchparams-append":
      for (const [name, pairValue] of test.pairs ?? []) url.searchParams.append(name, pairValue);
      break;
    case "searchparams-delete":
      url.searchParams.delete(test.name ?? "");
      break;
    case "searchparams-get":
      return { ok: true, fields: snapshot(url), get: url.searchParams.get(test.name ?? "") };
    default:
      throw new Error(`unknown setter ${test.op}`);
  }
  return { ok: true, fields: snapshot(url) };
}

// ---------------------------------------------------------------- run proof

const corpusPath = join(WORK, "corpus.jsonl");
const expectedPath = join(WORK, "expected.jsonl");
const actualPath = join(WORK, "actual.jsonl");

const corpusLines: string[] = [];
const expectedLines: string[] = [];
// Counts the cases where zod's in-memory value and the Go-visible value differ
// (an unpaired surrogate). The sanitized forms must still agree; the wire proof
// then shows the real Prisma/Postgres stack stores that sanitized form.
let inMemoryZodDiffs = 0;
for (const test of cases) {
  const expected = test.op === "parse" ? parseCase(test) : applySetter(test);
  // Feed zod the raw input. The Go-visible form is what encoding/json yields.
  const zodRaw = zodURL.safeParse(test.input);
  const zodGo = zodURL.safeParse(goJSONString(test.input));
  if (zodRaw.success !== zodGo.success) {
    throw new Error(`zod verdict differs for raw and Go input: ${test.id}`);
  }
  const rawValue = zodRaw.success ? zodRaw.data : "";
  const goValue = zodGo.success ? zodGo.data : "";
  if (rawValue !== goValue) {
    inMemoryZodDiffs++;
    if (sanitizeUtf16ForJson(rawValue) !== sanitizeUtf16ForJson(goValue)) {
      throw new Error(`zod stored value differs after DB sanitization: ${test.id}`);
    }
  }
  corpusLines.push(JSON.stringify(test));
  expectedLines.push(
    JSON.stringify({
      id: test.id,
      ok: expected.ok,
      fields: expected.fields,
      get: expected.get ?? undefined,
      zok: zodGo.success,
      zvalue: goValue,
      zraw: rawValue,
    }),
  );
}
console.log(`zod raw/Go in-memory value differences: ${inMemoryZodDiffs} (DB-sanitized forms equal)`);
writeFileSync(corpusPath, `${corpusLines.join("\n")}\n`);
writeFileSync(expectedPath, `${expectedLines.join("\n")}\n`);

const binary = join(WORK, "urlproof");
console.log(`building ${binary}`);
const build = spawnSync("go", ["build", "-o", binary, "./cmd/urlproof"], {
  cwd: GO_DIR,
  encoding: "utf8",
  env: process.env,
});
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(1);
}
const run = spawnSync(binary, ["-corpus", corpusPath, "-out", actualPath], {
  cwd: GO_DIR,
  encoding: "utf8",
  maxBuffer: 1 << 28,
});
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(1);
}

const fieldNames = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
  "params",
] as const;
const expectedLinesRead = readFileSync(expectedPath, "utf8").split("\n");
const actualLinesRead = readFileSync(actualPath, "utf8").split("\n");
let mismatches = 0;
let shown = 0;
const byTag = new Map<string, number>();
const total = Math.min(expectedLinesRead.length, actualLinesRead.length);
for (let index = 0; index < total; index++) {
  const expectedLine = expectedLinesRead[index];
  const actualLine = actualLinesRead[index];
  if (!expectedLine || !actualLine) continue;
  const parsedExpected = ProofLine.safeParse(JSON.parse(expectedLine));
  const parsedActual = ProofLine.safeParse(JSON.parse(actualLine));
  if (!parsedExpected.success || !parsedActual.success) {
    throw new Error(`unreadable proof line ${index + 1}`);
  }
  const expected = parsedExpected.data;
  const actual = parsedActual.data;
  const problems: string[] = [];
  if (expected.id !== actual.id) problems.push(`id ${expected.id} != ${actual.id}`);
  if (expected.ok !== actual.ok) problems.push(`ok ${expected.ok} != ${actual.ok}`);
  if (expected.ok && actual.ok && expected.fields && actual.fields) {
    for (const field of fieldNames) {
      if (expected.fields[field] !== actual.fields[field]) {
        problems.push(
          `${field} ${JSON.stringify(expected.fields[field])} != ${JSON.stringify(actual.fields[field])}`,
        );
      }
    }
  }
  if (expected.zok !== actual.zok) problems.push(`zod ok ${expected.zok} != ${actual.zok}`);
  if (expected.zok && actual.zok && expected.zvalue !== actual.zvalue) {
    problems.push(
      `zod value ${JSON.stringify(expected.zvalue)} != ${JSON.stringify(actual.zvalue)}`,
    );
  }
  const expectedGet = expected.get ?? "";
  const actualGet = actual.get ?? "";
  if (expectedGet !== actualGet) {
    problems.push(`searchParams.get ${JSON.stringify(expectedGet)} != ${JSON.stringify(actualGet)}`);
  }
  if (problems.length > 0) {
    mismatches++;
    const tag = expected.id.replace(/-\d+$/, "");
    byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    if (shown < SHOW) {
      shown++;
      const test = cases[index]!;
      console.log(
        `MISMATCH ${expected.id} op=${test.op} input=${JSON.stringify(test.input)} base=${JSON.stringify(test.base)} set=${JSON.stringify(test.set)}`,
      );
      for (const problem of problems) console.log(`  ${problem}`);
    }
  }
}
if (expectedLinesRead.length !== actualLinesRead.length) {
  // A missing or extra result is a failure, not a note: a truncated Go run would
  // otherwise pass by comparing only the lines both files happen to have.
  mismatches += 1;
  byTag.set("line-count", (byTag.get("line-count") ?? 0) + 1);
  console.log(
    `MISMATCH line counts differ: expected ${expectedLinesRead.length - 1}, actual ${actualLinesRead.length - 1}`,
  );
}
console.log(`\n${cases.length} cases, ${mismatches} mismatches`);
console.log(`wpt=${wptLoaded ? "loaded" : "missing"} tags=${JSON.stringify(counts)}`);
if (mismatches > 0) {
  console.log(`mismatches by tag: ${JSON.stringify(Object.fromEntries(byTag))}`);
  process.exit(1);
}
