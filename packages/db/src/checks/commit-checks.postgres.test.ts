import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { runAsSystem, runAsTenant } from "../database/row-security.js";
import { listCommitChecks, recordCommitCheck, recordPullRequestHead } from "./commit-checks.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("commit checks (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `checks-org-${suffix}`;
  const userId = `checks-user-${suffix}`;
  const spaceId = `checks-space-${suffix}`;
  const otherSpaceId = `checks-other-${suffix}`;
  const repository = `host.example/acme/app`;
  const sha = "a".repeat(40);
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await runAsSystem("commit checks test fixture", async () => {
      await prisma.organization.create({
        data: { id: organizationId, name: "Checks", slug: organizationId, createdAt: new Date() },
      });
      await prisma.user.create({
        data: {
          id: userId,
          name: "Checks",
          email: `${userId}@rakazo.test`,
          emailVerified: false,
        },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "A" } });
      await prisma.space.create({ data: { id: otherSpaceId, organizationId, name: "B" } });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await runAsSystem("commit checks test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });
    await close();
  });

  const report = (overrides: Partial<Parameters<typeof recordCommitCheck>[1]> = {}) => ({
    spaceId,
    repository,
    headSha: sha,
    name: "build",
    checkRunId: 100n,
    state: "queued" as const,
    url: "https://host.example/acme/app/runs/100",
    startedAt: null,
    completedAt: null,
    ...overrides,
  });

  const stored = () =>
    runAsSystem("read", () =>
      prisma.commitCheck.findUnique({
        where: {
          spaceId_repository_headSha_name: { spaceId, repository, headSha: sha, name: "build" },
        },
      }),
    );

  it("moves one run forward and ignores repeats and older states", async () => {
    await runAsSystem("write", async () => {
      expect(await recordCommitCheck(prisma, report())).toBe(true);
      expect(await recordCommitCheck(prisma, report({ state: "running" }))).toBe(true);
      expect(await recordCommitCheck(prisma, report({ state: "running" }))).toBe(false);
      expect(await recordCommitCheck(prisma, report({ state: "queued" }))).toBe(false);
      expect(
        await recordCommitCheck(
          prisma,
          report({ state: "passed", completedAt: new Date("2026-01-01T00:00:00Z") }),
        ),
      ).toBe(true);
      // A duplicate of the final delivery, and a late in-progress one, change nothing.
      expect(await recordCommitCheck(prisma, report({ state: "passed" }))).toBe(false);
      expect(await recordCommitCheck(prisma, report({ state: "running" }))).toBe(false);
    });
    expect((await stored())?.state).toBe("passed");
  });

  it("replaces a finished run with a re-run, and never with an older run", async () => {
    await runAsSystem("write", async () => {
      expect(await recordCommitCheck(prisma, report({ checkRunId: 200n, state: "failed" }))).toBe(
        true,
      );
      expect(await recordCommitCheck(prisma, report({ checkRunId: 150n, state: "passed" }))).toBe(
        false,
      );
      expect(await recordCommitCheck(prisma, report({ checkRunId: 300n, state: "queued" }))).toBe(
        true,
      );
    });
    expect(await stored()).toMatchObject({ checkRunId: 300n, state: "queued" });
  });

  it("keeps the newest pull request head and ignores older or equal events", async () => {
    const pr = { spaceId, repository, number: 7 };
    const newer = new Date("2026-02-02T10:00:00Z");
    await runAsSystem("write", async () => {
      expect(
        await recordPullRequestHead(prisma, { ...pr, headSha: "b".repeat(40), updatedAt: newer }),
      ).toBe(true);
      expect(
        await recordPullRequestHead(prisma, {
          ...pr,
          headSha: "c".repeat(40),
          updatedAt: new Date("2026-02-01T10:00:00Z"),
        }),
      ).toBe(false);
      expect(
        await recordPullRequestHead(prisma, { ...pr, headSha: "c".repeat(40), updatedAt: newer }),
      ).toBe(false);
    });
    const row = await runAsSystem("read", () =>
      prisma.pullRequestHead.findUnique({
        where: { spaceId_repository_number: { spaceId, repository, number: 7 } },
      }),
    );
    expect(row?.headSha).toBe("b".repeat(40));
  });

  it("lists checks for commits and pull request heads, and only inside the caller's Space", async () => {
    const targets = {
      commits: [{ repository, sha }],
      pullRequests: [
        { repository, number: 7 },
        { repository, number: 99 },
      ],
    };
    const mine = await runAsTenant({ spaceId, userId }, () =>
      listCommitChecks(prisma, spaceId, targets),
    );
    expect(mine.commits).toEqual([
      {
        repository,
        sha,
        checks: [
          {
            name: "build",
            state: "queued",
            url: "https://host.example/acme/app/runs/100",
            startedAt: null,
            completedAt: null,
          },
        ],
      },
    ]);
    expect(mine.pullRequests).toEqual([
      { repository, number: 7, sha: "b".repeat(40), checks: [] },
      { repository, number: 99, sha: null, checks: [] },
    ]);

    const other = await runAsTenant({ spaceId: otherSpaceId, userId }, () =>
      listCommitChecks(prisma, otherSpaceId, targets),
    );
    expect(other.commits[0]?.checks).toEqual([]);
    expect(other.pullRequests[0]?.sha).toBeNull();
  });
});
