// Agent replies as Markdown. Hand-rolled and dependency-free: every runtime's reply goes
// through the same renderer, output is built from React elements (never raw HTML), and
// plain text without any Markdown renders as ordinary paragraphs.
import type { ReactNode } from "react";
import { useState, useEffect, useId } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from "mermaid";
import { parseMarkdown } from "./markdownParse";
import { plantumlToMermaid } from "./diagrams/plantuml";
import { drawioToScene, looksLikeDrawio } from "./diagrams/drawio";
import { DrawioSvg } from "./diagrams/DrawioSvg";
import { AsciiBlock } from "./diagrams/AsciiBlock";
// ASCII diagrams use a bundled DejaVu Sans Mono: it has box-drawing, arrow and geometric
// glyphs at the monospace advance, so alignment no longer depends on installed fonts.
import "@fontsource/dejavu-mono/400.css";
import type { AlertKind, Block, Inline } from "./markdownParse";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
  // Otherwise a failed render leaves Mermaid's "Syntax error" bomb SVG appended to <body>;
  // DiagramBlock already shows the source and error message inline.
  suppressErrorRendering: true,
});

const ALERT_META: Record<AlertKind, { icon: string; title: string }> = {
  note: { icon: "ℹ️", title: "Note" },
  tip: { icon: "💡", title: "Tip" },
  important: { icon: "🟣", title: "Important" },
  warning: { icon: "⚠️", title: "Warning" },
  caution: { icon: "🛑", title: "Caution" },
};

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="code-lang-tag">{(lang || "code").toUpperCase()}</span>
        <button
          type="button"
          className="code-copy-btn"
          onClick={() => {
            navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          aria-label="Copy code to clipboard"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre data-lang={lang || undefined}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

type Rendered = { svg: string } | { node: ReactNode };

// Shared frame for every diagram language: renders `code` asynchronously, falls back to the
// raw source with the error when the diagram cannot be drawn, and lets the reader flip to source.
function DiagramBlock({ badge, code, render }: { badge: string; code: string; render: (code: string, id: string) => Promise<Rendered> }) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const rawId = useId().replace(/[:]/g, "_");
  const diagramId = `diagram_${rawId}`;

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await render(code, diagramId);
        if (active) {
          setRendered(result);
          setError(null);
        }
      } catch (err: unknown) {
        if (active) {
          setRendered(null);
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [code, diagramId, render]);

  if (error || showCode) {
    return (
      <div className="mermaid-wrap">
        <div className="mermaid-toolbar">
          <span className="mermaid-badge">{badge}</span>
          {rendered && (
            <button type="button" className="code-copy-btn" onClick={() => setShowCode(!showCode)}>
              {showCode ? "View Diagram" : "View Source"}
            </button>
          )}
        </div>
        <pre data-lang={badge.toLowerCase()}>
          <code>{code}</code>
        </pre>
        {error && <div className="mermaid-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="mermaid-wrap">
      <div className="mermaid-toolbar">
        <span className="mermaid-badge">{badge}</span>
        <button type="button" className="code-copy-btn" onClick={() => setShowCode(true)} title={`View raw ${badge} source`}>
          Source
        </button>
      </div>
      {!rendered ? (
        <div className="mermaid-loading">Rendering diagram...</div>
      ) : "svg" in rendered ? (
        <div className="mermaid-svg-container" dangerouslySetInnerHTML={{ __html: rendered.svg }} />
      ) : (
        <div className="mermaid-svg-container">{rendered.node}</div>
      )}
    </div>
  );
}

const renderMermaid = async (code: string, id: string): Promise<Rendered> => ({ svg: (await mermaid.render(id, code)).svg });
const renderPlantuml = async (code: string, id: string): Promise<Rendered> => renderMermaid(plantumlToMermaid(code), id);
const renderDrawio = async (code: string): Promise<Rendered> => ({ node: <DrawioSvg scene={await drawioToScene(code)} /> });

const BOX_DRAWING = /[\u2500-\u257f]/;
const ASCII_LANGS = new Set(["ascii", "asciiart", "ascii-art", "diagram", "text", "txt", "plain", "plaintext", ""]);

/** Which diagram renderer (if any) handles a fenced block. */
function diagramKind(lang: string, code: string): "mermaid" | "plantuml" | "drawio" | "ascii" | "ascii-animation" | null {
  const l = lang.toLowerCase();
  if (l === "ascii-animation") return "ascii-animation";
  if (l === "mermaid") return "mermaid";
  if (l === "plantuml" || l === "puml" || l === "uml" || (ASCII_LANGS.has(l) && /^\s*@startuml\b/i.test(code))) return "plantuml";
  if (l === "drawio" || l === "draw.io" || l === "mxgraph" || l === "mxfile" || ((l === "xml" || ASCII_LANGS.has(l)) && looksLikeDrawio(code))) return "drawio";
  if (l === "ascii" || l === "asciiart" || l === "ascii-art" || (ASCII_LANGS.has(l) && BOX_DRAWING.test(code))) return "ascii";
  return null;
}

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
      case "math": {
        try {
          const html = katex.renderToString(n.v, { throwOnError: false });
          return <span key={i} className="katex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
        } catch {
          return <code key={i} className="math-fallback">${n.v}$</code>;
        }
      }
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
      case "math": {
        try {
          const html = katex.renderToString(b.v, { displayMode: true, throwOnError: false });
          return <div key={i} className="katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
        } catch {
          return (
            <pre key={i} className="math-fallback">
              <code>{b.v}</code>
            </pre>
          );
        }
      }
      case "code": {
        const kind = diagramKind(b.lang, b.v);
        // A fence still streaming is incomplete diagram source: show it as code until it closes.
        switch (b.open && kind !== "ascii" && kind !== "ascii-animation" ? null : kind) {
          case "mermaid":
            return <DiagramBlock key={i} badge="MERMAID" code={b.v} render={renderMermaid} />;
          case "plantuml":
            return <DiagramBlock key={i} badge="PLANTUML" code={b.v} render={renderPlantuml} />;
          case "drawio":
            return <DiagramBlock key={i} badge="DRAW.IO" code={b.v} render={renderDrawio} />;
          case "ascii":
            return <AsciiBlock key={i} code={b.v} streaming={b.open} />;
          case "ascii-animation":
            return <AsciiBlock key={i} code={b.v} animated streaming={b.open} />;
          default:
            return <CodeBlock key={i} lang={b.lang} code={b.v} />;
        }
      }
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        const isTask = b.items.some((it) => it.checked !== null);
        return (
          <Tag
            key={i}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={isTask ? "task-list" : undefined}
          >
            {b.items.map((item, j) => (
              <li key={j} className={item.checked !== null ? "task-item" : undefined}>
                {item.checked !== null && (
                  <input
                    type="checkbox"
                    className="task-checkbox"
                    checked={item.checked}
                    disabled
                    readOnly
                  />
                )}
                <div className="task-content">{renderBlocks(item.body)}</div>
              </li>
            ))}
          </Tag>
        );
      }
      case "alert": {
        const meta = ALERT_META[b.kind];
        return (
          <div key={i} className={`markdown-alert markdown-alert-${b.kind}`}>
            <div className="alert-header">
              <span className="alert-icon">{meta.icon}</span>
              <span className="alert-title">{b.title || meta.title}</span>
            </div>
            <div className="alert-body">{renderBlocks(b.v)}</div>
          </div>
        );
      }
      case "think":
        return (
          <details key={i} className="markdown-think">
            <summary className="think-summary">
              <span className="think-icon">💭</span>
              <span className="think-label">Thinking Process</span>
            </summary>
            <div className="think-body">{renderBlocks(b.v)}</div>
          </details>
        );
      case "details":
        return (
          <details key={i} className="markdown-details">
            <summary className="details-summary">{b.summary}</summary>
            <div className="details-body">{renderBlocks(b.v)}</div>
          </details>
        );
      case "quote":
        return <blockquote key={i}>{renderBlocks(b.v)}</blockquote>;
      case "table":
        return (
          <div key={i} className="markdown-table-wrap">
            <table>
              {b.headers.length > 0 && (
                <thead>
                  <tr>
                    {b.headers.map((h, col) => (
                      <th key={col} style={b.align[col] ? { textAlign: b.align[col]! } : undefined}>
                        {renderInline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={b.align[c] ? { textAlign: b.align[c]! } : undefined}>
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={i} />;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{renderBlocks(parseMarkdown(text))}</div>;
}
