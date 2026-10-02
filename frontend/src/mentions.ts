import type { Participant } from "./api";

export type MentionMatch = {
  query: string;
  atIndex: number;
};

/**
 * Checks if the text before cursor ends with an @mention trigger.
 * Matches '@' preceded by start of string or a non-word character [^a-zA-Z0-9_-],
 * followed by any word characters up to the cursor.
 */
export function getMentionMatch(text: string, cursorPos: number): MentionMatch | null {
  const beforeCursor = text.slice(0, cursorPos);
  const match = /(?:^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_-]*)$/.exec(beforeCursor);
  if (!match) return null;
  const query = match[1];
  const atIndex = cursorPos - query.length - 1;
  return { query, atIndex };
}

/**
 * Filter and sort participants matching the mention query.
 */
export function filterParticipants(participants: Participant[], query: string): Participant[] {
  const pool = participants.filter((p) => p.persona_id && p.persona_id !== "user");
  const seen = new Set<string>();
  const unique = pool.filter((p) => {
    if (seen.has(p.persona_id)) return false;
    seen.add(p.persona_id);
    return true;
  });

  const q = query.toLowerCase();
  if (!q) return unique;

  return unique
    .filter((p) => p.persona_id.toLowerCase().includes(q) || (p.role && p.role.toLowerCase().includes(q)))
    .sort((a, b) => {
      const aStarts = a.persona_id.toLowerCase().startsWith(q);
      const bStarts = b.persona_id.toLowerCase().startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.persona_id.localeCompare(b.persona_id);
    });
}

/**
 * Compute the new text and cursor position when a mention is selected.
 */
export function applyMention(
  text: string,
  cursorPos: number,
  match: MentionMatch,
  personaId: string,
): { text: string; cursor: number } {
  const before = text.slice(0, match.atIndex);
  const restOfWord = text.slice(cursorPos).match(/^[a-zA-Z0-9_-]*/)?.[0] ?? "";
  let after = text.slice(cursorPos + restOfWord.length);
  if (after.startsWith(" ")) {
    after = after.slice(1);
  }
  const mention = `@${personaId} `;
  const nextText = before + mention + after;
  const nextCursor = before.length + mention.length;
  return { text: nextText, cursor: nextCursor };
}
