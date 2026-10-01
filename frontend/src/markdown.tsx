// Agent replies as Markdown. Hand-rolled and dependency-free: every runtime's reply goes
// through the same renderer, output is built from React elements (never raw HTML), and
// plain text without any Markdown renders as ordinary paragraphs.
import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdownParse";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}>{renderInline(n.v)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.v)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.v)}</del>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.v)}
          </a>
        );
      case "br":
        return <br key={i} />;
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "heading": {
        const Tag = `h${Math.min(6, b.level + 2)}` as "h3";
        return <Tag key={i}>{renderInline(b.v)}</Tag>;
      }
      case "paragraph":
        return <p key={i}>{renderInline(b.v)}</p>;
      case "code":
        return (
          <pre key={i} data-lang={b.lang || undefined}>
            <code>{b.v}</code>
          </pre>
        );
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((item, j) => (
              <li key={j}>{renderBlocks(item)}</li>
            ))}
          </Tag>
        );
      }
      case "quote":
        return <blockquote key={i}>{renderBlocks(b.v)}</blockquote>;
      case "hr":
        return <hr key={i} />;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{renderBlocks(parseMarkdown(text))}</div>;
}
