import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  COMMIT_CHECK_TARGETS_MAX,
  CommitCheckRepository,
  CommitCheckSchema,
  CommitCheckSha,
} from "./commit-checks.js";

export const commitChecksRpc = {
  commitChecks: {
    /** Checks for the commits and pull request heads a thread links to, within the caller's Space. */
    list: oc
      .input(
        z.object({
          commits: z
            .array(z.object({ repository: CommitCheckRepository, sha: CommitCheckSha }))
            .max(COMMIT_CHECK_TARGETS_MAX),
          pullRequests: z
            .array(
              z.object({
                repository: CommitCheckRepository,
                number: z.number().int().positive(),
              }),
            )
            .max(COMMIT_CHECK_TARGETS_MAX),
        }),
      )
      .output(
        z.object({
          commits: z.array(
            z.object({
              repository: CommitCheckRepository,
              sha: CommitCheckSha,
              checks: z.array(CommitCheckSchema),
            }),
          ),
          /** `sha` is the pull request's head commit, or null when no event has named one yet. */
          pullRequests: z.array(
            z.object({
              repository: CommitCheckRepository,
              number: z.number().int().positive(),
              sha: CommitCheckSha.nullable(),
              checks: z.array(CommitCheckSchema),
            }),
          ),
        }),
      ),
  },
};
