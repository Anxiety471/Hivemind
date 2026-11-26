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
});
export type ToolCard = z.infer<typeof ToolCardSchema>;
