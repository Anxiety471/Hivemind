/** Exact token a silent run replies with; it is never a premature stop. */
const NO_RESPONSE = "NO_RESPONSE";
const MIN_TEXT_LENGTH = 12;

export type PrematureStopReason = "future_promise" | "unchecked_list" | "unexecuted_action";

/** Leading or trailing markdown and list markers, stripped before a line is matched. */
const MARKUP = new Set([..."#>*_-+.)(0123456789 \t`\"'"]);

/** `Not checked yet:`, `**Not verified yet:**`, `### Still to check:` and similar labels. */
const UNCHECKED_LABEL =
  /^(?:not (?:yet )?(?:checked|verified|confirmed)(?: yet)?|what i (?:have not|haven't) (?:yet )?verified|still to (?:check|verify|confirm)|still (?:unverified|unchecked))\s*:/;

/** An immediate, self-executed promise of tool work: `Next I'll finish…`, `I will check…`. */
const FUTURE_PROMISE =
  /^(?:(?:next|now|then|also|finally|first|and|so)(?:,)?\s+)?(?:i'll|i will|i'm going to|i am going to|let me)\s+(?:(?:now|also|first|just)\s+)?(?:check|verify|confirm|finish|complete|reopen|update|close|fetch|search|read|open|inspect|review|look|examine|investigate|continue|finalize|retry|recheck|re-check|re-verify|run|test|fix|apply|sync|commit|send|upload|save|create|edit|pull|query|list|scan|compare|reconcile|resume)\b/;

/** A sentence that waits on the user, so the promise after it is not self-executable. */
const USER_GATE =
  /\b(?:(?:once|after|when|until|unless) (?:you|your|the owner|the user)|if you|pending your|wait(?:ing)? (?:on|for) (?:you|your)|let me know|(?:ask|confirm|check) with you|after (?:the |your )?(?:approval|confirmation|decision)|your (?:approval|confirmation|decision|go-ahead))\b/;

/** Missing access, credentials or a user decision: the reply is blocked, not unfinished. */
const BLOCKED_ON_USER =
  /\b(?:blocked (?:on|by)|waiting (?:on|for) (?:you|your)|awaiting your|need(?:s)? your (?:approval|confirmation|decision|go-ahead|permission|credentials?|token|password|access)|(?:don't|do not|cannot|can't) have access|no access|missing (?:access|credentials?|permissions?)|need (?:access|credentials?))\b/;

/** Words that announce a promised action the model then did not take. */
const PROMISE_INTENT = [
  "said i'd",
  "said i would",
  "said i will",
  "i'd planned to",
  "i planned to",
  "i had planned to",
  "meant to",
  "was going to",
  "was about to",
  "intended to",
  "i had intended to",
  "promised to",
];

const NEGATION = /\b(?:haven't|have not|hadn't|had not|didn't|did not|not)\b/;

function normalizeLine(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && MARKUP.has(raw[start] ?? "")) start += 1;
  while (end > start && MARKUP.has(raw[end - 1] ?? "")) end -= 1;
  return raw.slice(start, end).replaceAll("\u2019", "'").toLowerCase();
}

/** True when a sentence says the action was not done yet: a negation followed by `yet`. */
function negatedYet(sentence: string): boolean {
  const negation = NEGATION.exec(sentence);
  return negation !== null && /\byet\b/.test(sentence.slice(negation.index));
}

/**
 * Detects a reply that stopped while tool work it can still do is unfinished: an unchecked list,
 * an admitted unexecuted action, or a promise to do tool work next. Conservative on purpose:
 * conditional offers, user-gated steps and replies blocked on access or a decision are not
 * flagged. Linear in the reply length; no nested quantifiers.
 */
export function detectPrematureStopReason(text: string): PrematureStopReason | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed === NO_RESPONSE) return null;

  const lower = trimmed.replaceAll("\u2019", "'").toLowerCase();
  const blocked = BLOCKED_ON_USER.test(lower);

  const uncheckedLabel = trimmed
    .split("\n")
    .some((line) => UNCHECKED_LABEL.test(normalizeLine(line)));

  let futurePromise = false;
  let negatedAction = false;
  for (const raw of trimmed.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = normalizeLine(raw);
    if (!sentence) continue;
    if (!USER_GATE.test(sentence) && FUTURE_PROMISE.test(sentence)) futurePromise = true;
    if (negatedYet(sentence)) negatedAction = true;
  }

  // A blocked reply counts as finished unless it also promises work it can still do now.
  const selfExecutable = futurePromise || !blocked;
  if (uncheckedLabel && selfExecutable) return "unchecked_list";
  if (negatedAction && selfExecutable && PROMISE_INTENT.some((phrase) => lower.includes(phrase))) {
    return "unexecuted_action";
  }
  if (futurePromise) return "future_promise";
  return null;
}
