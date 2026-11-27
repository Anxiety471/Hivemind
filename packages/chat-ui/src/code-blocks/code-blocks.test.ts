import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { codeBlockMarkdown } from "./code-blocks";
import { CODE_BLOCK_SAMPLE, CODE_BLOCK_SAMPLE_CODE } from "./code-blocks.test-support";

const SAMPLE_BLOCK = `\`\`\`jsx\n${CODE_BLOCK_SAMPLE_CODE}\n\`\`\``;

describe("code a bot wrote without a fence", () => {
  it("puts the sample's declarations and render call in one jsx block", () => {
    expect(codeBlockMarkdown(CODE_BLOCK_SAMPLE)).toBe(
      `Here is where everything runs:\n\n${SAMPLE_BLOCK}\n`,
    );
  });

  it("keeps every character of the JSX it read", () => {
    const result = codeBlockMarkdown(CODE_BLOCK_SAMPLE);
    expect(result).toContain("render: (v) => <Tag>{v}</Tag>");
    expect(result).toContain("ReactDOM.render(<Table columns={columns} dataSource={data} />");
  });

  it("reads a one-line sample as a block too", () => {
    const oneLine =
      'const data = [{ city: "Rome" }]; const columns = [{ title: "City", dataIndex: "city" }]; ReactDOM.render(<Table columns={columns} dataSource={data} />, mountNode);';
    expect(codeBlockMarkdown(oneLine)).toBe(`\`\`\`jsx\n${oneLine}\n\`\`\`\n`);
  });

  it("reads two runs separated by prose as two blocks", () => {
    const message = 'Run this:\n\nconst a = [1, 2];\n\nThen this:\n\nconsole.log("done");\n';
    const result = codeBlockMarkdown(message);
    expect(result.match(/^```js$/gm)).toHaveLength(2);
    expect(result).toContain("Run this:");
    expect(result).toContain("Then this:");
    expect(result).toContain('console.log("done");');
  });

  it("keeps a run's own indentation and drops the shared margin", () => {
    const message = "  const port = 8787;\n  const host = 'localhost';";
    expect(codeBlockMarkdown(message)).toBe(
      "```js\nconst port = 8787;\nconst host = 'localhost';\n```\n",
    );
  });

  it("stays a block while a streamed run is still arriving", () => {
    const partial = "const data = [\n  { key: 1 },\n";
    expect(codeBlockMarkdown(partial)).toBe("```js\nconst data = [\n  { key: 1 },\n```\n");
  });

  it.each([
    ["def greet(name):\n    return f'hi {name}'", "python"],
    ["$ pnpm install\n$ pnpm build", "bash"],
    ["interface TableProps {\n  columns: string[];\n}", "ts"],
    ['{"city": "Rome", "code": "IT"}', "json"],
    ['import type { ReactNode } from "react";\nconst node: ReactNode = null;', "ts"],
    ["const view = <Table columns={[]} />;", "jsx"],
    ['const App = () => <div className="app" />;', "jsx"],
    ['const item: ReactNode = <div className="app" />;', "tsx"],
  ])("labels %#", (code, language) => {
    expect(codeBlockMarkdown(code)).toBe(`\`\`\`${language}\n${code}\n\`\`\`\n`);
  });
});

describe("text a code reader must not touch", () => {
  it.each([
    ["Plain words about nothing in particular."],
    ["Return the book to Sam."],
    ["The word const is a keyword, and `const` is how you write it."],
    ["Use (parentheses) sparingly, and [brackets] too."],
    ["- a list item\n- another item"],
    ["1. first\n2. second"],
    ["# Heading\n\nA paragraph."],
    ["> A quote\n\nA paragraph."],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["```bash\n$ pnpm install\n```"],
    ["```jsx\nconst view = <Table columns={[]} />;\n```\n\nAfter the fence."],
    ["A sentence with `const total = 2;` inline."],
    ["```\nnot closed yet"],
    [""],
    ["If (you want) we can (meet) tomorrow, since the room is free and the door is open."],
    ["e.g. Example.com. See the notes in the folder for details about the setup."],
  ])("leaves %j as it was", (text) => {
    expect(codeBlockMarkdown(text)).toBe(text);
  });

  it("leaves a run whose brackets never close in the middle of a message", () => {
    const message = "const broken = [1, 2;\n\nAnd then prose follows.";
    expect(codeBlockMarkdown(message)).toBe(message);
  });

  it("keeps a comment with the code it introduces", () => {
    const message = "// the port the server listens on\nconst port = 8787;";
    expect(codeBlockMarkdown(message)).toBe(`\`\`\`js\n${message}\n\`\`\`\n`);
  });

  it("leaves prose that happens to open a bracket", () => {
    const message = "See the notes (below\n\nfor the rest.";
    expect(codeBlockMarkdown(message)).toBe(message);
  });
});

describe("reading a whole reply stays linear", () => {
  it("reads a long reply of prose and declarations in one pass", () => {
    const prose = Array.from(
      { length: 4_000 },
      (_, index) => `Paragraph number ${index} is just words.`,
    );
    const declarations = Array.from(
      { length: 2_000 },
      (_, index) => `const value${index} = compute(${index});`,
    );
    const message = [...prose, "", ...declarations, "", ...prose].join("\n");
    expectLinearTime(() => {
      const result = codeBlockMarkdown(message);
      expect(result).toContain("```js\n");
      expect(result).toContain("const value1999 = compute(1999);");
    });
  });

  it("reads a reply of many separate declarations without rescanning them", () => {
    const message = Array.from(
      { length: 2_000 },
      (_, index) => `const value${index} = compute(${index});\n\nProse between them ${index}.`,
    ).join("\n\n");
    expectLinearTime(() => {
      expect(codeBlockMarkdown(message).match(/^```js$/gm)).toHaveLength(2_000);
    });
  });
});
