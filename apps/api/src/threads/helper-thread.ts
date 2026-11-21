import type { Actor } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, IsolationError } from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

/**
 * A background helper's own thread as a read-only bot target. It is found from the card that
 * started the helper (which sits in a chat or in another helper's thread), or by its id once a
 * client has it. Space members read every chat of the Space, so the Space is the boundary: any
 * other thread, or one that is no helper's, is not found.
 */
export async function resolveHelperThread(
  prisma: PrismaClient,
  actor: Actor,
  input: { messageId: string } | { threadId: string },
): Promise<Extract<ThreadTarget, { kind: "bot" }>> {
  const thread =
    "messageId" in input
      ? (
          await prisma.run.findFirst({
            where: {
              spaceId: actor.spaceId,
              trigger: BACKGROUND_HELPER_TRIGGER,
              sourceMessageId: input.messageId,
              thread: { spaceId: actor.spaceId, helperBotId: { not: null } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { thread: { select: { id: true, helperBotId: true } } },
          })
        )?.thread
      : await prisma.thread.findFirst({
          where: { id: input.threadId, spaceId: actor.spaceId, helperBotId: { not: null } },
          select: { id: true, helperBotId: true },
        });
  if (!thread?.helperBotId) throw new IsolationError();
  const bot = await createRepos(prisma).getBot(actor, thread.helperBotId, {
    includeArchived: true,
  });
  return { kind: "bot", botId: bot.id, threadId: thread.id, bot };
}
