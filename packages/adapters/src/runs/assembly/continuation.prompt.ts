import { automated } from "../../messaging/automated-messages.prompt.js";

// Sent in the user's role, so marked as automated: otherwise models read it as the user
// telling them never to stop, and keep going instead of asking.
export const SILENT_TOOL_CONTINUATION_PROMPT = automated(
  "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing; otherwise use any remaining tools needed, then give the user the final answer.",
);
// Sent when a non-silent turn ended with no visible text and no tool calls (empty,
// whitespace-only, or thinking-only), giving the model one bounded chance to reply.
export const EMPTY_RESPONSE_REMINDER_PROMPT = automated(
  "Your last turn ended without a visible response to the user. If you need tools to finish the task, call them now; if you need information or a decision from the user, ask them instead of guessing; otherwise write a concise, direct reply now.",
);
// Sent once when a text-only reply stopped with checks or reversible updates still undone.
export const UNFINISHED_WORK_CONTINUATION_PROMPT = automated(
  "Your last reply stopped with unfinished checks or unexecuted actions you can still complete with your tools. Do not narrate future steps or leave reversible checks undone: call the tools now to finish those remaining checks and state updates, then report only the new findings and final status without repeating what you already sent.",
);
// Sent on an unaddressed group turn that ended empty without saying NO_RESPONSE.
export const EMPTY_RESPONSE_OPTIONAL_REMINDER_PROMPT = automated(
  "Your last turn ended without a visible response. If this message is for you, use any tools needed and reply concisely; if another member should handle it and you intend to stay silent, reply with exactly NO_RESPONSE.",
);
// Sent after a reply was cut off by a dropped connection; the cut text is the previous turn.
export const CUT_REPLY_CONTINUATION_PROMPT = automated(
  "Your previous reply was cut off by a connection error. Continue exactly where it stopped, mid-word if needed, without repeating anything.",
);
/**
 * Sent after a reply ran out of output room. Models don't reliably tell a finished last word
 * from a cut one, or keep the space before the next word, so the continuation starts by
 * repeating the reply's last words, quoted here, and the join drops that repeat.
 */
export function cutReplyAtLimitPrompt(cut: string): string {
  const end = cut.trimEnd().slice(-200);
  const words = /(?:\S+\s+){0,5}\S+$/.exec(end)?.[0] ?? end;
  // Escaped so a quote mark in the reply can't end the quote early; line breaks stay as they
  // are, for the model to repeat them.
  const quoted = words.slice(-80).replace(/["\\]/g, "\\$&");
  return automated(
    `Your previous reply hit the output limit. It ended with: "${quoted}" Continue it: start by repeating those last words exactly, then carry on without repeating anything else.`,
  );
}
export const SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT = automated(
  "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing, even if you were told to stay silent. Otherwise, if you were instructed to stay silent when there is nothing to report, follow that instruction for the entire final assistant reply; if not, use any remaining tools needed, then give the user the final answer.",
);
