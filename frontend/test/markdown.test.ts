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

test("an unclosed fence runs to the end and is marked open", () => {
  const [block] = parseMarkdown("```\nstill typing");
  assert.deepEqual(block, { t: "code", lang: "", v: "still typing", open: true });
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
  assert.equal(list.items[0].body[1].t, "list");
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

test("markdown tables parse headers, alignments, and rows", () => {
  const src = [
    "| Dimension | Zig | Rust |",
    "| :--- | :---: | ---: |",
    "| Memory model | Manual | Ownership |",
    "| Compile speed | Fast | Slow |",
  ].join("\n");

  const blocks = parseMarkdown(src);
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.t, "table");
  if (table.t === "table") {
    assert.deepEqual(table.align, ["left", "center", "right"]);
    assert.equal(table.headers.length, 3);
    assert.deepEqual(table.headers[0], [{ t: "text", v: "Dimension" }]);
    assert.deepEqual(table.headers[1], [{ t: "text", v: "Zig" }]);
    assert.deepEqual(table.headers[2], [{ t: "text", v: "Rust" }]);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[0][0], [{ t: "text", v: "Memory model" }]);
    assert.deepEqual(table.rows[0][1], [{ t: "text", v: "Manual" }]);
    assert.deepEqual(table.rows[0][2], [{ t: "text", v: "Ownership" }]);
  }
});

test("markdown tables support inline formatting and escaped pipes", () => {
  const src = [
    "| Feature | Status |",
    "| --- | --- |",
    "| `code` | **bold** |",
    "| pipe \\| test | [link](https://example.com) |",
  ].join("\n");

  const blocks = parseMarkdown(src);
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.t, "table");
  if (table.t === "table") {
    assert.deepEqual(table.rows[0][0], [{ t: "code", v: "code" }]);
    assert.deepEqual(table.rows[0][1], [{ t: "strong", v: [{ t: "text", v: "bold" }] }]);
    assert.deepEqual(table.rows[1][0], [{ t: "text", v: "pipe | test" }]);
    assert.deepEqual(table.rows[1][1], [{ t: "link", href: "https://example.com", v: [{ t: "text", v: "link" }] }]);
  }
});

test("tables directly following paragraph or list items break cleanly", () => {
  const src = [
    "1. Core Philosophy",
    "| Dimension | Zig | Rust |",
    "|---|---|---|",
    "| Primary goal | C replacement | Memory safety |",
  ].join("\n");

  const blocks = parseMarkdown(src);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].t, "list");
  assert.equal(blocks[1].t, "table");
});

test("streaming table with only header and delimiter is valid", () => {
  const src = "| Col A | Col B |\n| --- | --- |";
  const blocks = parseMarkdown(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].t, "table");
  if (blocks[0].t === "table") {
    assert.equal(blocks[0].rows.length, 0);
  }
});

test("isolated horizontal rule is not a table", () => {
  const src = "Heading\n\n---\n\nParagraph";
  const blocks = parseMarkdown(src);
  assert.deepEqual(types(src), ["paragraph", "hr", "paragraph"]);
});

test("task list items parse checked state", () => {
  const src = "- [ ] First pending\n- [x] Second done\n- [X] Third done\n- Plain bullet";
  const [list] = parseMarkdown(src);
  assert.equal(list.t, "list");
  if (list.t === "list") {
    assert.equal(list.items[0].checked, false);
    assert.equal(list.items[1].checked, true);
    assert.equal(list.items[2].checked, true);
    assert.equal(list.items[3].checked, null);
  }
});

test("github alerts parse kind, title, and body", () => {
  const src = "> [!NOTE] Custom Note\n> Important information";
  const [alert] = parseMarkdown(src);
  assert.equal(alert.t, "alert");
  if (alert.t === "alert") {
    assert.equal(alert.kind, "note");
    assert.equal(alert.title, "Custom Note");
    assert.equal(alert.v.length, 1);
  }
});

test("math blocks and inline math formulas parse correctly", () => {
  const src = "$$E=mc^2$$\n\nInline $a^2 + b^2 = c^2$ formula with price $10.50 intact.";
  const blocks = parseMarkdown(src);
  assert.equal(blocks[0].t, "math");
  if (blocks[0].t === "math") {
    assert.equal(blocks[0].v, "E=mc^2");
  }
  assert.equal(blocks[1].t, "paragraph");
  if (blocks[1].t === "paragraph") {
    const mathNodes = blocks[1].v.filter((n) => n.t === "math");
    assert.equal(mathNodes.length, 1);
    assert.equal(mathNodes[0].v, "a^2 + b^2 = c^2");
  }
});

test("think and details blocks parse inner content", () => {
  const src = "<think>\nThinking step by step\n</think>\n\n<details>\n<summary>More info</summary>\nDetailed content\n</details>";
  const blocks = parseMarkdown(src);
  assert.equal(blocks[0].t, "think");
  assert.equal(blocks[1].t, "details");
  if (blocks[1].t === "details") {
    assert.equal(blocks[1].summary, "More info");
  }
});
