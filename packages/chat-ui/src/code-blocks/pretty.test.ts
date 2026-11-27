import { describe, expect, it } from "vitest";
import { prettyCode } from "./pretty";

const row = (key: string) =>
  `{ key: "${key}", location: "/home/rakazo (my container)", use: "Edits, tests, shellcheck/ruff, diff reads", state: "ready; clones at wake232, wake239, wake241, w246r, t350", limit: "no bun/node build" }`;

describe("a line reprinted for reading", () => {
  it("breaks a long declaration one property per line, keeping every value as written", () => {
    const source = `const data = [${row("1")}, ${row("2")}];`;
    const pretty = prettyCode(source);
    const lines = pretty.split("\n");
    expect(lines[0]).toBe("const data = [");
    expect(lines[1]).toBe("  {");
    expect(lines[2]).toBe(`    key: "1",`);
    expect(lines[3]).toBe(`    location: "/home/rakazo (my container)",`);
    expect(lines.at(-2)).toBe("  }");
    expect(lines.at(-1)).toBe("];");
    // Only whitespace was added: the values are the ones the author wrote.
    expect(pretty.replace(/\s+/g, "")).toBe(source.replace(/\s+/g, ""));
  });

  it("breaks a nested value that is itself too wide, each level indented", () => {
    const source = `const data = [{ rows: [${row("1")}, ${row("2")}], note: "a note long enough to keep the object on one line otherwise this would fit" }];`;
    const pretty = prettyCode(source);
    expect(pretty.split("\n").length).toBeGreaterThan(6);
    expect(pretty).toContain('\n        key: "1",');
    expect(pretty).toContain("\n    rows: [");
    expect(pretty.replace(/\s+/g, "")).toBe(source.replace(/\s+/g, ""));
  });

  it("keeps a line that already fits, and a short one", () => {
    for (const line of ["const data = [{ a: 1 }, { a: 2 }];", "const x = 1;", "plain words"]) {
      expect(prettyCode(line)).toBe(line);
    }
  });

  it("leaves a line it does not fully understand exactly as it arrived", () => {
    const opaque = [
      `const columns = [{ title: "Where", dataIndex: "location", render: (v) => <Tag>{v}</Tag> }, { title: "Limit", dataIndex: "limit", render: (v) => <Tag>{v}</Tag> }];`,
      `const value = compute(${"1".repeat(140)});`,
      `const text = "${"a".repeat(140)}" + suffix;`,
      `const broken = [{ a: 1 }, { b: 2 }`,
      `Some very long prose sentence that goes on and on and on and on and on and on and on and on and on about nothing at all.`,
    ];
    for (const line of opaque) expect(prettyCode(line)).toBe(line);
  });

  it("keeps quotes, escapes and trailing commas as they were", () => {
    const source = `const config = [{ note: 'it\\'s fine', path: "a\\\\b", ok: true, nothing: null, list: [1, 2, 3], }, { note: "it's fine", path: 'a\\\\b', ok: false, nothing: null, list: [4, 5, 6] },];`;
    const pretty = prettyCode(source);
    expect(pretty).toContain(`note: 'it\\'s fine'`);
    expect(pretty).toContain(`path: "a\\\\b"`);
    expect(pretty).toContain("ok: true");
    expect(pretty).toContain("nothing: null");
    expect(pretty.replace(/\s+/g, "")).toBe(source.replace(/\s+/g, ""));
  });

  it("reprints one long line among others and leaves the rest of the block alone", () => {
    const source = [
      "const columns = [{ title: 'A', dataIndex: 'a' }];",
      `const data = [${row("1")}];`,
      "ReactDOM.render(<Table />);",
    ].join("\n");
    const pretty = prettyCode(source);
    const lines = pretty.split("\n");
    expect(lines[0]).toBe("const columns = [{ title: 'A', dataIndex: 'a' }];");
    expect(lines[1]).toBe("const data = [");
    expect(pretty.endsWith("ReactDOM.render(<Table />);")).toBe(true);
  });
});
