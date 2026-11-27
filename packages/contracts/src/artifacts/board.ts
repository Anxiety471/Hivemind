import * as z from "zod";
import { Id } from "../ids.js";

export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** `done` is finished-but-open for review; `closed` is terminal, so both stamp completion. */
export function isTicketCompletedStatus(status: TicketStatus): boolean {
  return status === "done" || status === "closed";
}

/** A done or closed ticket moves to the archive this many days after it was completed. */
export const TICKET_ARCHIVE_AFTER_DAYS = 7;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_DESCRIPTION_MAX_LENGTH = 20_000;
export const TICKET_MAX_WORKERS = 20;
const TICKET_PREFIX_MAX_LENGTH = 12;
// Ticket numbers are stored as PostgreSQL Int values.
const TICKET_NUMBER_MAX = 2_147_483_647;
export const TICKET_COMMENT_MAX_LENGTH = 10_000;
export const TICKET_DECISION_OPTION_COUNT = 3;
export const TICKET_DECISION_QUESTION_MAX_LENGTH = 300;
export const TICKET_DECISION_OPTION_MAX_LENGTH = 160;
export const TICKET_DECISION_ANSWER_MAX_LENGTH = 2_000;

export const TicketDecisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(TICKET_DECISION_OPTION_MAX_LENGTH),
  recommended: z.boolean().optional(),
});
export type TicketDecisionOption = z.infer<typeof TicketDecisionOptionSchema>;

export const TicketDecisionSchema = z.object({
  question: z.string().trim().min(1).max(TICKET_DECISION_QUESTION_MAX_LENGTH),
  options: z.array(TicketDecisionOptionSchema).length(TICKET_DECISION_OPTION_COUNT),
  answer: z.string().trim().min(1).max(TICKET_DECISION_ANSWER_MAX_LENGTH).optional(),
  answeredAt: z.string().optional(),
});
export type TicketDecision = z.infer<typeof TicketDecisionSchema>;

export const TicketDecisionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(TICKET_DECISION_QUESTION_MAX_LENGTH),
    options: z
      .array(z.string().trim().min(1).max(TICKET_DECISION_OPTION_MAX_LENGTH))
      .length(TICKET_DECISION_OPTION_COUNT),
    recommended: z.string().trim().min(1).max(TICKET_DECISION_OPTION_MAX_LENGTH),
  })
  .superRefine((value, ctx) => {
    const normalized = value.options.map((item) => item.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "Decision options must be 3 distinct non-empty choices.",
      });
    }
    const rec = value.recommended.toLowerCase();
    if (!normalized.includes(rec)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommended"],
        message: "Recommended option must match one of the 3 options.",
      });
    }
  });
export type TicketDecisionInput = z.infer<typeof TicketDecisionInputSchema>;

export function normalizeTicketDecision(input: TicketDecisionInput): TicketDecision {
  const recommendedLower = input.recommended.trim().toLowerCase();
  const recommendedIndex = input.options.findIndex(
    (option) => option.trim().toLowerCase() === recommendedLower,
  );
  return {
    question: input.question.trim(),
    options: input.options.map((option, index) => ({
      id: `choice-${index + 1}`,
      label: option.trim(),
      ...(index === Math.max(recommendedIndex, 0) ? { recommended: true } : {}),
    })),
  };
}

export function hasPendingTicketDecision(ticket: { decision?: TicketDecision | null }): boolean {
  return Boolean(ticket.decision && !ticket.decision.answer);
}

export const TICKET_PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export const TicketPullRequestStateSchema = z.enum(TICKET_PULL_REQUEST_STATES);
export type TicketPullRequestState = z.infer<typeof TicketPullRequestStateSchema>;
export const TICKET_ISSUE_STATES = ["open", "closed"] as const;
export const TicketIssueStateSchema = z.enum(TICKET_ISSUE_STATES);
export type TicketIssueState = z.infer<typeof TicketIssueStateSchema>;
export const TICKET_MAX_PULL_REQUESTS = 10;
export const TICKET_MAX_ISSUES = 10;
const TICKET_LINK_URL_MAX_LENGTH = 500;

// Host, repository path, an optional "-/" segment, the item kind and its number. Anything after
// the number (a tab such as /files, a query, a fragment) is dropped. Kept to the RE2 subset so the
// Go API normalizes the same way (apps/api-go/internal/procedures/tickets).
const TICKET_ITEM_URL =
  /^https:\/\/([a-z0-9.-]+)((?:\/[a-z0-9_.~-]+)+?)\/(-\/)?(pull|pulls|merge_requests|pull-requests|issues)\/([1-9][0-9]{0,9})(?:[/?#].*)?$/;
// Host and a repository path of 2 to 8 segments, with an optional trailing slash, query or fragment.
const REPOSITORY_URL = /^https:\/\/([a-z0-9.-]+)((?:\/[a-z0-9_.~-]+){2,8})\/?(?:[?#].*)?$/;

function normalizeItemUrl(value: string, issue: boolean): string | null {
  const text = value.trim().toLowerCase();
  if (text.length > TICKET_LINK_URL_MAX_LENGTH) return null;
  const match = TICKET_ITEM_URL.exec(text);
  if (!match) return null;
  const [, host, repoPath, dash, kind, number] = match;
  if ((kind === "issues") !== issue) return null;
  return `https://${host}${repoPath}/${dash ?? ""}${kind}/${number}`;
}

/**
 * The one form a pull request link is stored and matched in: lowercase, https, ending at the
 * number. Null when the text is not a pull or merge request link.
 */
export function normalizePullRequestUrl(value: string): string | null {
  return normalizeItemUrl(value, false);
}

/** The one form an issue link is stored and matched in, like normalizePullRequestUrl. */
export function normalizeIssueUrl(value: string): string | null {
  return normalizeItemUrl(value, true);
}

/**
 * The one form a repository link is stored in: lowercase, https, the repository path without a
 * trailing ".git" or slash. Null when the text is not a repository home page link, including a
 * pull request or issue link.
 */
export function normalizeRepositoryUrl(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text.length > TICKET_LINK_URL_MAX_LENGTH || TICKET_ITEM_URL.test(text)) return null;
  const match = REPOSITORY_URL.exec(text);
  if (!match) return null;
  const [, host, repoPath = ""] = match;
  const path = repoPath.endsWith(".git") ? repoPath.slice(0, -4) : repoPath;
  // A last segment of exactly ".git" leaves nothing to name the repository.
  return path.endsWith("/") ? null : `https://${host}${path}`;
}

/**
 * Short name for a stored link: the last two repository path segments and the number for a pull
 * request or issue, the repository path for a repository.
 */
export function ticketLinkLabel(url: string): string {
  const item = TICKET_ITEM_URL.exec(url);
  if (item) {
    const [, , repoPath = "", , , number] = item;
    return `${repoPath.split("/").slice(-2).join("/")}#${number}`;
  }
  const repository = REPOSITORY_URL.exec(url);
  return repository?.[2] ? repository[2].slice(1) : url;
}

function linkUrlInput(normalize: (value: string) => string | null, message: string) {
  return z
    .string()
    .max(TICKET_LINK_URL_MAX_LENGTH)
    .transform((value, ctx) => {
      const url = normalize(value);
      if (url) return url;
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    });
}

export const TicketPullRequestSchema = z.object({
  url: z.string(),
  state: TicketPullRequestStateSchema,
});
export type TicketPullRequest = z.infer<typeof TicketPullRequestSchema>;

export const TicketPullRequestInputSchema = z.object({
  url: linkUrlInput(
    normalizePullRequestUrl,
    "Use a pull request link such as https://example.com/owner/repo/pull/12.",
  ),
  /** Left out keeps the state already recorded for that link, or open for a new one. */
  state: TicketPullRequestStateSchema.optional(),
});
export type TicketPullRequestInput = z.input<typeof TicketPullRequestInputSchema>;

export const TicketIssueSchema = z.object({
  url: z.string(),
  state: TicketIssueStateSchema,
});
export type TicketIssue = z.infer<typeof TicketIssueSchema>;

export const TicketIssueInputSchema = z.object({
  url: linkUrlInput(
    normalizeIssueUrl,
    "Use an issue link such as https://example.com/owner/repo/issues/12.",
  ),
  /** Left out keeps the state already recorded for that link, or open for a new one. */
  state: TicketIssueStateSchema.optional(),
});
export type TicketIssueInput = z.input<typeof TicketIssueInputSchema>;

export const TicketRepositoryInputSchema = linkUrlInput(
  normalizeRepositoryUrl,
  "Use a repository link such as https://example.com/owner/repo.",
);

/**
 * The links a ticket keeps after an input list replaces them: the input's order with duplicates
 * dropped, each keeping its recorded state unless the input sets one. A new link starts open.
 */
export function mergeTicketLinks<State extends string>(
  current: ReadonlyArray<{ url: string; state: State }>,
  input: ReadonlyArray<{ url: string; state?: State | undefined }>,
): Array<{ url: string; state: State | "open" }> {
  const known = new Map(current.map((item) => [item.url, item.state]));
  const next = new Map<string, State | "open">();
  for (const item of input) {
    if (next.has(item.url)) continue;
    next.set(item.url, item.state ?? known.get(item.url) ?? "open");
  }
  return [...next].map(([url, state]) => ({ url, state }));
}

/**
 * Whether a write that turns a ticket's links from `before` into `after` finishes its work: it
 * records a merge the ticket did not have, and no linked pull request is left open.
 */
export function pullRequestMergeFinishesTicket(
  before: readonly TicketPullRequest[],
  after: readonly TicketPullRequest[],
): boolean {
  const merged = new Set(before.filter((item) => item.state === "merged").map((item) => item.url));
  return (
    after.some((item) => item.state === "merged" && !merged.has(item.url)) &&
    after.every((item) => item.state !== "open")
  );
}

const TicketPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_PREFIX_MAX_LENGTH)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Prefix must start with a letter and contain only letters and digits",
  );

export function ticketRef(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export function parseTicketRef(
  value: string,
  expectedPrefix?: string,
): { prefix: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawPrefix, rawNumber] = match;
  if (!rawPrefix || !rawNumber) return null;
  const prefix = rawPrefix.toUpperCase();
  if (expectedPrefix !== undefined && prefix !== expectedPrefix.trim().toUpperCase()) return null;
  const number = Number(rawNumber);
  if (number > TICKET_NUMBER_MAX) return null;
  return { prefix, number };
}

export const BOARD_MAX_REPOSITORIES = 20;
export const BOARD_REPOSITORY_MAX_ALIASES = 10;
export const BOARD_REPOSITORY_ALIAS_MAX_LENGTH = 40;

export const BoardRepositoryAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(BOARD_REPOSITORY_ALIAS_MAX_LENGTH)
  .refine((value) => !/[\r\n\t]/.test(value), "Alias cannot contain line breaks");

export const BoardRepositorySchema = z.object({
  url: z.string(),
  aliases: z.array(z.string()),
  isDefault: z.boolean(),
});
export type BoardRepository = z.infer<typeof BoardRepositorySchema>;

export const BoardRepositoryInputSchema = z.object({
  url: TicketRepositoryInputSchema,
  aliases: z
    .array(BoardRepositoryAliasSchema)
    .max(BOARD_REPOSITORY_MAX_ALIASES)
    .optional()
    .default([]),
  isDefault: z.boolean().optional().default(false),
});
export type BoardRepositoryInput = z.infer<typeof BoardRepositoryInputSchema>;

/**
 * The one form a board's repositories are stored in: one entry per repository URL (the first
 * wins), aliases trimmed and deduplicated case-insensitively (first casing kept), and at most one
 * default (the first marked one).
 */
export function normalizeBoardRepositories(
  input: readonly z.output<typeof BoardRepositoryInputSchema>[],
): BoardRepository[] {
  const seen = new Set<string>();
  const out: BoardRepository[] = [];
  let hasDefault = false;
  for (const entry of input) {
    if (out.length >= BOARD_MAX_REPOSITORIES) break;
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    const aliasKeys = new Set<string>();
    const aliases: string[] = [];
    for (const alias of entry.aliases) {
      const trimmed = alias.trim();
      const key = trimmed.toLowerCase();
      if (aliasKeys.has(key)) continue;
      aliasKeys.add(key);
      aliases.push(trimmed);
    }
    const isDefault: boolean = entry.isDefault && !hasDefault;
    hasDefault = hasDefault || isDefault;
    out.push({ url: entry.url, aliases, isDefault });
  }
  return out;
}

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  /** Repositories the board's work lives in, the default first when one is marked. */
  repositories: z.array(BoardRepositorySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
    repositories: z.array(BoardRepositoryInputSchema).max(BOARD_MAX_REPOSITORIES).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.ticketPrefix !== undefined ||
      value.repositories !== undefined,
    { message: "Provide a name or ticketPrefix" },
  );
export type RenameBoardInput = z.infer<typeof RenameBoardInput>;

export const TicketCommentSchema = z.object({
  id: Id,
  ticketId: Id,
  body: z.string(),
  authorBotId: Id.nullable(),
  authorUserId: Id.nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

export const TicketSchema = z.object({
  id: Id,
  boardId: Id,
  spaceId: Id,
  number: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: Id.nullable(),
  ownerUserId: Id.nullable(),
  ownerBotId: Id.nullable(),
  workerBotIds: z.array(Id),
  createdByBotId: Id.nullable(),
  createdByUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  decision: TicketDecisionSchema.optional(),
  /** Pull or merge requests the ticket tracks, in the order they were linked. */
  pullRequests: z.array(TicketPullRequestSchema),
  /** Issues the ticket tracks, in the order they were linked. */
  issues: z.array(TicketIssueSchema),
  /** Repository the ticket's work lives in. */
  repository: z.string().nullable(),
  mentionsMe: z.boolean().optional(),
  /**
   * Bots a blocked ticket waits on, from the @mentions in its title, description and latest
   * comment, leaving out its own workers. Set by tickets.list.
   */
  waitingOnBotIds: z.array(Id).optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsInput = z.object({
  boardId: Id.optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  workerBotId: Id.optional(),
  ownerBotId: Id.optional(),
  ownerUserId: Id.optional(),
  q: z.string().trim().max(200).optional(),
  /** Archived tickets are left out unless this is true, which lists only them. */
  archived: z.boolean().optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsInput>;

export const ListTicketsOutput = z.object({ tickets: z.array(TicketSchema) });
export type ListTicketsOutput = z.infer<typeof ListTicketsOutput>;

export const GetTicketInput = z
  .object({
    id: Id.optional(),
    ref: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.id) !== Boolean(value.ref), {
    message: "Provide exactly one of id or ref",
  });
export type GetTicketInput = z.infer<typeof GetTicketInput>;

export const CreateTicketInput = z
  .object({
    boardId: Id.optional(),
    title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
    description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
    priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
    ownerUserId: Id.nullable().optional(),
    ownerBotId: Id.nullable().optional(),
    workerBotIds: z.array(Id).max(TICKET_MAX_WORKERS).optional(),
    assigneeBotId: Id.nullable().optional(),
    decision: TicketDecisionInputSchema.nullable().optional(),
    pullRequests: z.array(TicketPullRequestInputSchema).max(TICKET_MAX_PULL_REQUESTS).optional(),
    issues: z.array(TicketIssueInputSchema).max(TICKET_MAX_ISSUES).optional(),
    repository: TicketRepositoryInputSchema.nullable().optional(),
  })
  .refine((value) => !(value.ownerUserId && value.ownerBotId), {
    message: "Specify at most one of ownerUserId or ownerBotId",
    path: ["ownerBotId"],
  });
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const UpdateTicketInput = z
  .object({
    id: Id,
    title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
    description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).nullable().optional(),
    priority: TicketPrioritySchema.nullable().optional(),
    status: TicketStatusSchema.optional(),
    ownerUserId: Id.nullable().optional(),
    ownerBotId: Id.nullable().optional(),
    workerBotIds: z.array(Id).max(TICKET_MAX_WORKERS).optional(),
    assigneeBotId: Id.nullable().optional(),
    decision: TicketDecisionInputSchema.nullable().optional(),
    /** Replaces the linked pull requests; a link left out is unlinked. */
    pullRequests: z.array(TicketPullRequestInputSchema).max(TICKET_MAX_PULL_REQUESTS).optional(),
    /** Replaces the linked issues; a link left out is unlinked. */
    issues: z.array(TicketIssueInputSchema).max(TICKET_MAX_ISSUES).optional(),
    /** Null removes the repository link. */
    repository: TicketRepositoryInputSchema.nullable().optional(),
  })
  .refine((value) => !(value.ownerUserId && value.ownerBotId), {
    message: "Specify at most one of ownerUserId or ownerBotId",
    path: ["ownerBotId"],
  });
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

export const MoveTicketInput = z.object({
  id: Id,
  status: TicketStatusSchema,
});
export type MoveTicketInput = z.infer<typeof MoveTicketInput>;

export const CommentTicketInput = z.object({
  ticketId: Id,
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX_LENGTH),
});
export type CommentTicketInput = z.infer<typeof CommentTicketInput>;

export const DecideTicketInput = z
  .object({
    ticketId: Id,
    optionId: z.string().trim().min(1).max(64).optional(),
    customAnswer: z.string().trim().min(1).max(TICKET_DECISION_ANSWER_MAX_LENGTH).optional(),
  })
  .refine((value) => Boolean(value.optionId) !== Boolean(value.customAnswer), {
    message: "Provide exactly one of optionId or customAnswer",
  });
export type DecideTicketInput = z.infer<typeof DecideTicketInput>;

export const DecideTicketOutput = z.object({
  ticket: TicketSchema,
  comment: TicketCommentSchema,
});
export type DecideTicketOutput = z.infer<typeof DecideTicketOutput>;

export const BoardEventSchema = z.object({
  spaceId: Id,
  boardId: Id.optional(),
  ticketId: Id.optional(),
  createdAt: z.string(),
  /** Liveness only: the stream's periodic frame on a quiet board, which changes nothing. */
  heartbeat: z.boolean().optional(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;
