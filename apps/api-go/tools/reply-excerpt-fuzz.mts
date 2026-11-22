/**
 * Differential corpus for the Go reply preview (internal/procedures/threads/reply.go).
 *
 * threads.get answers a reply to a bot's text only when plainMarkdownText says the Markdown renderer
 * (message-quote.ts visibleTextFromMarkdown: remark + GFM + hast-util-to-text) would hand the text
 * back unchanged. This script writes strings and what the real messageReplyPreview makes of them;
 * the Go test replays every line plainMarkdownText accepts and requires the same preview text.
 *
 *   node_modules/.bin/tsx apps/api-go/tools/reply-excerpt-fuzz.mts [count]
 *
 * The generator is seeded, so a rerun writes the same corpus. A bigger count (CORPUS=20000, say)
 * rewrites the file for a one-off wider run; commit only the default size.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { messageReplyPreview } from "../../../packages/core/src/messages/message-quote.js";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "../internal/procedures/threads/testdata/reply-excerpt-fuzz.jsonl");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual tool
const scale = Number(process.argv[2] ?? process.env.CORPUS ?? 1);

let state = 0x9e3779b9;
function random() {
  // xorshift32
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 0x100000000;
}
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

const LETTERS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const UNICODE_LETTERS = [..."éüñßøåçÅÉÜΩλжюя日本語한국어"];
const DIGITS = [..."0123456789"];
const ALLOWED_PUNCT = [..."  ,.?'\";%$@/-^={}"];
const ALL_ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));
const ODD = [
  "\n",
  "\r\n",
  "\t",
  "\u00a0",
  "\u2028",
  "😀",
  "\u0301",
  "\u200b",
  "  ",
  "\\",
  "&amp;",
  "&#35;",
];
const WORDS = [
  "Sure",
  "the",
  "report",
  "is",
  "ready",
  "3.5",
  "www.example.com",
  "a@b.co",
  "v2",
  "OK",
  "2024-01-05",
];

const allowedChar = () => {
  const roll = random();
  if (roll < 0.55) return pick(LETTERS);
  if (roll < 0.62) return pick(UNICODE_LETTERS);
  if (roll < 0.75) return pick(DIGITS);
  return pick(ALLOWED_PUNCT);
};
const allowedString = () => {
  const length = between(1, 40);
  let out = "";
  for (let index = 0; index < length; index += 1) out += allowedChar();
  return out;
};
const sentence = () => Array.from({ length: between(1, 12) }, () => pick(WORDS)).join(" ");

const corpus: string[] = [];
const target = (count: number) => Math.round(count * scale);
for (let index = 0; index < target(2500); index += 1) corpus.push(allowedString());
for (let index = 0; index < target(1200); index += 1) corpus.push(sentence());
for (let index = 0; index < target(1500); index += 1) {
  const base = allowedString();
  const at = between(0, base.length);
  corpus.push(base.slice(0, at) + pick([...ALL_ASCII, ...ODD]) + base.slice(at));
}
for (let index = 0; index < target(1500); index += 1) {
  const length = between(1, 30);
  corpus.push(Array.from({ length }, () => pick(ALL_ASCII)).join(""));
}
corpus.push(
  "",
  " ",
  "1. item",
  "1.5 apples",
  "12.",
  "12",
  "- x",
  "+ x",
  "# title",
  "title #1",
  "a  b",
  "a b ",
  " a b",
  "www.example.com/path?x=1.",
  "first line\nsecond",
  "a\\*b",
  "snake_case_name",
  "a | b",
  "a ~ b",
  "x = y",
  "100% sure",
  "it's fine",
  'say "hi"',
  "{curly} and ^caret",
  "a/b/c",
  "tel: 555",
  "x".repeat(300),
  `${"y".repeat(279)}😀tail`,
  "日本語のテキスト",
);

const lines = [...new Set(corpus)].map((text) => {
  const preview = messageReplyPreview([{ kind: "text", text }], "bot");
  return JSON.stringify({ text, preview: preview.text });
});
writeFileSync(output, `${lines.join("\n")}\n`);
console.log(`wrote ${lines.length} cases to ${output}`);
