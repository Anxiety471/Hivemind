import type { TicketStatus } from "@rakazo/contracts";
import {
  CommentTicketInput,
  CreateTicketInput,
  isTicketCompletedStatus,
  TicketStatusSchema,
  UpdateTicketInput,
} from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  ensureBoard,
  findTicket,
  listTicketComments,
  toTicketCommentDto,
  toTicketDto,
} from "@rakazo/db";
import type { TicketChangeNotifier } from "./ticket-changes.js";

type TicketToolDeps = {
  prisma: PrismaClient;
  onTicketChange?: TicketChangeNotifier;
};

function ticketInputError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues
    .map(({ path, message }) => {
      const field = path[0] === "ticketId" ? "id" : path.join(".");
      return field ? `${field}: ${message}` : message;
    })
    .join("; ");
}

const STATUS_ERROR = `status must be one of ${TicketStatusSchema.options.join(", ")}.`;
function coerceInputStatus(value: string) {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Every bot assigned as owner or worker must be one of the acting user's own
 * non-archived bots in the Space. Assigning a worker wakes the bot, which runs
 * as its owner, so another member's bot in the same space is never a valid target.
 */
async function ownBotsInSpace(
  deps: TicketToolDeps,
  input: { spaceId: string; userId: string },
  botIds: readonly string[],
): Promise<boolean> {
  const unique = dedupeIds(botIds);
  if (unique.length === 0) return true;
  if (unique.length === 1) {
    return Boolean(
      await deps.prisma.bot.findFirst({
        where: { id: unique[0]!, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
        select: { id: true },
      }),
    );
  }
  const found = await deps.prisma.bot.findMany({
    where: {
      id: { in: unique },
      spaceId: input.spaceId,
      userId: input.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  return found.length === unique.length;
}

async function userInSpace(
  deps: TicketToolDeps,
  spaceId: string,
  actingUserId: string,
  targetUserId: string,
): Promise<boolean> {
  if (targetUserId === actingUserId) return true;
  return Boolean(
    await deps.prisma.spaceMember.findFirst({
      where: { spaceId, userId: targetUserId },
      select: { id: true },
    }),
  );
}
const LIST_TICKETS_LIMIT = 50;
const LIST_DESCRIPTION_CHARS = 200;

/**
 * The page key is the ticket's `createdAt` with `id` as the tiebreaker, because
 * both never change. A key on `updatedAt` would move a ticket that is edited
 * while a bot pages the board: the ticket would end up above the saved cursor
 * and no later page could return it. A stable key keeps the scan complete.
 */
function encodeTicketListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeTicketListCursor(
  cursor: string,
): { createdAt: Date; id: string } | { error: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { error: "cursor is invalid." };
  }
  const split = raw.indexOf("|");
  if (split <= 0) return { error: "cursor is invalid." };
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return { error: "cursor is invalid." };
  return { createdAt, id };
}

function truncateDescription(value: string | null | undefined) {
  if (!value || value.length <= LIST_DESCRIPTION_CHARS) return value;
  return `${sliceWellFormed(value, LIST_DESCRIPTION_CHARS - 1)}…`;
}

export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
    workerBotId?: string;
    ownerBotId?: string;
    ownerUserId?: string;
    cursor?: string;
  },
) {
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const cursor = input.cursor?.trim();
  let pageCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const decoded = decodeTicketListCursor(cursor);
    if ("error" in decoded) return decoded;
    pageCursor = decoded;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const filters: Prisma.TicketWhereInput[] = [];
  if (input.assigneeBotId) {
    filters.push({
      OR: [
        { assigneeBotId: input.assigneeBotId },
        { workerBotIds: { has: input.assigneeBotId } },
        { ownerBotId: input.assigneeBotId },
      ],
    });
  }
  if (input.workerBotId) {
    filters.push({
      OR: [{ workerBotIds: { has: input.workerBotId } }, { assigneeBotId: input.workerBotId }],
    });
  }
  if (input.ownerBotId) filters.push({ ownerBotId: input.ownerBotId });
  if (input.ownerUserId) filters.push({ ownerUserId: input.ownerUserId });
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      // Closed tickets are history; they only show up when asked for by status.
      ...(status ? { status } : { status: { not: "closed" } }),
      ...(filters.length > 0 ? { AND: filters } : {}),
      ...(pageCursor
        ? {
            OR: [
              { createdAt: { lt: pageCursor.createdAt } },
              { createdAt: pageCursor.createdAt, id: { lt: pageCursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_TICKETS_LIMIT + 1,
  });
  const page = rows.slice(0, LIST_TICKETS_LIMIT);
  const next = rows.length > LIST_TICKETS_LIMIT ? page.at(-1) : undefined;
  // A list is for scanning; ticket_get returns the full description.
  return {
    tickets: page.map((row) => {
      const dto = toTicketDto(row, board.ticketPrefix);
      return { ...dto, description: truncateDescription(dto.description) };
    }),
    ...(next ? { nextCursor: encodeTicketListCursor(next) } : {}),
  };
}

export async function getTicket(deps: TicketToolDeps, input: { spaceId: string; ref: string }) {
  const ref = input.ref.trim();
  if (!ref) return { error: "ref is required." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row =
    (await findTicket(deps.prisma, input.spaceId, board, { ref })) ??
    (await findTicket(deps.prisma, input.spaceId, board, { id: ref }));
  if (!row) return { error: `Ticket ${ref} not found.` };
  const comments = await listTicketComments(deps.prisma, input.spaceId, row.id);
  return {
    ticket: toTicketDto(row, board.ticketPrefix),
    comments: comments.map(toTicketCommentDto),
  };
}

export async function createTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    title: string;
    description?: string;
    priority?: string;
    ownerUserId?: string | null;
    ownerBotId?: string | null;
    workerBotIds?: string[];
    assigneeBotId?: string | null;
  },
) {
  const parsed = CreateTicketInput.safeParse(input);
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;

  let ownerUserId: string | null;
  let ownerBotId: string | null;
  if (data.ownerBotId) {
    ownerBotId = data.ownerBotId;
    ownerUserId = null;
  } else if (data.ownerUserId) {
    ownerUserId = data.ownerUserId;
    ownerBotId = null;
  } else if (data.ownerBotId === null && data.ownerUserId === null) {
    ownerUserId = null;
    ownerBotId = null;
  } else if (data.ownerBotId === null) {
    ownerUserId = input.userId;
    ownerBotId = null;
  } else if (data.ownerUserId === null) {
    ownerUserId = null;
    ownerBotId = input.botId ?? null;
  } else if (input.botId) {
    ownerBotId = input.botId;
    ownerUserId = null;
  } else {
    ownerUserId = input.userId;
    ownerBotId = null;
  }

  let workerBotIds: string[];
  if (data.workerBotIds !== undefined) {
    workerBotIds = dedupeIds(data.workerBotIds);
  } else if (data.assigneeBotId !== undefined) {
    workerBotIds = data.assigneeBotId ? [data.assigneeBotId] : [];
  } else if (input.botId) {
    workerBotIds = [input.botId];
  } else {
    workerBotIds = [];
  }
  const assigneeBotId = workerBotIds[0] ?? null;

  const botsToValidate = dedupeIds([...(ownerBotId ? [ownerBotId] : []), ...workerBotIds]);
  if (!(await ownBotsInSpace(deps, input, botsToValidate))) return { error: "Unknown bot." };
  if (ownerUserId && !(await userInSpace(deps, input.spaceId, input.userId, ownerUserId))) {
    return { error: "Unknown user." };
  }

  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row = await deps.prisma.$transaction(async (tx) => {
    const number = await allocateTicketNumber(tx, board.id);
    return tx.ticket.create({
      data: {
        boardId: board.id,
        spaceId: input.spaceId,
        number,
        title: data.title,
        description: data.description ?? null,
        priority: data.priority,
        assigneeBotId,
        ownerUserId,
        ownerBotId,
        workerBotIds,
        createdByBotId: input.botId ?? null,
        createdByUserId: input.userId,
      },
    });
  });
  const wakeBotIds = workerBotIds.filter((id) => id !== input.botId);
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: wakeBotIds.length > 0,
    wakeBotIds,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    id: string;
    title?: string;
    description?: string | null;
    priority?: string | null;
    status?: string;
    ownerUserId?: string | null;
    ownerBotId?: string | null;
    workerBotIds?: string[];
    assigneeBotId?: string | null;
  },
) {
  const parsed = UpdateTicketInput.safeParse(input);
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;

  const hasOwnerUpdate = data.ownerBotId !== undefined || data.ownerUserId !== undefined;
  let ownerPatch: { ownerUserId?: string | null; ownerBotId?: string | null } = {};
  if (hasOwnerUpdate) {
    if (data.ownerBotId) {
      ownerPatch = { ownerBotId: data.ownerBotId, ownerUserId: null };
    } else if (data.ownerUserId) {
      ownerPatch = { ownerUserId: data.ownerUserId, ownerBotId: null };
    } else {
      ownerPatch = {
        ...(data.ownerBotId !== undefined ? { ownerBotId: null } : {}),
        ...(data.ownerUserId !== undefined ? { ownerUserId: null } : {}),
      };
    }
  }

  const hasWorkersUpdate = data.workerBotIds !== undefined || data.assigneeBotId !== undefined;
  const nextWorkers = hasWorkersUpdate
    ? data.workerBotIds !== undefined
      ? dedupeIds(data.workerBotIds)
      : data.assigneeBotId
        ? [data.assigneeBotId]
        : []
    : undefined;

  const botsToValidate = dedupeIds([
    ...(ownerPatch.ownerBotId ? [ownerPatch.ownerBotId] : []),
    ...(nextWorkers ?? []),
  ]);
  if (!(await ownBotsInSpace(deps, input, botsToValidate))) return { error: "Unknown bot." };
  if (
    ownerPatch.ownerUserId &&
    !(await userInSpace(deps, input.spaceId, input.userId, ownerPatch.ownerUserId))
  ) {
    return { error: "Unknown user." };
  }

  const board = await ensureBoard(deps.prisma, input.spaceId);
  const result = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${data.id} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const current = await tx.ticket.findFirst({
      where: { id: data.id, spaceId: input.spaceId, boardId: board.id },
    });
    if (!current) return null;
    const prevWorkers = new Set(
      Array.isArray(current.workerBotIds) && current.workerBotIds.length > 0
        ? current.workerBotIds
        : current.assigneeBotId
          ? [current.assigneeBotId]
          : [],
    );
    const row = await tx.ticket.update({
      where: { id: current.id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.priority !== undefined ? { priority: data.priority ?? "normal" } : {}),
        ...ownerPatch,
        ...(nextWorkers !== undefined
          ? { workerBotIds: nextWorkers, assigneeBotId: nextWorkers[0] ?? null }
          : {}),
        ...(data.status !== undefined
          ? {
              status: data.status,
              completedAt: isTicketCompletedStatus(data.status)
                ? (current.completedAt ?? new Date())
                : null,
            }
          : {}),
      },
    });
    const addedWorkers = nextWorkers
      ? nextWorkers.filter((id) => !prevWorkers.has(id) && id !== input.botId)
      : [];
    return { row, addedWorkers };
  });
  if (!result) return { error: "Ticket not found." };
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: result.row.id,
    assigneeBotId: result.row.assigneeBotId,
    wakeAssignee: result.addedWorkers.length > 0,
    wakeBotIds: result.addedWorkers,
  });
  return { ticket: toTicketDto(result.row, board.ticketPrefix) };
}

export async function commentTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId?: string;
    id: string;
    body: string;
  },
) {
  const parsed = CommentTicketInput.safeParse({ ticketId: input.id, body: input.body });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const ticket = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!ticket) return { error: "Ticket not found." };
  const row = await deps.prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: {
        ticketId: ticket.id,
        spaceId: input.spaceId,
        authorBotId: input.botId ?? null,
        authorUserId: input.userId ?? null,
        body: parsed.data.body,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    return comment;
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: false,
  });
  return { comment: toTicketCommentDto(row) };
}
