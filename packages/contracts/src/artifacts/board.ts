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
export const TICKET_MAX_PULL_REQUESTS = 10;
const TICKET_PULL_REQUEST_URL_MAX_LENGTH = 500;

// Host, repository path, an optional "-/" segment, the pull or merge request kind and its number.
// Anything after the number (a tab such as /files, a query, a fragment) is dropped. Kept to the
// RE2 subset so the Go API normalizes the same way (apps/api-go/internal/procedures/tickets).
const PULL_REQUEST_URL =
  /^https:\/\/([a-z0-9.-]+)((?:\/[a-z0-9_.~-]+)+?)\/(-\/)?(pull|pulls|merge_requests|pull-requests)\/([1-9][0-9]{0,9})(?:[/?#].*)?$/;

/**
 * The one form a pull request link is stored and matched in: lowercase, https, ending at the
 * number. Null when the text is not a pull or merge request link.
 */
export function normalizePullRequestUrl(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text.length > TICKET_PULL_REQUEST_URL_MAX_LENGTH) return null;
  const match = PULL_REQUEST_URL.exec(text);
  if (!match) return null;
  const [, host, repoPath, dash, kind, number] = match;
  return `https://${host}${repoPath}/${dash ?? ""}${kind}/${number}`;
}

/** Short name for a stored link: the last two repository path segments and the number. */
export function pullRequestLabel(url: string): string {
  const match = PULL_REQUEST_URL.exec(url);
  if (!match) return url;
  const [, , repoPath = "", , , number] = match;
  return `${repoPath.split("/").slice(-2).join("/")}#${number}`;
}

export const TicketPullRequestSchema = z.object({
  url: z.string(),
  state: TicketPullRequestStateSchema,
});
export type TicketPullRequest = z.infer<typeof TicketPullRequestSchema>;

export const TicketPullRequestInputSchema = z.object({
  url: z
    .string()
    .max(TICKET_PULL_REQUEST_URL_MAX_LENGTH)
    .transform((value, ctx) => {
      const url = normalizePullRequestUrl(value);
      if (url) return url;
      ctx.addIssue({
        code: "custom",
        message: "Use a pull request link such as https://example.com/owner/repo/pull/12.",
      });
      return z.NEVER;
    }),
  /** Left out keeps the state already recorded for that link, or open for a new one. */
  state: TicketPullRequestStateSchema.optional(),
});
export type TicketPullRequestInput = z.input<typeof TicketPullRequestInputSchema>;

/**
 * The links a ticket keeps after an input list replaces them: the input's order with duplicates
 * dropped, each keeping its recorded state unless the input sets one.
 */
export function mergeTicketPullRequests(
  current: readonly TicketPullRequest[],
  input: ReadonlyArray<{ url: string; state?: TicketPullRequestState | undefined }>,
): TicketPullRequest[] {
  const known = new Map(current.map((item) => [item.url, item.state]));
  const next = new Map<string, TicketPullRequestState>();
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

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.ticketPrefix !== undefined, {
    message: "Provide a name or ticketPrefix",
  });
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
