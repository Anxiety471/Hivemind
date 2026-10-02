// Run with: node --experimental-strip-types --test test/markdown.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown } from "../src/markdownParse.ts";

const types = (src: string) => parseMarkdown(src).map((b) => b.t);

test("indented code preserves indentation, blank lines and literal markdown", () => {
  assert.deepEqual(parseMarkdown("    if ready:\n        run()  \n\n\n    # literal\n\nafter"), [
    { t: "code", lang: "", v: "if ready:\n    run()  \n\n\n# literal" },
    { t: "paragraph", v: [{ t: "text", v: "after" }] },
  ]);
  assert.deepEqual(parseMarkdown("\tprint(1)\n\t\tprint(2)"), [
    { t: "code", lang: "", v: "print(1)\n\tprint(2)" },
  ]);
  assert.equal(parseMarkdown("paragraph\n    continuation")[0].t, "paragraph");
});

test("paragraphs retain both Markdown hard-break forms", () => {
  for (const src of ["first line  \nsecond line", "first line\\\nsecond line"]) {
    assert.deepEqual(parseMarkdown(src), [
      { t: "paragraph", v: [{ t: "text", v: "first line" }, { t: "br" }, { t: "text", v: "second line" }] },
    ]);
  }
});

test("plain text stays one readable paragraph per blank-line group", () => {
  assert.deepEqual(parseMarkdown("just words\nmore words\n\nsecond"), [
    { t: "paragraph", v: [{ t: "text", v: "just words\nmore words" }] },
    { t: "paragraph", v: [{ t: "text", v: "second" }] },
  ]);
});

test("headings, lists, code blocks, quotes and rules are recognised", () => {
  const src = "# Title\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---";
  assert.deepEqual(types(src), ["heading", "list", "list", "code", "quote", "hr"]);
});

test("code fences keep their content verbatim, including markdown and blank lines", () => {
  const [block] = parseMarkdown("```md\n# not a heading\n\n- not a list\n```");
  assert.deepEqual(block, { t: "code", lang: "md", v: "# not a heading\n\n- not a list" });
});

test("an unclosed fence runs to the end", () => {
  const [block] = parseMarkdown("```\nstill typing");
  assert.deepEqual(block, { t: "code", lang: "", v: "still typing" });
});

test("a longer fence is not closed by a shorter one", () => {
  const [block] = parseMarkdown("````\n```\ninner\n```\n````");
  assert.deepEqual(block, { t: "code", lang: "", v: "```\ninner\n```" });
});

test("lists nest by indentation and keep their start number", () => {
  const [list] = parseMarkdown("3. first\n   - child\n4. second");
  assert.equal(list.t, "list");
  if (list.t !== "list") return;
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0][1].t, "list");
});

test("inline markers", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` ~~e~~"), [
    { t: "text", v: "a " },
    { t: "strong", v: [{ t: "text", v: "b" }] },
    { t: "text", v: " " },
    { t: "em", v: [{ t: "text", v: "c" }] },
    { t: "text", v: " " },
    { t: "code", v: "d" },
    { t: "text", v: " " },
    { t: "del", v: [{ t: "text", v: "e" }] },
  ]);
});

test("snake_case, unmatched markers and math-like stars stay literal", () => {
  assert.deepEqual(parseInline("my_var_name and 2 * 3 * 4 and **open"), [
    { t: "text", v: "my_var_name and 2 * 3 * 4 and **open" },
  ]);
});

test("only http(s) and mailto links become links", () => {
  const nodes = parseInline("[ok](https://example.com) [bad](javascript:alert(1))");
  assert.deepEqual(nodes[0], { t: "link", href: "https://example.com", v: [{ t: "text", v: "ok" }] });
  assert.ok(nodes.slice(1).every((n) => n.t === "text"), "the javascript: link is not a link");
});

test("bare URLs link without swallowing trailing punctuation", () => {
  const nodes = parseInline("see https://example.com/a, ok");
  assert.deepEqual(nodes[1], { t: "link", href: "https://example.com/a", v: [{ t: "text", v: "https://example.com/a" }] });
});

test("html is never interpreted: it stays text", () => {
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ t: "text", v: "<img src=x onerror=alert(1)>" }]);
});

test("CRLF input parses the same as LF", () => {
  assert.deepEqual(parseMarkdown("# T\r\n\r\n- a\r\n- b"), parseMarkdown("# T\n\n- a\n- b"));
});
