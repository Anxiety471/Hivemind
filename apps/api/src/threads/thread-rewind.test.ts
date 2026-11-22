import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { rewindThreadRun } from "./thread-rewind.js";
import type { ThreadTarget } from "./thread-target.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

const botTarget: ThreadTarget = {
  kind: "bot",
  botId: "bot-1",
  threadId: "thread-1",
  bot: { id: "bot-1", spaceId: "space-1", name: "Release bot", computer: null } as never,
};

describe("rewindThreadRun", () => {
  it("cancels active runs, marks rewound steps stopped, seeds a delivery branch, and wakes the retry run", async () => {
    const createMessage = vi.fn(async ({ data }) => ({
      id: "msg-delivery",
      seq: 10,
      ...data,
    }));
    const createTask = vi.fn(async ({ data }) => ({ id: "task-2", ...data }));
    const createRun = vi.fn(async ({ data }) => ({ id: "run-2", ...data }));
    const createEvent = vi.fn(async ({ data }) => ({
      id: "evt-1",
      seq: 11,
      createdAt: new Date("2026-10-27T00:00:00Z"),
      ...data,
    }));

    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 12 })) },
      message: {
        findFirst: vi.fn(async ({ where }) => {
          if (where.clientNonce) return null;
          return {
            id: "msg-1",
            botId: "bot-1",
            runId: "run-1",
            blocks: [
              {
                kind: "steps",
                modelId: "claude-opus-4-6",
                costUsd: 0.038,
                steps: [
                  { label: "Compared commits", count: 1, detail: "v3.1...main", durationMs: 2_300 },
                  {
                    label: "Drafted notes",
                    count: 1,
                    detail: "Releases / v3.2",
                    durationMs: 2_800,
                  },
                  { label: "Build preview", count: 1, detail: "pnpm build", durationMs: 2_600 },
                ],
              },
            ],
          };
        }),
        create: createMessage,
        update: vi.fn(async () => ({})),
      },
      run: {
        findFirst: vi.fn(async () => ({
          botId: "bot-1",
          modelProvider: "anthropic",
          modelId: "claude-opus-4-6",
        })),
        findUnique: vi.fn(async () => ({
          status: "queued",
          startedAt: null,
          firstResponseAt: null,
          userId: "user-1",
          leaseOwner: null,
          leaseFence: null,
        })),
        findMany: vi.fn(async () => []),
        updateManyAndReturn: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: createRun,
      },
      task: { create: createTask },
      steeringMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
      event: { create: createEvent, deleteMany: vi.fn(async () => ({ count: 0 })) },
    };

    const prisma = {
      $transaction: vi.fn(async (op: (client: typeof tx) => unknown) => op(tx)),
    } as unknown as PrismaClient;

    const enqueue = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const publishSpaceChange = vi.fn(async () => undefined);

    const result = await rewindThreadRun(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        jobs: { enqueue } as never,
        events: { notify, publishSpaceChange },
      },
      actor,
      botTarget,
      { messageId: "msg-1", stepIndex: 1, clientNonce: "nonce-1" },
    );

    expect(result).toEqual({
      ok: true,
      runId: "run-2",
      taskId: "task-2",
      attempt: 2,
    });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientNonce: "nonce-1",
          blocks: [
            { kind: "delivery" },
            {
              kind: "text",
              text: expect.stringContaining(
                "Rewound to step 2 (Drafted notes: Releases / v3.2) for retry attempt #2.",
              ),
            },
            {
              kind: "steps",
              attempts: 2,
              costUsd: 0.038,
              modelId: "claude-opus-4-6",
              modelProvider: "anthropic",
              steps: [
                {
                  label: "Compared commits",
                  count: 1,
                  detail: "v3.1...main",
                  durationMs: 2_300,
                  attempt: 1,
                  status: "done",
                },
                {
                  label: "Drafted notes",
                  count: 1,
                  detail: "Releases / v3.2",
                  durationMs: 2_800,
                  attempt: 1,
                  status: "stopped",
                },
                {
                  label: "Build preview",
                  count: 1,
                  detail: "pnpm build",
                  durationMs: 2_600,
                  attempt: 1,
                  status: "stopped",
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "run.checkpointed",
          runId: "run-2",
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 11);
    expect(enqueue).toHaveBeenCalled();
  });

  it("replays idempotently when clientNonce already exists", async () => {
    const createRun = vi.fn();
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      message: {
        findFirst: vi.fn(async () => ({
          id: "msg-existing",
          runId: "run-existing",
          blocks: [
            { kind: "delivery" },
            { kind: "text", text: "Rewound..." },
            { kind: "steps", attempts: 3, steps: [{ label: "Shell", count: 1 }] },
          ],
        })),
      },
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-existing",
          taskId: "task-existing",
          status: "queued",
        })),
        create: createRun,
      },
    };
    const prisma = {
      $transaction: vi.fn(async (op: (client: typeof tx) => unknown) => op(tx)),
    } as unknown as PrismaClient;
    const enqueue = vi.fn(async () => undefined);

    const result = await rewindThreadRun(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        jobs: { enqueue } as never,
        events: { notify: vi.fn(async () => undefined) },
      },
      actor,
      botTarget,
      { messageId: "msg-1", stepIndex: 0, clientNonce: "nonce-1" },
    );

    expect(result).toEqual({
      ok: true,
      runId: "run-existing",
      taskId: "task-existing",
      attempt: 3,
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rejects out-of-range stepIndex with BAD_REQUEST ClientError", async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      message: {
        findFirst: vi.fn(async () => ({
          id: "msg-1",
          botId: "bot-1",
          runId: "run-1",
          blocks: [{ kind: "steps", steps: [{ label: "Shell", count: 1 }] }],
        })),
      },
      run: {
        findFirst: vi.fn(async () => ({ botId: "bot-1", modelProvider: null, modelId: null })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (op: (client: typeof tx) => unknown) => op(tx)),
    } as unknown as PrismaClient;

    await expect(
      rewindThreadRun(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          jobs: { enqueue: vi.fn(async () => undefined) } as never,
          events: { notify: vi.fn(async () => undefined) },
        },
        actor,
        botTarget,
        { messageId: "msg-1", stepIndex: 4 },
      ),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});
