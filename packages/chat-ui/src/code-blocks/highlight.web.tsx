import { cssVariableName } from "@rakazo/ui-tokens";
import { Highlight } from "prism-react-renderer";
import type { ReactNode } from "react";
import { codeTheme } from "./code-theme";
import { prettyCode } from "./pretty";

// Drawn in the palette's own CSS variables, so a code block follows the app's light and dark
// themes without a second set of colours to keep in step.
const theme = codeTheme((token) => `var(${cssVariableName(token)})`);

/** Where a line break goes, since a block's lines are newlines in its text, not elements. */
function breaks(lines: ReactNode[]): ReactNode[] {
  return lines.flatMap((line, index) => (index === 0 ? [line] : ["\n", line]));
}

/**
 * A fenced block's code, token by token. Loaded with `import()` the first time a message has a
 * block, so the highlighter never weighs on the app's startup.
 */
export default function HighlightedCode({ code, language }: { code: string; language: string }) {
  return (
    <Highlight theme={theme} code={code} language={language || "text"}>
      {({ tokens, getTokenProps }) =>
        breaks(
          tokens.map((line, lineIndex) => (
            <span key={lineIndex} className="rk-chat-markdown-code-line">
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
            </span>
          )),
        )
      }
    </Highlight>
  );
}

/** The line reprinting that goes with the highlighter, shipped in the same chunk. */
export { prettyCode };
