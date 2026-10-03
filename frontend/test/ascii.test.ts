import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiFrames } from "../src/diagrams/ascii.ts";

test("static agent art preserves spaces, boxes and separator-like text", () => {
  const art = "  +---+\n  | A | --> B\n  +---+\n---frame---\n";
  assert.deepEqual(asciiFrames(art, false), [art]);
});

test("animation only splits explicit frame boundaries and preserves indentation", () => {
  assert.deepEqual(asciiFrames("  o\r\n---frame---\r\n    o", true), ["  o", "    o"]);
  assert.deepEqual(asciiFrames("a\n---\nb", true), ["a\n---\nb"]);
});

test("oversized animations fall back to complete original source", () => {
  const art = Array(122).fill("o").join("\n---frame---\n");
  assert.deepEqual(asciiFrames(art, true), [art]);
  const big = " ".repeat(100001);
  assert.deepEqual(asciiFrames(big, true), [big]);
});
