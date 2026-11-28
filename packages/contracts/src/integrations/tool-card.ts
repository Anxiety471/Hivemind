import * as z from "zod";

/** How a job is going: the card counts elapsed time while the job is still running. */
export const JobCardStateSchema = z.enum([
  "starting",
  "working",
  "finished",
  "needs_input",
  "exited",
  "timed_out",
]);
export type JobCardState = z.infer<typeof JobCardStateSchema>;

/** How much of a job's latest reply a card keeps; the card shows it folded to a few lines. */
export const JOB_CARD_REPLY_MAX_CHARS = 4_000;

/** How many changed files a card lists; the patch itself stays on the job's own host. */
export const JOB_CARD_MAX_FILES = 40;

/** How many of the most recent steps a card keeps; older steps fall off the front. */
export const JOB_CARD_MAX_STEPS = 30;

/** How much of one file's diff a card keeps: enough to read a hunk, never a whole patch. */
export const JOB_CARD_FILE_DIFF_MAX_CHARS = 4_000;

/** What happened to one file the job touched: git's own vocabulary. */
export const JobCardFileStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type JobCardFileStatus = z.infer<typeof JobCardFileStatusSchema>;

/** One file the job changed, with its line counts and an optional hunk of its diff. */
export const JobCardFileSchema = z.object({
  path: z.string().trim().min(1).max(400),
  status: JobCardFileStatusSchema.optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  diff: z.string().max(JOB_CARD_FILE_DIFF_MAX_CHARS).optional(),
});
export type JobCardFile = z.infer<typeof JobCardFileSchema>;

/** What one step of a job did: a tool call, a shell command, an edit, or a plain note. */
export const JobCardStepKindSchema = z.enum(["tool", "command", "edit", "note"]);
export type JobCardStepKind = z.infer<typeof JobCardStepKindSchema>;

/** How that step ended: still running, done, or failed. */
export const JobCardStepStatusSchema = z.enum(["running", "ok", "error"]);
export type JobCardStepStatus = z.infer<typeof JobCardStepStatusSchema>;

/** One step of the job, as the card lists it while the job works. */
export const JobCardStepSchema = z.object({
  kind: JobCardStepKindSchema.optional(),
  name: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(400).optional(),
  status: JobCardStepStatusSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type JobCardStep = z.infer<typeof JobCardStepSchema>;

/** The job's own totals: files and lines changed, work done, and what it cost. */
export const JobCardStatsSchema = z.object({
  filesChanged: z.number().int().nonnegative().optional(),
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type JobCardStats = z.infer<typeof JobCardStatsSchema>;

/** The key a tool result carries its card under, inside `structuredContent`. */
export const TOOL_CARD_KEY = "card";

/**
 * A job card: one long-running job a tool started somewhere else, such as a coding agent on
 * another machine. Any tool result may carry one at `structuredContent.card`, so the card is the
 * same whatever started the job; a malformed card is dropped, never shown half-read.
 */
export const ToolCardSchema = z.object({
  kind: z.literal("job"),
  /** The job's own id. Cards for the same job read as the same job. */
  jobId: z.string().trim().min(1).max(200),
  /** What the job is called: a workspace, repository or task name. */
  title: z.string().trim().min(1).max(200),
  /** Who is doing the work, such as the coding agent's name. */
  agent: z.string().trim().min(1).max(80).optional(),
  branch: z.string().trim().min(1).max(240).optional(),
  state: JobCardStateSchema,
  /** When the job started, epoch milliseconds. A live card counts from here. */
  startedAt: z.number().int().nonnegative().optional(),
  /** Where to open the job. Only an https address without credentials is kept. */
  url: z.string().trim().max(2_048).optional(),
  /**
   * The job's latest reply, as a preview when it has finished. Its own words, capped at
   * `JOB_CARD_REPLY_MAX_CHARS`.
   */
  reply: z.string().trim().max(JOB_CARD_REPLY_MAX_CHARS).optional(),
  /** When the job finished, epoch milliseconds. Absent while it still runs. */
  finishedAt: z.number().int().nonnegative().optional(),
  /** Which turn of the workspace's conversation this job is. */
  turn: z.number().int().positive().optional(),
  /** The repository the job works in, as `owner/name`. */
  repo: z.string().trim().min(1).max(120).optional(),
  /** Where the job's checkout lives on its own host. */
  workspacePath: z.string().trim().min(1).max(400).optional(),
  /** The commit the job produced or is working from. */
  commit: z.string().trim().min(1).max(40).optional(),
  /** The model doing the work, as the job names it. */
  model: z.string().trim().min(1).max(120).optional(),
  /** How hard that model is thinking, as the job names it. */
  effort: z.string().trim().min(1).max(40).optional(),
  /** One line on what the job set out to do or what it concluded. */
  summary: z.string().trim().min(1).max(400).optional(),
  /** What the job is doing right now, one line, while it works. */
  currentActivity: z.string().trim().min(1).max(240).optional(),
  /** Why the job stopped badly. Absent unless it failed. */
  error: z.string().trim().min(1).max(600).optional(),
  /** The pull request the job opened. Only an https address without credentials is kept. */
  prUrl: z.string().trim().max(2_048).optional(),
  /** The pull request's number or label, such as `#812`. */
  prLabel: z.string().trim().min(1).max(80).optional(),
  /** The job's totals, for the card's summary line. */
  stats: JobCardStatsSchema.optional(),
  /** The files the job changed, most important first, capped at `JOB_CARD_MAX_FILES`. */
  files: z.array(JobCardFileSchema).max(JOB_CARD_MAX_FILES).optional(),
  /** The job's most recent steps, oldest first, capped at `JOB_CARD_MAX_STEPS`. */
  steps: z.array(JobCardStepSchema).max(JOB_CARD_MAX_STEPS).optional(),
});
export type ToolCard = z.infer<typeof ToolCardSchema>;
