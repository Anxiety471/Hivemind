import type { CommitCheck, CommitCheckState } from "@rakazo/contracts";
import { CommitCheckState as CommitCheckStateSchema } from "@rakazo/contracts";
import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";

/** One check run as a code host reported it, already reduced to the states the app shows. */
export type CommitCheckReport = {
  spaceId: string;
  repository: string;
  headSha: string;
  name: string;
  /** Newer check runs have larger ids; a re-run gets a new one. */
  checkRunId: bigint;
  state: CommitCheckState;
  url: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type PullRequestHeadReport = {
  spaceId: string;
  repository: string;
  number: number;
  headSha: string;
  /** The pull request's own last-updated time from the event. */
  updatedAt: Date;
};

// Progress through a check run: queued, then running, then finished. The same run only moves forward.
const STATE_RANK = `CASE {state} WHEN 'queued' THEN 0 WHEN 'running' THEN 1 ELSE 2 END`;

/**
 * Records a check report in one statement. A row keeps the newest check run for its name, and a
 * later state of that run. Older runs, older states and repeated deliveries change nothing, so
 * the return is false for them and the caller sends no signal.
 */
export async function recordCommitCheck(
  prisma: Pick<PrismaClient, "$executeRaw">,
  report: CommitCheckReport,
): Promise<boolean> {
  const incomingRank = STATE_RANK.replace("{state}", "EXCLUDED.state");
  const storedRank = STATE_RANK.replace("{state}", "commit_checks.state");
  const changed = await prisma.$executeRaw`
    INSERT INTO commit_checks ("spaceId", "repository", "headSha", "name", "checkRunId", "state", "url", "startedAt", "completedAt")
    VALUES (${report.spaceId}, ${report.repository}, ${report.headSha}, ${report.name}, ${report.checkRunId}, ${report.state}, ${report.url}, ${report.startedAt}, ${report.completedAt})
    ON CONFLICT ("spaceId", "repository", "headSha", "name") DO UPDATE SET
      "checkRunId" = EXCLUDED."checkRunId",
      "state" = EXCLUDED."state",
      "url" = EXCLUDED."url",
      "startedAt" = EXCLUDED."startedAt",
      "completedAt" = EXCLUDED."completedAt"
    WHERE EXCLUDED."checkRunId" > commit_checks."checkRunId"
      OR (EXCLUDED."checkRunId" = commit_checks."checkRunId" AND ${Prisma.raw(incomingRank)} > ${Prisma.raw(storedRank)})`;
  return changed > 0;
}

/** Records the head commit a pull request now points at, unless an event at least as new already did. */
export async function recordPullRequestHead(
  prisma: Pick<PrismaClient, "$executeRaw">,
  report: PullRequestHeadReport,
): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    INSERT INTO pull_request_heads ("spaceId", "repository", "number", "headSha", "updatedAt")
    VALUES (${report.spaceId}, ${report.repository}, ${report.number}, ${report.headSha}, ${report.updatedAt})
    ON CONFLICT ("spaceId", "repository", "number") DO UPDATE SET
      "headSha" = EXCLUDED."headSha",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE EXCLUDED."updatedAt" > pull_request_heads."updatedAt"`;
  return changed > 0;
}

export type CommitCheckTargets = {
  commits: Array<{ repository: string; sha: string }>;
  pullRequests: Array<{ repository: string; number: number }>;
};

export type CommitChecksResult = {
  commits: Array<{ repository: string; sha: string; checks: CommitCheck[] }>;
  pullRequests: Array<{
    repository: string;
    number: number;
    sha: string | null;
    checks: CommitCheck[];
  }>;
};

/** The checks for the named commits and the head commits of the named pull requests, in one Space. */
export async function listCommitChecks(
  prisma: Pick<PrismaClient, "commitCheck" | "pullRequestHead">,
  spaceId: string,
  targets: CommitCheckTargets,
): Promise<CommitChecksResult> {
  const heads =
    targets.pullRequests.length === 0
      ? []
      : await prisma.pullRequestHead.findMany({
          where: {
            spaceId,
            OR: targets.pullRequests.map((pr) => ({
              repository: pr.repository,
              number: pr.number,
            })),
          },
          select: { repository: true, number: true, headSha: true },
        });
  const shaTargets = [
    ...targets.commits,
    ...heads.map((head) => ({ repository: head.repository, sha: head.headSha })),
  ];
  const rows =
    shaTargets.length === 0
      ? []
      : await prisma.commitCheck.findMany({
          where: {
            spaceId,
            OR: shaTargets.map((target) => ({
              repository: target.repository,
              headSha: target.sha,
            })),
          },
          orderBy: { name: "asc" },
        });
  const checksFor = (repository: string, sha: string): CommitCheck[] =>
    rows.flatMap((row) => {
      const state = CommitCheckStateSchema.safeParse(row.state);
      if (row.repository !== repository || row.headSha !== sha || !state.success) return [];
      return [
        {
          name: row.name,
          state: state.data,
          url: row.url,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
        },
      ];
    });
  return {
    commits: targets.commits.map((target) => ({
      repository: target.repository,
      sha: target.sha,
      checks: checksFor(target.repository, target.sha),
    })),
    pullRequests: targets.pullRequests.map((target) => {
      const head = heads.find(
        (row) => row.repository === target.repository && row.number === target.number,
      );
      return {
        repository: target.repository,
        number: target.number,
        sha: head?.headSha ?? null,
        checks: head ? checksFor(target.repository, head.headSha) : [],
      };
    }),
  };
}
