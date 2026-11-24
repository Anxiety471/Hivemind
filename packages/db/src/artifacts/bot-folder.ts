import { ARTIFACT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "../database/client.js";
import { isUniqueViolation } from "../database/prisma-errors.js";

type BotFolderDb =
  | Pick<PrismaClient, "fileFolder" | "bot">
  | Pick<Prisma.TransactionClient, "fileFolder" | "bot">;

function sanitizeFolderName(raw: string, fallback = "Bot"): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remote file names may carry control characters; they are stripped here on purpose.
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ARTIFACT_NAME_MAX_LENGTH)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * Resolves (or creates) the top-level Space Drive folder dedicated to a bot.
 * If an unbound active root folder already matches the bot's name, it is adopted.
 */
export async function ensureBotDriveFolder(
  db: BotFolderDb,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    botName?: string;
  },
): Promise<string> {
  const existing = await db.fileFolder.findFirst({
    where: { spaceId: input.spaceId, botId: input.botId, trashedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  let rawName = input.botName;
  let ownerUserId = input.userId;
  if (!rawName?.trim()) {
    const bot = await db.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId },
      select: { name: true, userId: true },
    });
    if (bot) {
      rawName = bot.name;
      ownerUserId = ownerUserId || bot.userId;
    }
  }
  const baseName = sanitizeFolderName(rawName ?? "", "Bot");

  const unbound = await db.fileFolder.findFirst({
    where: {
      spaceId: input.spaceId,
      parentId: null,
      trashedAt: null,
      botId: null,
      name: { equals: baseName, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (unbound) {
    const claimed = await db.fileFolder.updateMany({
      where: { id: unbound.id, spaceId: input.spaceId, botId: null, trashedAt: null },
      data: { botId: input.botId },
    });
    if (claimed.count > 0) return unbound.id;
    const afterRace = await db.fileFolder.findFirst({
      where: { spaceId: input.spaceId, botId: input.botId, trashedAt: null },
      select: { id: true },
    });
    if (afterRace) return afterRace.id;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix =
      attempt === 0 ? "" : attempt < 9 ? ` (${attempt + 1})` : ` (${input.botId.slice(-4)})`;
    const maxBase = Math.max(1, ARTIFACT_NAME_MAX_LENGTH - suffix.length);
    const name = `${baseName.slice(0, maxBase).trim()}${suffix}`;
    try {
      const created = await db.fileFolder.create({
        data: {
          spaceId: input.spaceId,
          parentId: null,
          botId: input.botId,
          createdByUserId: ownerUserId,
          name,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await db.fileFolder.findFirst({
        where: { spaceId: input.spaceId, botId: input.botId, trashedAt: null },
        select: { id: true },
      });
      if (winner) return winner.id;
    }
  }
  throw new Error(`Could not create Space Drive folder for bot ${input.botId}`);
}
