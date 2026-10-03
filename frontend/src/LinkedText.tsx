import type { ReactNode } from "react";

/** Agent artifact URLs are real links; other text stays literal, including HTML. */
export function LinkedText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const pattern = /https?:\/\/[^\s<>\])]+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const href = match[0].replace(/[.,;:!?]+$/, "");
    nodes.push(text.slice(cursor, match.index));
    nodes.push(<a key={match.index} href={href} target="_blank" rel="noopener noreferrer">{href}</a>);
    cursor = match.index + href.length;
  }
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
