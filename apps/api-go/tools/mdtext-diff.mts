/**
 * Differential harness: plainTextFromMarkdown (TypeScript) against
 * internal/mdtext (Go), over UTF-16 code units.
 *
 * Corpus:
 *   - the CommonMark 0.31.2 and GFM spec examples (mdtext-spec-corpus.json, inputs only);
 *   - every Markdown file and line in docs/ and the repository root;
 *   - real message-block text when --blocks is given (a JSON array of texts, or of
 *     block arrays whose string `text` fields are collected);
 *   - a generated corpus (default 100k): nested emphasis, links, images, code
 *     spans and fences, HTML blocks and tags, lists, tables, entities, escapes,
 *     autolinks, emoji and astral text, lone surrogates, CRLF, very long lines
 *     and the 4,096-unit preview cap.
 *
 * Each case compares plainTextFromMarkdown(markdown, {maxSource}),
 * truncatedPlainText, truncatePlainText(plain), shortenedTextLength and
 * textBoundary. Zero mismatches is the bar.
 *
 * Run (node 24 strips the TypeScript; tsx also works):
 *   PATH=~/.local/opt/go/bin:$PATH node apps/api-go/tools/mdtext-diff.mts \
 *     [--cases 100000] [--blocks /tmp/lane-i/blocks.json] [--work /tmp/lane-i/mdtext-diff]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TextFunctions = {
  plainTextFromMarkdown(markdown: string, options?: { maxSource?: number }): string;
  truncatedPlainText(markdown: string, maxChars: number): string;
  truncatePlainText(text: string, maxChars: number): string;
  textBoundary(text: string, offset: number): number;
  shortenedTextLength(text: string): number;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const GO_DIR = join(HERE, "..");
const DEFAULT_WORK = "/tmp/lane-i/mdtext-diff";
const DEFAULT_CASES = 100_000;

const sourceModule = new URL(
  "../../../packages/core/src/messages/markdown-plain.ts",
  import.meta.url,
).href;
// biome-ignore lint/suspicious/noExplicitAny: the module has no declarations under plain node
const text = (await import(sourceModule)) as TextFunctions;

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1]!;
  const prefix = `${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const WORK = option("--work", DEFAULT_WORK);
const GENERATED = Number(option("--cases", String(DEFAULT_CASES)));
const BLOCKS = option("--blocks", "");
const SEED = Number(option("--seed", "0x9e3779b9"));
const GOLDEN = option("--golden", "");
if (!Number.isFinite(GENERATED) || GENERATED < 0) throw new Error("--cases must be >= 0");
if (!Number.isFinite(SEED)) throw new Error("--seed must be a number");
mkdirSync(WORK, { recursive: true });

type TestCase = { text: string; cap: number; maxChars: number; tag: string };

const cases: TestCase[] = [];
const counts: Record<string, number> = {};

function add(tag: string, value: string, cap: number, maxChars: number): void {
  cases.push({ text: value, cap, maxChars, tag });
  counts[tag] = (counts[tag] ?? 0) + 1;
}

// ---------------------------------------------------------------- real corpora

const spec = JSON.parse(readFileSync(join(HERE, "mdtext-spec-corpus.json"), "utf8")) as {
  commonmark: string[];
  gfm: string[];
};
for (const markdown of spec.commonmark) add("commonmark-spec", markdown, 4096, 64);
for (const markdown of spec.gfm) add("gfm-spec", markdown, 4096, 64);
for (const markdown of [...spec.commonmark, ...spec.gfm].slice(0, 200)) add("spec-capped", markdown, 40, 17);

const markdownFiles: string[] = [];
for (const directory of [REPO, join(REPO, "docs")]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(join(directory, entry.name));
  }
}
for (const path of [...new Set(markdownFiles)]) {
  const content = readFileSync(path, "utf8");
  add("repo-markdown", content, 4096, 80);
  for (const line of content.split("\n")) {
    if (line.length > 0 && line.length <= 512) add("repo-markdown-line", line, 4096, 40);
  }
}

if (BLOCKS !== "") {
  const raw = JSON.parse(readFileSync(BLOCKS, "utf8")) as unknown;
  const rows = Array.isArray(raw) ? raw : [raw];
  for (const row of rows) {
    const blocks = Array.isArray(row) ? row : [row];
    for (const block of blocks) {
      if (block === null || typeof block !== "object") continue;
      if (!("text" in block)) continue;
      const value: unknown = block.text;
      if (typeof value === "string") add("message-block", value, 4096, 120);
    }
  }
}

// ---------------------------------------------------------- generated corpus

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(SEED);
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
const int = (limit: number): number => Math.floor(random() * limit);
const chance = (probability: number): boolean => random() < probability;

const TOKENS = [
  "a", "b", "c", "x", "y", "z", "1", "2", "0", "9", " ", " ", "  ", "\t", "\n", "\n", "\n\n",
  "\r\n", "\r", "|", "||", "-", "--", "---", "----", "___", "***", "*", "**", "***", "_", "__",
  "___", "~", "~~", "~~~", "~~~~", "`", "``", "```", "````", "#", "##", "###", "#######", ">",
  "> ", "- ", "* ", "+ ", "1. ", "1) ", "2. ", "10. ", "[", "]", "(", ")", "![", "](", ")",
  "<", ">", "<div>", "</div>", "<br/>", "<br />", '<a href="x">', "</a>", "<span class='y'>",
  "<x@y.z>", "<a@b.c.d>", "<https://a.b/c>", "<ab:>", "<a:>", "<ab://x.y/z?q=1>", "<a b>",
  "<!--", "-->", "<!-- x -->", "&amp;", "&#x41;", "&nbsp;", "&notanentity;", "\\*", "\\_",
  "\\`", "\\\\", "\\", '"', "'", "=", "@", ".", "/", "?", ":", "&", "%", "{", "}", "$",
  "é", "ü", "ß", "中", "文", "ñ", "Ω", "α", "\u0301", "\u200b", "\u200d", "\u2028", "\u2029",
  "\u00a0", "\u3000", "\ufeff", "\ue000", "\ue0000\ue000", "\ue0012\ue000", "👍", "🧑🏽",
  "👨‍👩‍👧‍👦", "\ud800", "\udc00", "\ud83d", "\ude00", "\ud83d\ude00", "\ud800\ud800",
  "| a | b |", "|---|:--:|", "|:--|--:|", "| a |", "a | b", "1) x", "* * *", "- - -",
  "```js", "```js `x`", "~~~", "~~a~~", "__a__", "_a_", "**a**", "*a*", "**a*", "*a**",
  "[]()", "[a]()", "[a](b)", "![a](b)", "[a](b(c))", "[a\\]](b)", "<https://x.y/a(b)>",
  "mailto:a@b.c", "a@b", "a.@b.c", ".a@b.c.", "x\ty", "\t\t|\ta\t|",
];
const LONG_TOKENS = [...TOKENS, "word ", "lorem ipsum dolor ", "**bold** ", "_under_ ", "`code` ", "|c|"];

function tokenSoup(limit: number, pool: readonly string[] = TOKENS): string {
  const parts: string[] = [];
  const count = int(limit);
  for (let index = 0; index < count; index++) parts.push(pick(pool));
  return parts.join("");
}

function tableSoup(): string {
  const lines: string[] = [];
  const count = 1 + int(8);
  const separators = ["|---|", "|---|---|", "| : |", "|:--|--:|", "--- | ---", "| --- |", "|--|"];
  for (let index = 0; index < count; index++) {
    const header = chance(0.5) ? "| a | b |" : "a | b";
    const body = chance(0.5) ? "| 1 | 2 |" : "1 | 2";
    switch (int(10)) {
      case 0:
        lines.push(`${chance(0.5) ? "" : "> "}${pick(separators)}`);
        break;
      case 1:
        lines.push(`| ${tokenSoup(4)} | ${tokenSoup(4)} |`);
        break;
      case 2:
        lines.push(`${pick(["- ", "> ", "1. ", "### "])}${header}`);
        break;
      case 3:
        lines.push(pick(separators));
        break;
      case 4:
        lines.push(` ${header} `);
        break;
      case 5:
        lines.push(`|${tokenSoup(3)}|${tokenSoup(3)}|${tokenSoup(3)}|`);
        break;
      case 6:
        lines.push(body);
        break;
      case 7:
        lines.push("");
        break;
      case 8:
        lines.push(`| ${tokenSoup(6)} |`);
        break;
      default:
        lines.push(`${header}\n${body}`);
        break;
    }
  }
  return lines.join("\n");
}

function fenceSoup(): string {
  const parts: string[] = [];
  const count = 1 + int(4);
  for (let index = 0; index < count; index++) {
    const character = chance(0.7) ? "`" : "~";
    const length = 3 + int(4);
    const fence = character.repeat(length);
    const info = chance(0.4) ? pick(["js", "ts `x`", "", " python", "\ttitle", "a`b"]) : "";
    parts.push(`${fence}${info}`);
    parts.push(chance(0.5) ? "# not a heading\n**not bold**" : `line ${index} with \`code\``);
    if (chance(0.7)) parts.push(character.repeat(length + int(3)));
    if (chance(0.3)) parts.push(tokenSoup(3));
  }
  return parts.join("\n");
}

function linkSoup(): string {
  const parts: string[] = [];
  const count = 1 + int(10);
  for (let index = 0; index < count; index++) {
    switch (int(9)) {
      case 0:
        parts.push(`[${tokenSoup(3)}](${tokenSoup(2)})`);
        break;
      case 1:
        parts.push(`![${tokenSoup(3)}](${tokenSoup(2)} "${tokenSoup(2)}")`);
        break;
      case 2:
        parts.push(`[${tokenSoup(4)}](${pick(["https://a.b/c", "/x", "#y", "a b", "a(b)c"])})`);
        break;
      case 3:
        parts.push(`[${pick(["a", "a\\]", "a[b", ""])}]${pick(["(", "[", "x"])}`);
        break;
      case 4:
        parts.push(pick(["<https://a.b/c?d=e&f#g>", "<mailto:a@b.c>", "<a@b.c>", "<a@b>", "<a:b>"]));
        break;
      case 5:
        parts.push(`[${tokenSoup(2)}\n${tokenSoup(2)}](x)`);
        break;
      case 6:
        parts.push(pick(["[[a]](b)", "[a](b)[c](d)", "![a](b)c", "![a[b]](c)"]));
        break;
      case 7:
        parts.push(`\\[${tokenSoup(2)}\\](${tokenSoup(2)})`);
        break;
      default:
        parts.push(tokenSoup(4));
        break;
    }
  }
  return parts.join(chance(0.5) ? " " : "\n");
}

function emphasisSoup(): string {
  const parts: string[] = [];
  const count = 1 + int(16);
  for (let index = 0; index < count; index++) {
    const run = pick(["_", "__", "___", "____", "*", "**", "***", "~~", "~"]);
    switch (int(6)) {
      case 0:
        parts.push(`${run}word${run}`);
        break;
      case 1:
        parts.push(`${run}${pick(["1", "é", "中", "👍", "a\u0301", " ", "\u00a0"])}${run}`);
        break;
      case 2:
        parts.push(pick(["a_", "a__b", "_a", "a_1", "1_a", "_ a", "a _", "_en_", "snake_case_"]));
        break;
      case 3:
        parts.push(`${run}\n${run}`);
        break;
      case 4:
        parts.push(tokenSoup(3).replace(/\*/g, "\\*"));
        break;
      default:
        parts.push(`${run}${tokenSoup(5)}${run}`);
        break;
    }
  }
  return parts.join("");
}

function htmlSoup(): string {
  const parts: string[] = [];
  const count = 1 + int(10);
  for (let index = 0; index < count; index++) {
    switch (int(10)) {
      case 0:
        parts.push(`<div class="${tokenSoup(2)}">${tokenSoup(3)}</div>`);
        break;
      case 1:
        parts.push(`<img src="a" alt='${tokenSoup(2)}'>`);
        break;
      case 2:
        parts.push("<!-- comment -->");
        break;
      case 3:
        parts.push("<!-- unclosed");
        break;
      case 4:
        parts.push(`<${tokenSoup(2)} ${pick(["a", "a=1", "a='b>c'", 'a="b>c"', "1", "a=b"])}>`);
        break;
      case 5:
        parts.push(pick(["a<b+1", "y && z", "<3", "<x>", "</x>", "<x/>", "<x />", "<x\ny>"]));
        break;
      case 6:
        parts.push(`<a href="unterminated>${tokenSoup(3)}`);
        break;
      case 7:
        parts.push("<!DOCTYPE html>");
        break;
      case 8:
        parts.push(`<x ${pick(["a", "a b", "a=b c", "a-b", "a_b", "a@b", "a:b"])}>`);
        break;
      default:
        parts.push(tokenSoup(5));
        break;
    }
  }
  return parts.join("");
}

function longLine(): string {
  const parts: string[] = [];
  let size = 0;
  const target = 1_700 + int(12_000);
  while (size < target) {
    const token = pick(LONG_TOKENS);
    parts.push(token);
    size += token.length;
  }
  return parts.join("");
}

function padded(): string {
  const pad = pick([" ", "\n", "\t", "\u00a0"]);
  const count = 4_000 + int(200);
  return `${pad.repeat(count)}${tokenSoup(40)}`;
}

function surrogateSoup(): string {
  const parts: string[] = [];
  const count = 1 + int(12);
  for (let index = 0; index < count; index++) {
    parts.push(pick([
      "\ud800", "\udc00", "\udfff", "\ud83d", "\ude00", "\ud83d\ude00", "\ud800a",
      "a\udc00", "\ud800\ud800", "\udc00\udc00", "👍", "🧑🏽", "\ud800_\udc00", "_\ud800_",
    ]));
  }
  return parts.join("");
}

function mutate(value: string): string {
  for (let round = 0; round < 1 + int(3); round++) {
    switch (int(7)) {
      case 0: {
        const from = int(value.length + 1);
        const to = from + int(40);
        value = value.slice(0, from) + value.slice(to);
        break;
      }
      case 1: {
        const from = int(value.length + 1);
        const to = from + int(40);
        value = value.slice(0, to) + value.slice(from, to) + value.slice(to);
        break;
      }
      case 2: {
        const at = int(value.length + 1);
        value = value.slice(0, at) + pick(TOKENS) + value.slice(at);
        break;
      }
      case 3:
        value = value.replace(/\n/g, "\r\n");
        break;
      case 4:
        value = value.slice(0, int(value.length + 1));
        break;
      case 5: {
        const at = int(value.length + 1);
        value = `${value.slice(0, at)}${String.fromCharCode(int(0x10000))}${value.slice(at)}`;
        break;
      }
      default:
        value = value.repeat(1 + int(3));
        break;
    }
  }
  return value;
}

function generatedCase(): TestCase {
  const roll = random();
  let value: string;
  let tag: string;
  if (roll < 0.34) {
    value = tokenSoup(80);
    tag = "fuzz-tokens";
  } else if (roll < 0.45) {
    value = tableSoup();
    tag = "fuzz-table";
  } else if (roll < 0.53) {
    value = fenceSoup();
    tag = "fuzz-fence";
  } else if (roll < 0.61) {
    value = linkSoup();
    tag = "fuzz-link";
  } else if (roll < 0.69) {
    value = emphasisSoup();
    tag = "fuzz-emphasis";
  } else if (roll < 0.77) {
    value = htmlSoup();
    tag = "fuzz-html";
  } else if (roll < 0.83) {
    value = longLine();
    tag = "fuzz-long";
  } else if (roll < 0.88) {
    value = padded();
    tag = "fuzz-pad";
  } else if (roll < 0.93) {
    value = surrogateSoup();
    tag = "fuzz-surrogate";
  } else {
    value = [tableSoup(), fenceSoup(), linkSoup(), emphasisSoup(), htmlSoup()][int(5)]!;
    tag = "fuzz-mixed";
  }
  if (chance(0.4)) value = mutate(value);
  // Negative lengths are not reachable from the API, but truncatePlainText takes them and JS
  // slice(0, -n) keeps a prefix, so the port must match it too.
  const capChoices = [4096, 4096, 4096, 4096, 0, 1, 2, 3, 5, 16, 64, 100, 4095, 4097, 20000, -1, -3, -8];
  return {
    text: value,
    cap: pick(capChoices),
    maxChars: pick([0, 1, 2, 3, 5, 8, 16, 32, 64, 100, 1000, -1, -2, -5, -40]),
    tag,
  };
}

for (let index = 0; index < GENERATED; index++) {
  const item = generatedCase();
  add(item.tag, item.text, item.cap, item.maxChars);
}

// Every token alone, and every ordered pair with each joiner: the interaction of
// two constructs is where a hand-rolled precedence chain breaks.
const JOINERS = ["", " ", "\n", "\r\n"];
for (const token of TOKENS) add("pair-single", token, 4096, 8);
for (const left of TOKENS) {
  for (const right of TOKENS) {
    const joiner = pick(JOINERS);
    add("pair", `${left}${joiner}${right}`, 4096, 6);
  }
}

// Source-cap and truncation boundaries: every cut of every spec example around
// its own length, plus small caps over a sample.
const specInputs = [...spec.commonmark, ...spec.gfm];
for (const markdown of specInputs) {
  const length = markdown.length;
  for (const cap of [0, 1, 2, 3, 5, 8, Math.max(0, length - 2), Math.max(0, length - 1), length]) {
    add("spec-cap", markdown, cap, 5);
  }
}
for (const markdown of specInputs.slice(0, 300)) {
  for (const maxChars of [0, 1, 2, 3, 4, 7, 15, 31]) {
    add("spec-truncate", markdown, 4096, maxChars);
  }
}

// ------------------------------------------------------------------- run both

const corpusPath = join(WORK, "corpus.bin");
const resultPath = join(WORK, "result.bin");
let size = 0;
for (const item of cases) size += 12 + item.text.length * 2;
const corpus = Buffer.allocUnsafe(size);
let offset = 0;
for (const item of cases) {
  corpus.writeInt32LE(item.cap, offset);
  corpus.writeInt32LE(item.maxChars, offset + 4);
  corpus.writeUInt32LE(item.text.length, offset + 8);
  offset += 12;
  for (let index = 0; index < item.text.length; index++) {
    corpus.writeUInt16LE(item.text.charCodeAt(index), offset);
    offset += 2;
  }
}
writeFileSync(corpusPath, corpus);

const driver = join(WORK, "mdtext-diff-go");
const build = spawnSync("go", ["build", "-o", driver, "./tools/mdtextdiff"], {
  cwd: GO_DIR,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error(`go build failed (${build.status ?? build.error})`);
const run = spawnSync(driver, ["-in", corpusPath, "-out", resultPath], { stdio: "inherit" });
if (run.status !== 0) throw new Error(`mdtext-diff-go failed (${run.status ?? run.error})`);
const results = readFileSync(resultPath);

// ---------------------------------------------------------------- comparison

function describe(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code >= 0x20 && code < 0x7f) out += value[index];
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

function windowOf(expected: string, actual: string): [string, string] {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++;
  const from = Math.max(0, index - 60);
  const to = index + 60;
  return [describe(expected.slice(from, to)), describe(actual.slice(from, to))];
}

type Mismatch = {
  index: number;
  tag: string;
  field: string;
  cap: number;
  maxChars: number;
  input: string;
  expected: string;
  actual: string;
};

const mismatches: Mismatch[] = [];
const fields = ["plainText", "truncatedPlainText", "truncatePlainText", "shortenedTextLength", "textBoundary"];
let resultOffset = 0;
const readUint32 = (): number => {
  const value = results.readUInt32LE(resultOffset);
  resultOffset += 4;
  return value;
};
const readInt32 = (): number => {
  const value = results.readInt32LE(resultOffset);
  resultOffset += 4;
  return value;
};
const readUnits = (): string => {
  const length = readUint32();
  let value = "";
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(results.readUInt16LE(resultOffset));
    resultOffset += 2;
  }
  return value;
};

for (let index = 0; index < cases.length; index++) {
  const item = cases[index]!;
  const plain = text.plainTextFromMarkdown(item.text, { maxSource: item.cap });
  const expected: Array<[string, string | number]> = [
    ["plainText", plain],
    ["truncatedPlainText", text.truncatedPlainText(item.text, item.maxChars)],
    ["truncatePlainText", text.truncatePlainText(plain, item.maxChars)],
    ["shortenedTextLength", text.shortenedTextLength(plain)],
    ["textBoundary", text.textBoundary(plain, item.maxChars)],
  ];
  const actual: Array<[string, string | number]> = [
    ["plainText", readUnits()],
    ["truncatedPlainText", readUnits()],
    ["truncatePlainText", readUnits()],
    ["shortenedTextLength", readInt32()],
    ["textBoundary", readInt32()],
  ];
  for (let field = 0; field < fields.length; field++) {
    const [fieldName, want] = expected[field]!;
    const [, got] = actual[field]!;
    if (want === got) continue;
    const [expectedWindow, actualWindow] =
      typeof want === "number" || typeof got === "number"
        ? [String(want), String(got)]
        : windowOf(want, got);
    mismatches.push({
      index,
      tag: item.tag,
      field: fieldName,
      cap: item.cap,
      maxChars: item.maxChars,
      input: describe(item.text.slice(0, 400)),
      expected: expectedWindow,
      actual: actualWindow,
    });
  }
}
if (resultOffset !== results.length) {
  throw new Error(`result read ${resultOffset} of ${results.length} bytes`);
}

if (GOLDEN !== "") {
  // A compact regression fixture for the Go unit test: code units survive the
  // round trip as base64 of UTF-16LE, so lone surrogates stay exact.
  const quotas: Record<string, number> = {
    "commonmark-spec": 40,
    "gfm-spec": 40,
    "message-block": 20,
    "repo-markdown": 10,
    "fuzz-tokens": 12,
    "fuzz-table": 12,
    "fuzz-fence": 12,
    "fuzz-link": 12,
    "fuzz-emphasis": 12,
    "fuzz-html": 12,
    "fuzz-long": 6,
    "fuzz-pad": 6,
    "fuzz-surrogate": 12,
    "fuzz-mixed": 12,
    pair: 20,
    "spec-cap": 25,
    "spec-truncate": 10,
  };
  // Keep the fixture small: a long example adds little beyond one already pinned,
  // and the harness itself always runs the full corpus.
  const MAX_UNITS = 400;
  const selected: TestCase[] = [];
  const taken: Record<string, number> = {};
  for (const tag of Object.keys(quotas)) {
    const members = cases.filter((item) => item.tag === tag && item.text.length <= MAX_UNITS);
    const quota = quotas[tag] ?? 0;
    if (members.length <= quota) {
      selected.push(...members);
      continue;
    }
    const step = members.length / quota;
    for (let index = 0; index < quota; index++) {
      selected.push(members[Math.floor(index * step)]!);
    }
    taken[tag] = quota;
  }
  // A few pinned negative-length cases: the cut may split a surrogate pair, as slice(0, -n) does.
  for (const value of ["ab😀cd𝕏ef", "😀😀", "a👍b", "x\n\ny", ""]) {
    for (const length of [-1, -2, -3, -7]) {
      selected.push({ text: value, cap: length, maxChars: length, tag: "negative-length" });
    }
  }
  const unitsBase64 = (value: string): string => {
    const buffer = Buffer.allocUnsafe(value.length * 2);
    for (let index = 0; index < value.length; index++) buffer.writeUInt16LE(value.charCodeAt(index), index * 2);
    return buffer.toString("base64");
  };
  const golden = selected.map((item) => {
    const plain = text.plainTextFromMarkdown(item.text, { maxSource: item.cap });
    const record: Record<string, string | number> = {
      i: unitsBase64(item.text),
      c: item.cap,
      m: item.maxChars,
      o: unitsBase64(plain),
      s: text.shortenedTextLength(plain),
      b: text.textBoundary(plain, item.maxChars),
    };
    if (item.cap !== 4096) record.t = unitsBase64(text.truncatedPlainText(item.text, item.maxChars));
    return record;
  });
  writeFileSync(GOLDEN, JSON.stringify(golden));
  console.log(`mdtext-diff: wrote ${golden.length} golden cases (${taken ? JSON.stringify(taken) : ""})`);
}

const byTag: Record<string, number> = {};
for (const item of cases) byTag[item.tag] = (byTag[item.tag] ?? 0) + 1;
const perField: Record<string, number> = {};
for (const mismatch of mismatches) perField[mismatch.field] = (perField[mismatch.field] ?? 0) + 1;

console.log(`mdtext-diff: ${cases.length} cases, ${cases.length * fields.length} comparisons`);
console.log(`  cases by tag: ${JSON.stringify(byTag)}`);
if (mismatches.length > 0) {
  console.log(`  mismatches by field: ${JSON.stringify(perField)}`);
  for (const mismatch of mismatches.slice(0, 20)) {
    console.log(`  #${mismatch.index} ${mismatch.tag} ${mismatch.field} (cap=${mismatch.cap} maxChars=${mismatch.maxChars})`);
    console.log(`    input:    ${mismatch.input}`);
    console.log(`    expected: ${mismatch.expected}`);
    console.log(`    actual:   ${mismatch.actual}`);
  }
  writeFileSync(join(WORK, "mismatches.json"), JSON.stringify(mismatches, null, 2));
  console.log(`mdtext-diff: ${mismatches.length} MISMATCHES (${join(WORK, "mismatches.json")})`);
  process.exitCode = 1;
} else {
  console.log("mdtext-diff: 0 mismatches");
}
