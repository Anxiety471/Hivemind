import type { ThreadMessage } from "@rakazo/contracts";
import { helperCardState } from "@rakazo/core";

export type SubagentBlock = Extract<ThreadMessage["blocks"][number], { kind: "subagent" }>;

/** The saved helper card a read-only helper view opens, and what its header says. */
export type HelperThreadTarget = {
  /** The saved card's message id; the server resolves it to the helper's own thread. */
  messageId: string;
  name: string;
  task: string;
  status: SubagentBlock["status"];
  /** The card showed Stop, so its settled state reads Stopped rather than Failed. */
  stopped: boolean;
};

/**
 * A card saved in a chat has a real message id its helper's thread can be found from. A live
 * card from a turn being written has a `subagent:` id and no thread of its own yet.
 */
export function isSavedHelperCard(message: Pick<ThreadMessage, "id" | "botId">): boolean {
  return Boolean(message.botId) && !message.id.startsWith("subagent:");
}

export function helperThreadTarget(
  message: Pick<ThreadMessage, "id">,
  block: SubagentBlock,
): HelperThreadTarget {
  return {
    messageId: message.id,
    name: block.name,
    task: block.task,
    status: block.status,
    stopped: helperCardState(block).stopped,
  };
}
