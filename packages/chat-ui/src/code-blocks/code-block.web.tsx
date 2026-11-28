import { CopyTextFallback, useCopyText } from "@rakazo/ui-web";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "../icons";
import { useMarkdownCopy } from "../markdown-copy";

export type MarkdownHast = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHast[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

export function CopyButton({
  read,
  label,
  inline = false,
}: {
  read: () => string;
  label: string;
  /** Inside a code block's header, rather than floating over the block. */
  inline?: boolean;
}) {
  const copy = useMarkdownCopy();
  const [copied, copyText, copyFailed, resetCopy, failedText] = useCopyText();

  return (
    <>
      <button
        type="button"
        className={
          inline ? "rk-chat-markdown-copy rk-chat-markdown-copy-inline" : "rk-chat-markdown-copy"
        }
        onClick={() => copyText(read())}
        aria-label={copied ? copy.copied : label}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <CopyTextFallback
        open={copyFailed}
        onOpenChange={resetCopy}
        text={failedText}
        label={label}
      />
    </>
  );
}

type Highlighter = ComponentType<{ code: string; language: string }>;

/**
 * What a message with code needs beyond plain text: the reader that fences code a bot wrote
 * without a fence, the highlighter, and the reprinting of long lines.
 */
type Drawing = {
  codeBlockMarkdown: (text: string) => string;
  highlight: Highlighter;
  pretty: (code: string) => string;
};

// Reading and drawing code weighs more than the rest of a message, so it is its own chunk: a chat
// with no code never loads it.
let drawing: Drawing | undefined;
let drawingLoad: Promise<Drawing> | undefined;

function loadDrawing(): Promise<Drawing> {
  drawingLoad ??= import("./drawing.web").then(
    (module) => {
      drawing = module;
      return module;
    },
    (error: unknown) => {
      // A failed chunk load is tried again by the next block rather than failing every one.
      drawingLoad = undefined;
      throw error;
    },
  );
  return drawingLoad;
}

/**
 * The drawing once its chunk has arrived, or nothing until then. `needed` starts the load; a
 * message that has no code leaves it alone, so its chunk is never fetched for prose.
 */
export function useDrawing(needed = true): Drawing | undefined {
  // A block that mounts after another loaded the chunk draws itself in its first paint.
  const [loaded, setLoaded] = useState(drawing);
  useEffect(() => {
    if (!needed) return;
    if (drawing) {
      setLoaded(() => drawing);
      return;
    }
    let live = true;
    loadDrawing().then(
      (arrived) => {
        if (live) setLoaded(() => arrived);
      },
      // Code stays plain when the chunk cannot load; the next block asks again.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [needed]);
  return loaded;
}

/** Lines past which a block folds, so one long paste does not push the reply away. */
const COLLAPSE_LINES = 24;

/** Past this a block is drawn as it is: tokenizing a very long paste is not worth its cost. */
const HIGHLIGHT_LIMIT = 20_000;

export function CodeBlock({
  copyable,
  prose,
  language,
  code,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"pre"> & {
  copyable: boolean;
  prose: boolean;
  language: string;
  code: string;
}) {
  const copy = useMarkdownCopy();
  const drawing = useDrawing();
  const [expanded, setExpanded] = useState(false);
  // The parser ends a fence's code with a newline the author didn't write.
  const written = code.replace(/\n$/, "");
  // A long literal line is reprinted for reading; copying still copies what the bot wrote.
  const shown = drawing ? drawing.pretty(written) : written;
  const readCode = useCallback(() => written, [written]);
  const long = !prose && shown.split("\n").length > COLLAPSE_LINES;
  const collapsed = long && !expanded;
  const highlighted =
    drawing && !prose && shown.length <= HIGHLIGHT_LIMIT ? (
      <code className={language ? `language-${language}` : undefined}>
        <drawing.highlight code={shown} language={language} />
      </code>
    ) : undefined;

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <div className="rk-chat-markdown-code" data-prose={prose ? "" : undefined}>
        {prose && copyable ? <CopyButton read={readCode} label={copy.copyCode} /> : null}
        {prose ? null : (
          <div className="rk-chat-markdown-code-head">
            <span className="rk-chat-markdown-code-language">{language}</span>
            <span className="rk-chat-markdown-code-actions">
              {long ? (
                <button
                  type="button"
                  className="rk-chat-markdown-code-more"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                >
                  {expanded ? copy.collapseCode : copy.expandCode}
                </button>
              ) : null}
              {copyable ? <CopyButton read={readCode} label={copy.copyCode} inline /> : null}
            </span>
          </div>
        )}
        <pre
          {...props}
          className={prose ? "rk-chat-markdown-pre-prose" : undefined}
          data-collapsed={collapsed ? "" : undefined}
        >
          {highlighted ?? children}
        </pre>
      </div>
    </div>
  );
}

export function codeElement(node: MarkdownHast | undefined) {
  return node?.children?.find((child) => child.tagName === "code");
}

export function codeText(code: MarkdownHast | undefined) {
  return (code?.children ?? []).map((child) => child.value ?? "").join("");
}

/** The language a fence names, or "" when it names none. */
export function fenceLanguage(node: MarkdownHast | undefined): string {
  const classNames = codeElement(node)?.properties?.className;
  const language = Array.isArray(classNames)
    ? classNames.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  return typeof language === "string" ? language.slice("language-".length) : "";
}
