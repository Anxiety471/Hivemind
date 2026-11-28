import type { MessageBlock } from "@rakazo/contracts";
import { clampBotMessage } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { InboundTarget, WebhookDeps } from "./webhook-inbound.js";

export type WakeSender =
  | { kind: "bot"; botId: string; text: string }
  | { kind: "agent"; name: string; text: string };

/**
 * A `wake` message names who sent it. A bot of the receiver's Space shows as a message between two
 * bots ("Message from X" in the receiver's chat, "Messaged X" in the sender's); any other agent
 * (a coding agent, a script) shows under its own name and is never made to look like a bot. The
 * sender is a label the caller claims, never proof: the receiver's own webhook key already lets
 * the caller put any prompt in front of it, so this only adds the chips.
 */
export function wakeSender(payload: Record<string, unknown>): WakeSender | null {
  const message = [payload.message, payload.detail].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const text = clampBotMessage(message ?? "");
  const botId = typeof payload.fromBotId === "string" ? payload.fromBotId.trim() : "";
  if (botId) return { kind: "bot", botId, text };
  const name = typeof payload.fromAgent === "string" ? payload.fromAgent.trim().slice(0, 80) : "";
  return name ? { kind: "agent", name, text } : null;
}

/** The chips for one delivered wake; the delivery's own message id keeps a retry from doubling them. */
export async function recordWakeReceipts(
  deps: Pick<WebhookDeps, "prisma" | "events">,
  target: InboundTarget,
  sender: WakeSender,
  deliveryMessageId: string,
): Promise<void> {
  if (!sender.text) return;
  const clientNonce = `wake-receipt:${deliveryMessageId}`;
  if (sender.kind === "agent") {
    const received: MessageBlock = {
      kind: "agent_message_received",
      agentName: sender.name,
      text: sender.text,
    };
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        const already = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: target.threadId, clientNonce } },
          select: { id: true },
        });
        if (already) return null;
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          blocks: [received],
          clientNonce,
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: target.bot.spaceId,
          threadId: target.threadId,
          botId: target.bot.id,
          type: "thread.message.created",
          payload: { messageId: inbound.id, role: "user", blocks: [received] },
        });
        return [{ threadId: target.threadId, seq: event.seq }];
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
    for (const { threadId, seq } of committed ?? []) {
      await bestEffort("wake receipt realtime notification", deps.events.notify(threadId, seq));
    }
    return;
  }
  if (sender.botId === target.bot.id) return;
  const [from, to] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: sender.botId, spaceId: target.bot.spaceId, archivedAt: null },
      select: { id: true, name: true, thread: { select: { id: true } } },
    }),
    deps.prisma.bot.findFirst({
      where: { id: target.bot.id, spaceId: target.bot.spaceId, archivedAt: null },
      select: { id: true, name: true },
    }),
  ]);
  if (!from?.thread || !to) return;
  const fromThreadId = from.thread.id;

  const received: MessageBlock = {
    kind: "bot_message_received",
    fromBotId: from.id,
    fromBotName: from.name,
    text: sender.text,
  };
  const sent: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: to.id,
    toBotName: to.name,
    text: sender.text,
  };

  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      for (const threadId of [fromThreadId, target.threadId].sort()) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      }
      const already = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: target.threadId, clientNonce } },
        select: { id: true },
      });
      if (already) return null;
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks: [received],
        clientNonce,
      });
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: fromThreadId,
        role: "bot",
        blocks: [sent],
        botId: from.id,
        markUnread: false,
      });
      const inboundEvent = await appendEventInTransaction(tx, {
        spaceId: target.bot.spaceId,
        threadId: target.threadId,
        botId: target.bot.id,
        type: "thread.message.created",
        payload: { messageId: inbound.id, role: "user", blocks: [received] },
      });
      const outboundEvent = await appendEventInTransaction(tx, {
        spaceId: target.bot.spaceId,
        threadId: fromThreadId,
        botId: from.id,
        type: "thread.message.created",
        payload: { messageId: outbound.id, role: "bot", blocks: [sent] },
      });
      return [
        { threadId: target.threadId, seq: inboundEvent.seq },
        { threadId: fromThreadId, seq: outboundEvent.seq },
      ];
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  for (const { threadId, seq } of committed ?? []) {
    await bestEffort("wake receipt realtime notification", deps.events.notify(threadId, seq));
  }
}
