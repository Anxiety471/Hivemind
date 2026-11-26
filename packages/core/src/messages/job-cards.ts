import type { MessageBlock } from "@rakazo/contracts";

/** A message as a chat holds it, for the rows that decide what the thread shows. */
export type JobCardMessage = {
  seq?: number;
  blocks: readonly MessageBlock[];
};

/**
 * The thread without job cards a later card for the same job replaced. A job posts a card when it
 * starts and again each time its state is learned, so without this an old card would keep counting
 * its clock after the job finished. Only the newest card for a `jobId` stays; a message left with
 * no blocks goes with it, and every other message keeps its identity so the chat does not redraw.
 */
export function withoutSupersededJobCards<T extends JobCardMessage>(messages: T[]): T[] {
  // A stored row is ordered by its seq, a live row (built from events, so without one) comes after
  // every stored row in list order: its own index would otherwise rank it older than a stored seq.
  const latestSeq = messages.reduce((latest, message) => Math.max(latest, message.seq ?? 0), 0);
  const rankOf = (message: JobCardMessage, index: number) => message.seq ?? latestSeq + 1 + index;
  const newest = new Map<string, number>();
  messages.forEach((message, index) => {
    const rank = rankOf(message, index);
    for (const block of message.blocks) {
      if (block.kind !== "job") continue;
      const seen = newest.get(block.jobId);
      if (seen === undefined || rank > seen) newest.set(block.jobId, rank);
    }
  });
  if (newest.size === 0) return messages;
  let changed = false;
  const kept: T[] = [];
  messages.forEach((message, index) => {
    if (!message.blocks.some((block) => block.kind === "job")) {
      kept.push(message);
      return;
    }
    // A card is shown only when its own message is the newest one for its job.
    const rank = rankOf(message, index);
    const blocks = message.blocks.filter(
      (block) => block.kind !== "job" || newest.get(block.jobId) === rank,
    );
    if (blocks.length === message.blocks.length) {
      kept.push(message);
      return;
    }
    changed = true;
    if (blocks.length > 0) kept.push({ ...message, blocks });
  });
  return changed ? kept : messages;
}
