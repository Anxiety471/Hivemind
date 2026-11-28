import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const actor: Actor = {
  spaceId: "space-mine",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function fakeRouter() {
  const commitCheckFindMany = vi.fn(async ({ where }: { where: { spaceId: string } }) =>
    where.spaceId === "space-mine"
      ? [
          {
            repository: "host.example/acme/app",
            headSha: SHA,
            name: "build",
            state: "running",
            url: "https://host.example/acme/app/runs/9",
            startedAt: new Date("2026-03-01T10:00:00Z"),
            completedAt: null,
          },
        ]
      : [],
  );
  const pullRequestFindMany = vi.fn(async () => [
    { repository: "host.example/acme/app", number: 4, headSha: SHA },
  ]);
  const router = createRouter({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ bypass: null }]),
      commitCheck: { findMany: commitCheckFindMany },
      pullRequestHead: { findMany: pullRequestFindMany },
    },
    env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
    dataDir: "/tmp/commit-checks-route-test",
  } as unknown as RouterDeps);
  return { router, commitCheckFindMany, pullRequestFindMany };
}

const input = {
  commits: [{ repository: "host.example/acme/app", sha: SHA }],
  pullRequests: [{ repository: "host.example/acme/app", number: 4 }],
};

it("refuses a caller who is not signed in", async () => {
  const { router, commitCheckFindMany } = fakeRouter();
  await expect(
    createRouterClient(router, { context: { actor: null } }).commitChecks.list(input),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(commitCheckFindMany).not.toHaveBeenCalled();
});

it("returns the checks of the named commits and pull request heads in the caller's Space", async () => {
  const { router, commitCheckFindMany } = fakeRouter();
  const result = await createRouterClient(router, { context: { actor } }).commitChecks.list(input);
  expect(
    commitCheckFindMany.mock.calls.every(([args]) => args.where.spaceId === "space-mine"),
  ).toBe(true);
  expect(result).toEqual({
    commits: [
      {
        repository: "host.example/acme/app",
        sha: SHA,
        checks: [
          {
            name: "build",
            state: "running",
            url: "https://host.example/acme/app/runs/9",
            startedAt: "2026-03-01T10:00:00.000Z",
            completedAt: null,
          },
        ],
      },
    ],
    pullRequests: [
      {
        repository: "host.example/acme/app",
        number: 4,
        sha: SHA,
        checks: [
          {
            name: "build",
            state: "running",
            url: "https://host.example/acme/app/runs/9",
            startedAt: "2026-03-01T10:00:00.000Z",
            completedAt: null,
          },
        ],
      },
    ],
  });
});

it("rejects a target that is not a repository and commit or pull request number", async () => {
  const { router } = fakeRouter();
  const client = createRouterClient(router, { context: { actor } });
  await expect(
    client.commitChecks.list({ commits: [{ repository: "x", sha: SHA }], pullRequests: [] }),
  ).rejects.toThrow();
  await expect(
    client.commitChecks.list({ commits: [], pullRequests: [{ repository: "a/b/c", number: 0 }] }),
  ).rejects.toThrow();
});
