import assert from "node:assert/strict";
import { test } from "node:test";
import { hasAsciiArrow, horizontalAsciiArrows, asciiToGraph } from "../src/diagrams/asciiGraph.ts";

test("arrow scanner preserves directions, shafts and string offsets", () => {
  const text = "😀 -> <-- <=> ──> ← ↔";
  const tokens = horizontalAsciiArrows(text);
  assert.deepEqual(tokens.map((token) => token.text), ["->", "<--", "<=>", "──>", "←", "↔"]);
  assert.equal(tokens[0].index, 3);
  for (const token of tokens) assert.equal(text.slice(token.index, token.index + token.text.length), token.text);
  assert.ok(asciiToGraph("😀 -> API -> DB"));
});

test("arrow detection handles vertical heads and leaves malformed punctuation as source", () => {
  for (const arrow of ["->", "-->", "=>", "<--", "<->", "→", "←", "↔", "↑", "↓", "↕"]) assert.ok(hasAsciiArrow(arrow), arrow);
  for (const text of ["plain text", "--!>", "-", "<", ">"]) assert.equal(hasAsciiArrow(text), false, text);
  assert.equal(asciiToGraph("[A] --!> [B]"), null);
  assert.equal(asciiToGraph("<!-- text -->"), null);
});
