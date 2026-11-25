import type {
  TicketDecision,
  TicketDecisionInput,
  TicketIssueInput,
  TicketPullRequestInput,
  TicketStatus,
} from "@rakazo/contracts";
import {
  CommentTicketInput,
  CreateTicketInput,
  DecideTicketInput,
  hasPendingTicketDecision,
  isTicketCompletedStatus,
  mergeTicketLinks,
  normalizeTicketDecision,
  pullRequestMergeFinishesTicket,
  TicketDecisionSchema,
  TicketStatusSchema,
  UpdateTicketInput,
} from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  coerceTicketStatus,
  ensureBoard,
  findTicket,
  listTicketComments,
  Prisma,
  readStoredTicketIssues,
  readStoredTicketPullRequests,
  readTicketDecision,
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

/** The statuses that ask a worker to pick the ticket up. */
const TICKET_WAKE_STATUSES: ReadonlySet<string> = new Set(["todo", "doing", "review"]);
const COMMENT_NOTE_CHARS = 400;

export const BLOCKED_MENTION_ERROR =
  "Moving a task to blocked requires an @mention of the user or bot it is blocked on (for example @user or @BotName) in the description or a ticket comment.";

export const USER_DECISION_REQUIRED_ERROR =
  "When a task waits on the user (blocked on @user or review needing user input), include a structured 'decision' with a short 'question', exactly 3 distinct 'options', and 'recommended' matching one of the 3 options (the UI adds an Other free-text option automatically).";

function commentExcerpt(body: string): string {
  return body.length > COMMENT_NOTE_CHARS ? `${sliceWellFormed(body, COMMENT_NOTE_CHARS)}…` : body;
}

/** A ticket's workers, falling back to the legacy single assignee. */
function ticketWorkers(row: { workerBotIds: string[]; assigneeBotId: string | null }): string[] {
  return dedupeIds(
    row.workerBotIds.length > 0 ? row.workerBotIds : row.assigneeBotId ? [row.assigneeBotId] : [],
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function botCandidateHandles(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const primary = trimmed.split(/\s+[·-]\s+/)[0]?.trim() ?? trimmed;
  const compact = primary.replace(/[^A-Za-z0-9]+/g, "");
  const handles = new Set<string>();
  for (const candidate of [trimmed, primary, compact]) {
    if (candidate.length >= 2) handles.add(candidate);
  }
  return [...handles];
}

/**
 * Finds bots in the list that are @mentioned (or named after "blocked on" / "waiting on") in text.
 */
export function extractMentionedBotIds(
  text: string | null | undefined,
  bots: ReadonlyArray<{ id: string; name: string }>,
  excludeBotId?: string,
): string[] {
  if (!text?.trim()) return [];
  const matched: string[] = [];
  for (const bot of bots) {
    if (excludeBotId && bot.id === excludeBotId) continue;
    for (const handle of botCandidateHandles(bot.name)) {
      const escaped = escapeRegExp(handle);
      const atRe = new RegExp(`(?:^|[^\\w])@${escaped}(?=$|[^\\w])`, "i");
      const blockedRe = new RegExp(`\\b(?:blocked|waiting)\\s+on\\s+@?${escaped}(?=$|[^\\w])`, "i");
      if (atRe.test(text) || blockedRe.test(text)) {
        matched.push(bot.id);
        break;
      }
    }
  }
  return dedupeIds(matched);
}

/**
 * The bots a blocked ticket waits on: those @mentioned (or named after "blocked/waiting on") in its
 * title, description or latest comment, leaving out its own workers.
 */
export function ticketWaitingOnBotIds(
  ticket: {
    status: string;
    title: string;
    description: string | null;
    workerBotIds: string[];
    assigneeBotId: string | null;
  },
  latestCommentBody: string | undefined,
  bots: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  if (ticket.status !== "blocked") return [];
  const text = [ticket.title, ticket.description, latestCommentBody].filter(Boolean).join("\n");
  const workers = new Set(ticketWorkers(ticket));
  return extractMentionedBotIds(text, bots).filter((id) => !workers.has(id));
}

/**
 * Checks whether text mentions the user via @user, @me, @owner, @<UserName>, or "blocked/waiting on <UserName>".
 */
export function textMentionsUser(
  text: string | null | undefined,
  userNames: readonly string[] = [],
): boolean {
  if (!text?.trim()) return false;
  if (/(?:^|[^\w])@(?:user|me|owner|you)(?=$|[^\w])/i.test(text)) return true;
  if (/\b(?:blocked|waiting)\s+on\s+@?(?:user|me|owner|you)\b/i.test(text)) return true;
  for (const rawName of userNames) {
    const trimmed = rawName.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0]?.trim() ?? "";
    for (const candidate of [trimmed, first]) {
      if (candidate.length < 2) continue;
      const escaped = escapeRegExp(candidate);
      const atRe = new RegExp(`(?:^|[^\\w])@${escaped}(?=$|[^\\w])`, "i");
      const blockedRe = new RegExp(`\\b(?:blocked|waiting)\\s+on\\s+@?${escaped}(?=$|[^\\w])`, "i");
      if (atRe.test(text) || blockedRe.test(text)) return true;
    }
  }
  return false;
}

function hasAnyAtMentionToken(text: string | null | undefined): boolean {
  if (!text) return false;
  return /(?:^|[^\w])@[A-Za-z][A-Za-z0-9._-]*/.test(text);
}

function mayContainMention(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return text.includes("@") || /\b(?:blocked|waiting)\s+on\b/i.test(text);
}

async function loadSpaceMentionDirectory(
  deps: TicketToolDeps,
  spaceId: string,
  userId: string,
): Promise<{ bots: Array<{ id: string; name: string }>; userNames: string[] }> {
  const [bots, user] = await Promise.all([
    deps.prisma.bot?.findMany?.({
      where: { spaceId, archivedAt: null },
      select: { id: true, name: true },
    }) ?? Promise.resolve([]),
    deps.prisma.user?.findUnique?.({
      where: { id: userId },
      select: { name: true },
    }) ?? Promise.resolve(null),
  ]);
  const validBots = Array.isArray(bots)
    ? bots.filter((b): b is { id: string; name: string } =>
        Boolean(b && typeof b.id === "string" && typeof b.name === "string"),
      )
    : [];
  const userNames =
    user && typeof (user as { name?: unknown }).name === "string"
      ? [(user as { name: string }).name]
      : [];
  return { bots: validBots, userNames };
}

async function loadTicketValidationContext(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    ticketId?: string;
    ref?: string;
    description?: string | null;
  },
) {
  const texts: string[] = [];
  if (typeof input.description === "string" && input.description.trim()) {
    texts.push(input.description);
  }
  let hasStoredPendingDecision = false;
  let resolvedTicketId = input.ticketId;
  if (!resolvedTicketId && input.ref) {
    const board = await ensureBoard(deps.prisma, input.spaceId);
    const byRef = await findTicket(deps.prisma, input.spaceId, board, { ref: input.ref });
    if (byRef) resolvedTicketId = byRef.id;
  }
  if (resolvedTicketId) {
    const [existingTicket, comments] = await Promise.all([
      deps.prisma.ticket?.findFirst?.({
        where: { id: resolvedTicketId, spaceId: input.spaceId },
        select: { id: true, title: true, description: true, decision: true },
      }) ?? Promise.resolve(null),
      deps.prisma.ticketComment?.findMany?.({
        where: { ticketId: resolvedTicketId, spaceId: input.spaceId },
        select: { body: true },
      }) ?? Promise.resolve([]),
    ]);
    if (existingTicket) {
      const row = existingTicket as {
        id?: unknown;
        title?: unknown;
        description?: unknown;
        decision?: unknown;
      };
      if (typeof row.title === "string" && row.title.trim()) texts.push(row.title);
      if (input.description === undefined && typeof row.description === "string") {
        texts.push(row.description);
      }
      if (row.decision != null) {
        const parsed = TicketDecisionSchema.safeParse(row.decision);
        if (parsed.success && !parsed.data.answer) hasStoredPendingDecision = true;
      }
    }
    if (Array.isArray(comments)) {
      for (const c of comments) {
        if (c && typeof (c as { body?: unknown }).body === "string") {
          texts.push((c as { body: string }).body);
        }
      }
    }
  }
  return { combined: texts.join("\n"), hasStoredPendingDecision };
}

export async function validateBlockedTicketMention(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    userId: string;
    botId?: string;
    ticketId?: string;
    ref?: string;
    description?: string | null;
    decision?: TicketDecisionInput | null;
  },
): Promise<string | null> {
  if (input.decision) return null;
  const [{ bots, userNames }, { combined }] = await Promise.all([
    loadSpaceMentionDirectory(deps, input.spaceId, input.userId),
    loadTicketValidationContext(deps, input),
  ]);
  if (
    hasAnyAtMentionToken(combined) ||
    textMentionsUser(combined, userNames) ||
    extractMentionedBotIds(combined, bots, input.botId).length > 0
  ) {
    return null;
  }
  return BLOCKED_MENTION_ERROR;
}

export async function validateUserDecisionRequirement(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    userId: string;
    botId?: string;
    ticketId?: string;
    ref?: string;
    status?: string;
    title?: string;
    description?: string | null;
    decision?: TicketDecisionInput | null;
  },
): Promise<string | null> {
  if (!input.botId) return null;
  if (input.status !== "blocked" && input.status !== "review") return null;
  if (input.decision) return null;
  const [{ userNames }, { combined, hasStoredPendingDecision }] = await Promise.all([
    loadSpaceMentionDirectory(deps, input.spaceId, input.userId),
    loadTicketValidationContext(deps, input),
  ]);
  if (hasStoredPendingDecision && input.decision !== null) return null;
  const textWithTitle = [input.title, combined].filter(Boolean).join("\n");
  if (textMentionsUser(textWithTitle, userNames)) {
    return USER_DECISION_REQUIRED_ERROR;
  }
  return null;
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
    /** List only archived tickets; they are left out otherwise. */
    archived?: boolean;
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
      archivedAt: input.archived ? { not: null } : null,
      // Closed tickets are history; they only show up when asked for by status or in the archive.
      ...(status ? { status } : input.archived ? {} : { status: { not: "closed" } }),
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

function toDecisionJsonInput(decision: TicketDecision): Prisma.InputJsonObject {
  return {
    question: decision.question,
    options: decision.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.recommended ? { recommended: true } : {}),
    })),
    ...(decision.answer ? { answer: decision.answer } : {}),
    ...(decision.answeredAt ? { answeredAt: decision.answeredAt } : {}),
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
    decision?: TicketDecisionInput | null;
    pullRequests?: TicketPullRequestInput[];
    issues?: TicketIssueInput[];
    repository?: string | null;
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
  const { bots: spaceBots } = mayContainMention(data.description)
    ? await loadSpaceMentionDirectory(deps, input.spaceId, input.userId)
    : { bots: [] };
  const normalizedDecision = data.decision ? normalizeTicketDecision(data.decision) : undefined;
  const pullRequests = data.pullRequests ? mergeTicketLinks([], data.pullRequests) : [];
  // Linking work that already merged records finished work.
  const finished = pullRequestMergeFinishesTicket([], pullRequests);
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
        ...(normalizedDecision && !finished
          ? { decision: toDecisionJsonInput(normalizedDecision) }
          : {}),
        ...(data.pullRequests ? { pullRequests } : {}),
        ...(data.issues ? { issues: mergeTicketLinks([], data.issues) } : {}),
        ...(data.repository ? { repository: data.repository } : {}),
        ...(finished ? { status: "done", completedAt: new Date() } : {}),
      },
    });
  });
  const mentionedBots = extractMentionedBotIds(data.description, spaceBots, input.botId);
  const wakeBotIds = dedupeIds([
    ...workerBotIds.filter((id) => id !== input.botId),
    ...mentionedBots,
  ]);
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: wakeBotIds.length > 0,
    wakeBotIds,
    ...(mentionedBots.length > 0 && workerBotIds.filter((id) => id !== input.botId).length === 0
      ? {
          wakeNote:
            "You were mentioned on this ticket — read it with ticket_get and address what is needed from you.",
        }
      : {}),
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
    decision?: TicketDecisionInput | null;
    pullRequests?: TicketPullRequestInput[];
    issues?: TicketIssueInput[];
    repository?: string | null;
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

  if (input.botId && data.status === "blocked") {
    const mentionError = await validateBlockedTicketMention(deps, {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      ticketId: data.id,
      description: data.description,
      decision: data.decision,
    });
    if (mentionError) return { error: mentionError };
  }
  if (input.botId && (data.status === "blocked" || data.status === "review")) {
    const decisionError = await validateUserDecisionRequirement(deps, {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      ticketId: data.id,
      status: data.status,
      title: data.title,
      description: data.description,
      decision: data.decision,
    });
    if (decisionError) return { error: decisionError };
  }

  const { bots: spaceBots } = mayContainMention(data.description)
    ? await loadSpaceMentionDirectory(deps, input.spaceId, input.userId)
    : { bots: [] };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const normalizedDecision =
    data.decision !== undefined
      ? data.decision
        ? toDecisionJsonInput(normalizeTicketDecision(data.decision))
        : Prisma.DbNull
      : undefined;
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
    const storedPullRequests = data.pullRequests ? readStoredTicketPullRequests(current) : [];
    const pullRequests = data.pullRequests
      ? mergeTicketLinks(storedPullRequests, data.pullRequests)
      : undefined;
    // Recording a merge that leaves nothing open finishes the ticket, as the webhook does, unless
    // the same write sets a status itself.
    const finished =
      data.status === undefined &&
      pullRequests !== undefined &&
      !isTicketCompletedStatus(coerceTicketStatus(current.status)) &&
      pullRequestMergeFinishesTicket(storedPullRequests, pullRequests);
    const status: TicketStatus | undefined = finished ? "done" : data.status;
    const shouldClearPendingDecision =
      (normalizedDecision === undefined || finished) &&
      status !== undefined &&
      status !== "blocked" &&
      status !== "review" &&
      current.decision != null &&
      hasPendingTicketDecision({ decision: readTicketDecision(current) });
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
        // A finished ticket waits on nobody, so a question sent with the merge is dropped.
        ...(normalizedDecision !== undefined && !finished
          ? { decision: normalizedDecision }
          : shouldClearPendingDecision
            ? { decision: Prisma.DbNull }
            : {}),
        ...(pullRequests ? { pullRequests } : {}),
        ...(data.issues
          ? { issues: mergeTicketLinks(readStoredTicketIssues(current), data.issues) }
          : {}),
        ...(data.repository !== undefined ? { repository: data.repository } : {}),
        ...(status !== undefined
          ? {
              status,
              completedAt: isTicketCompletedStatus(status)
                ? (current.completedAt ?? new Date())
                : null,
              // Reopening takes a ticket back out of the archive.
              ...(isTicketCompletedStatus(status) ? {} : { archivedAt: null }),
            }
          : {}),
      },
    });
    const addedWorkers = nextWorkers
      ? nextWorkers.filter((id) => !prevWorkers.has(id) && id !== input.botId)
      : [];
    const statusChanged = data.status !== undefined && data.status !== current.status;
    return { row, addedWorkers, statusChanged };
  });
  if (!result) return { error: "Ticket not found." };
  // Moving a ticket to todo, doing or review asks its workers to pick it up, except the bot that
  // moved it. Blocked, done and closed ask for nothing.
  const statusWakes =
    result.statusChanged && data.status !== undefined && TICKET_WAKE_STATUSES.has(data.status)
      ? ticketWorkers(result.row).filter((id) => id !== input.botId)
      : [];
  const mentionedBots =
    data.description !== undefined
      ? extractMentionedBotIds(data.description, spaceBots, input.botId)
      : [];
  const wakeBotIds = dedupeIds([...result.addedWorkers, ...statusWakes, ...mentionedBots]);
  const wakeNote =
    statusWakes.length > 0
      ? `Its status changed to ${data.status}.`
      : mentionedBots.length > 0
        ? "You were mentioned on this ticket — read it with ticket_get and address what is needed from you."
        : undefined;
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: result.row.id,
    assigneeBotId: result.row.assigneeBotId,
    wakeAssignee: wakeBotIds.length > 0,
    wakeBotIds,
    ...(wakeNote ? { wakeNote } : {}),
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
  // A person's comment wakes the workers so a blocker can be answered. Any comment (by a person or
  // a bot) that @mentions another bot in the Space wakes that mentioned bot so it can address it.
  const { bots: spaceBots } = mayContainMention(parsed.data.body)
    ? await loadSpaceMentionDirectory(deps, input.spaceId, input.userId ?? "")
    : { bots: [] };
  const mentionedBots = extractMentionedBotIds(parsed.data.body, spaceBots, input.botId);
  const workerWakes = input.botId ? [] : ticketWorkers(ticket);
  const commentWakes = dedupeIds([...workerWakes, ...mentionedBots]);
  const excerpt = JSON.stringify(commentExcerpt(parsed.data.body));
  const wakeNote =
    commentWakes.length > 0
      ? input.botId
        ? `You were mentioned in a comment: ${excerpt}`
        : `A person commented: ${excerpt}`
      : undefined;
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: commentWakes.length > 0,
    wakeBotIds: commentWakes,
    ...(wakeNote ? { wakeNote } : {}),
  });
  return { comment: toTicketCommentDto(row) };
}

export async function decideTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    userId: string;
    ticketId: string;
    optionId?: string;
    customAnswer?: string;
  },
) {
  const parsed = DecideTicketInput.safeParse({
    ticketId: input.ticketId,
    optionId: input.optionId,
    customAnswer: input.customAnswer,
  });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;
  const board = await ensureBoard(deps.prisma, input.spaceId);

  const outcome = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${data.ticketId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const current = await tx.ticket.findFirst({
      where: { id: data.ticketId, spaceId: input.spaceId, boardId: board.id },
    });
    if (!current) return { error: "Ticket not found." as const };

    const existingDecision = readTicketDecision(current);
    let answerText: string;
    if (data.optionId) {
      const option = existingDecision?.options.find((item) => item.id === data.optionId);
      if (!option) return { error: "Decision option not found." as const };
      answerText = option.label;
    } else {
      answerText = data.customAnswer!;
    }

    const commentBody = existingDecision
      ? `> ${existingDecision.question}\n\n${data.optionId ? answerText : `Other: ${answerText}`}`
      : answerText;
    const now = new Date();
    const nextStatus =
      current.status === "blocked" || current.status === "review" ? "todo" : current.status;
    const nextDecision = existingDecision
      ? toDecisionJsonInput({
          ...existingDecision,
          answer: answerText,
          answeredAt: now.toISOString(),
        })
      : undefined;

    const updatedTicket = await tx.ticket.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        ...(nextStatus === "todo" ? { completedAt: null, archivedAt: null } : {}),
        ...(nextDecision ? { decision: nextDecision } : {}),
        updatedAt: now,
      },
    });
    const comment = await tx.ticketComment.create({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: {
        ticketId: current.id,
        spaceId: input.spaceId,
        authorBotId: null,
        authorUserId: input.userId,
        body: commentBody,
      },
    });
    return { error: null, updatedTicket, comment, answerText };
  });

  if (outcome.error !== null) return { error: outcome.error };
  const workers = ticketWorkers(outcome.updatedTicket);
  const wakeBotIds =
    workers.length > 0
      ? workers
      : outcome.updatedTicket.ownerBotId
        ? [outcome.updatedTicket.ownerBotId]
        : [];
  const excerpt = JSON.stringify(commentExcerpt(outcome.answerText));
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: outcome.updatedTicket.id,
    assigneeBotId: outcome.updatedTicket.assigneeBotId,
    wakeAssignee: wakeBotIds.length > 0,
    wakeBotIds,
    ...(wakeBotIds.length > 0 ? { wakeNote: `User answered decision: ${excerpt}` } : {}),
  });
  return {
    ticket: toTicketDto(outcome.updatedTicket, board.ticketPrefix),
    comment: toTicketCommentDto(outcome.comment),
  };
}
