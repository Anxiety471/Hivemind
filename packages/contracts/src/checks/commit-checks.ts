import * as z from "zod";
import { IsoDate } from "../ids.js";

/** Host and full repository name, lowercased, such as `host.example/owner/repo`. */
export const CommitCheckRepository = z
  .string()
  .min(5)
  .max(300)
  .regex(/^[^/\s]+\/[^/\s]+\/[^/\s]+$/);

export const CommitCheckSha = z.string().regex(/^[0-9a-f]{7,64}$/);

/** One check of a commit. `skipped` covers neutral and skipped results and counts as passed. */
export const CommitCheckState = z.enum(["queued", "running", "passed", "failed", "skipped"]);
export type CommitCheckState = z.infer<typeof CommitCheckState>;

export const CommitCheckSchema = z.object({
  name: z.string().max(300),
  state: CommitCheckState,
  url: z.string().nullable(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
});
export type CommitCheck = z.infer<typeof CommitCheckSchema>;

/** The most targets one read names; a thread with more links asks in pieces. */
export const COMMIT_CHECK_TARGETS_MAX = 50;
