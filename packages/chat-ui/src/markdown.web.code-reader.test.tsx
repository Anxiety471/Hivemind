// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CODE_BLOCK_SAMPLE } from "./code-blocks/code-blocks.test-support";

// The reader is a chunk of its own, so how often that chunk is fetched is the thing to check: the
// factory below runs when the app first asks for it, and not before.
const chunk = vi.hoisted(() => ({ loads: 0 }));

vi.mock("./code-blocks/drawing.web", async () => {
  chunk.loads += 1;
  const { codeBlockMarkdown } = await import("./code-blocks/code-blocks");
  return {
    codeBlockMarkdown,
    // Drawing the block is what the other code-block tests cover; plain code is enough here.
    highlight: ({ code }: { code: string }) => code,
    pretty: (code: string) => code,
  };
});

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

describe("the chunk that reads unfenced code", () => {
  it("is not fetched for a message that is only prose", async () => {
    const { container, cleanup } = await render(
      "Here is what I found: the build passed, and the tests are green.",
    );
    expect(chunk.loads).toBe(0);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("p")?.textContent).toContain("Here is what I found");
    await cleanup();
  });

  it("is fetched once, and the code message is a block", async () => {
    const { container, cleanup } = await render(CODE_BLOCK_SAMPLE);
    await vi.waitFor(() => {
      expect(container.querySelector("pre code")?.className).toBe("language-jsx");
    });
    expect(chunk.loads).toBe(1);
    expect(container.querySelector("p")?.textContent).toBe("Here is where everything runs:");
    expect(container.querySelector("pre code")?.textContent).toContain(
      "ReactDOM.render(<Table columns={columns} dataSource={data} />",
    );
    await cleanup();
  });
});
