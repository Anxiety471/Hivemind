// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CODE_BLOCK_SAMPLE } from "./code-blocks/code-blocks.test-support";
import { ChatMarkdown } from "./markdown.web";

async function render(markdown: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web chat code blocks", () => {
  it("draws a bot's unfenced code as a highlighted block with its language", async () => {
    const { container, cleanup } = await render(CODE_BLOCK_SAMPLE);
    // The reply's own sentence stays a paragraph; the code became a block.
    expect(container.querySelector("p")?.textContent).toBe("Here is where everything runs:");
    const code = container.querySelector("pre code");
    expect(code?.className).toBe("language-jsx");
    // The JSX the sanitizer used to eat is code now, kept exactly as written.
    expect(code?.textContent).toContain("render: (v) => <Tag>{v}</Tag>");
    expect(code?.textContent).toContain(
      "ReactDOM.render(<Table columns={columns} dataSource={data} />",
    );
    // Drawing code is a chunk of its own; once it arrives the code is drawn in ink tokens,
    // and the sample's one-line rows are reprinted one property per line.
    await vi.waitFor(() => {
      const token = [...container.querySelectorAll("pre code span span")].find((span) =>
        span.getAttribute("style")?.includes("color"),
      );
      expect(token?.getAttribute("style")).toContain("var(--");
    });
    const shown = container.querySelector("pre code")?.textContent ?? "";
    expect(shown).toContain('\n  {\n    key: "1",');
    // A line that is already short keeps its shape.
    expect(shown).toContain("\nconst columns = [");
    expect(shown).toContain("ReactDOM.render(<Table columns={columns} dataSource={data} />");
    await cleanup();
  });

  it("labels the block and copies exactly what the bot wrote", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container, cleanup } = await render(CODE_BLOCK_SAMPLE);
    expect(container.querySelector(".rk-chat-markdown-code-language")?.textContent).toBe("jsx");
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
    await act(async () => {
      copy?.click();
    });
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("const data = [");
    expect(copied).toContain("render: (v) => <Tag>{v}</Tag>");
    expect(copied).toContain("ReactDOM.render(<Table columns={columns} dataSource={data} />");
    expect(copied).not.toContain("Here is where everything runs:");
    await cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("does not fold a short block, and folds a long one until it is opened", async () => {
    const short = await render("```ts\nconst a = 1;\n```");
    expect(short.container.querySelector("pre")?.hasAttribute("data-collapsed")).toBe(false);
    expect(short.container.querySelector(".rk-chat-markdown-code-more")).toBeNull();
    await short.cleanup();

    const lines = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const { container, cleanup } = await render(`\`\`\`ts\n${lines}\n\`\`\``);
    const pre = container.querySelector("pre");
    expect(pre?.hasAttribute("data-collapsed")).toBe(true);
    const toggle = container.querySelector<HTMLButtonElement>(".rk-chat-markdown-code-more");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toBe("Expand code");
    await act(async () => {
      toggle?.click();
    });
    expect(pre?.hasAttribute("data-collapsed")).toBe(false);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.textContent).toBe("Collapse code");
    await cleanup();
  });

  it("keeps a prose fence as prose, with its copy control", async () => {
    const { container, cleanup } = await render("```text\nDear team,\n\nsee you Monday.\n```");
    const pre = container.querySelector("pre");
    expect(pre?.className).toBe("rk-chat-markdown-pre-prose");
    expect(container.querySelector(".rk-chat-markdown-code-head")).toBeNull();
    expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    await cleanup();
  });
});
