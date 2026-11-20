const MIN_CONTINUATION_OVERLAP = 4;
export const MAX_CONTINUATION_OVERLAP = 240;

/**
 * How much of the start of a continuation repeats the end of the cut reply: the longest such
 * run of at least a few characters, up to about a sentence. Shorter matches are coincidence.
 */
export function continuationOverlap(
  cut: string,
  continuation: string,
  minimum = MIN_CONTINUATION_OVERLAP,
): number {
  const longest = Math.min(cut.length, continuation.length, MAX_CONTINUATION_OVERLAP);
  for (let size = longest; size >= minimum; size -= 1) {
    if (cut.endsWith(continuation.slice(0, size))) return size;
  }
  return 0;
}

// Models often open a continuation with an ellipsis before picking the words up again.
const CONTINUATION_MARKER = /^(?:…|\.{3})[^\S\n]*/;
/** Longest marker the join may drop, so it waits for enough text to decide. */
export const MAX_CONTINUATION_MARKER = 4;

/**
 * How much of the start of a continuation to drop: its repeat of the end of the cut reply, and
 * an ellipsis before that repeat. An ellipsis that doesn't lead into a repeat is kept.
 */
export function continuationRepeat(cut: string, continuation: string, requested = false): number {
  if (requested) cut = cut.trimEnd();
  // Short requested repeats must cover the whole final word or cut fragment.
  const minimum = requested
    ? Math.min(MIN_CONTINUATION_OVERLAP, /\S+$/.exec(cut)?.[0].length ?? MIN_CONTINUATION_OVERLAP)
    : MIN_CONTINUATION_OVERLAP;
  const marker = CONTINUATION_MARKER.exec(continuation)?.[0] ?? "";
  const afterMarker = marker
    ? continuationOverlap(cut, continuation.slice(marker.length), minimum)
    : 0;
  return afterMarker
    ? marker.length + afterMarker
    : continuationOverlap(cut, continuation, minimum);
}
