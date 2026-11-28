// Everything a message with code needs beyond plain text: the reader that fences code a bot wrote
// without a fence, the highlighter, and the reprinting of long lines. One chunk on purpose — it is
// fetched as soon as a message may carry code, so the message becomes a block already drawn in ink
// instead of jumping into one plain block and then into a drawn one.
export { codeBlockMarkdown } from "./code-blocks";
export { default as highlight, prettyCode as pretty } from "./highlight.web";
