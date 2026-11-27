import type { ColorTokens } from "@rakazo/ui-tokens";
import type { PrismTheme } from "prism-react-renderer";

/** One kind of token, drawn in one ink of the palette and its emphasis. */
type Ink = { types: string[]; token: keyof ColorTokens; italic?: boolean; bold?: boolean };

/**
 * The app is monochrome, so a highlighted block differs by ink and weight, never by hue:
 * keywords and names carry the ink, strings and punctuation step back, comments fade.
 */
const INK: Ink[] = [
  {
    types: ["comment", "prolog", "doctype", "cdata", "shebang", "doc-comment"],
    token: "faintForeground",
    italic: true,
  },
  { types: ["punctuation", "operator", "arrow", "spread"], token: "mutedForeground" },
  {
    types: [
      "string",
      "char",
      "attr-value",
      "regex",
      "template-string",
      "template-punctuation",
      "inserted",
    ],
    token: "mutedForeground",
  },
  {
    types: ["keyword", "atrule", "important", "selector", "tag", "rule", "module", "control-flow"],
    token: "foreground",
    bold: true,
  },
  {
    types: [
      "function",
      "function-variable",
      "method",
      "method-variable",
      "class-name",
      "maybe-class-name",
    ],
    token: "foreground",
  },
  {
    types: ["attr-name", "property", "variable", "parameter", "literal-property", "number"],
    token: "foreground",
  },
  { types: ["boolean", "null", "nil", "constant", "symbol", "builtin"], token: "mutedForeground" },
  { types: ["namespace"], token: "mutedForeground" },
  { types: ["invalid", "deleted"], token: "destructive" },
];

/**
 * The code theme in one palette's ink. Web passes a CSS variable per token, native passes the
 * palette's own colour, so a block looks the same on every surface and follows the app's theme.
 */
export function codeTheme(color: (token: keyof ColorTokens) => string): PrismTheme {
  return {
    plain: { color: color("foreground"), backgroundColor: "transparent" },
    styles: INK.map((ink) => ({
      types: ink.types,
      style: {
        color: color(ink.token),
        ...(ink.italic ? { fontStyle: "italic" as const } : {}),
        ...(ink.bold ? { fontWeight: "600" as const } : {}),
      },
    })),
  };
}
