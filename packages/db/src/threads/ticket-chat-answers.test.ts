import { describe, expect, it, vi } from "vitest";
import {
  resolveTicketDecisionsFromChatAnswer,
  retireWaitingQuestionsForTicket,
} from "./ticket-chat-answers.js";

const events = vi.hoisted(() => ({
  append: vi.fn(async (_tx: unknown, input: { threadId: string }) => ({
    threadId: input.threadId,
    seq: 1,
  })),
}));

vi.mock("./events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./events.js")>()),
  appendEventInTransaction: events.append,
}));
vi.mock("../runs/run-secrets.js", () => ({ deleteRunSecretsInTransaction: vi.fn(async () => {}) }));

const board = { id: "board-1", spaceId: "space-1", name: "Board", ticketPrefix: "TASK" };
const decision = {
  question: "Which region?",
  options: [
    { id: "sg", label: "Singapore", recommended: true },
    { id: "us", label: "Virginia" },
    { id: "eu", label: "Frankfurt" },
  ],
};

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ticket-1",
    boardId: "board-1",
    spaceId: "space-1",
    number: 441,
    status: "blocked",
    decision,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function ticketPrisma(row: ReturnType<typeof ticketRow> | null) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    ticket: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    ticketComment: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    board: { findUnique: vi.fn(async () => board) },
    ticket: { findFirst: vi.fn(async () => (row ? { id: row.id } : null)) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx };
}

describe("resolving a board ticket from its chat answer", () => {
  const answer = { spaceId: "space-1", answeredByUserId: "user-1" };

  it("answers the pending decision, moves a blocked ticket to todo and records a comment", async () => {
    const { prisma, tx } = ticketPrisma(ticketRow());

    await resolveTicketDecisionsFromChatAnswer(prisma as never, {
      ...answer,
      answers: [{ ticketRef: "TASK-441", answer: "Singapore" }],
    });

    expect(tx.ticket.update).toHaveBeenCalledWith({
      where: { id: "ticket-1" },
      data: expect.objectContaining({
        status: "todo",
        completedAt: null,
        archivedAt: null,
        decision: expect.objectContaining({
          question: "Which region?",
          answer: "Singapore",
          answeredAt: expect.any(String),
        }),
      }),
    });
    expect(tx.ticketComment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: "ticket-1",
        authorBotId: null,
        authorUserId: "user-1",
        body: "> Which region?\n\nSingapore",
      }),
    });
  });

  it("keeps a doing ticket's status and answers a review ticket's decision", async () => {
    const doing = ticketPrisma(ticketRow({ status: "doing" }));
    await resolveTicketDecisionsFromChatAnswer(doing.prisma as never, {
      ...answer,
      answers: [{ ticketRef: "TASK-441", answer: "Virginia" }],
    });
    expect(doing.tx.ticket.update.mock.calls[0]?.[0].data).not.toHaveProperty("status");

    const review = ticketPrisma(ticketRow({ status: "review" }));
    await resolveTicketDecisionsFromChatAnswer(review.prisma as never, {
      ...answer,
      answers: [{ ticketRef: "task-441", answer: "Virginia" }],
    });
    expect(review.tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "todo" }) }),
    );
  });

  it("leaves a ticket whose decision is already answered, or unknown, untouched", async () => {
    const answered = ticketPrisma(
      ticketRow({ decision: { ...decision, answer: "Frankfurt", answeredAt: "2026-01-01" } }),
    );
    await resolveTicketDecisionsFromChatAnswer(answered.prisma as never, {
      ...answer,
      answers: [{ ticketRef: "TASK-441", answer: "Singapore" }],
    });
    expect(answered.tx.ticket.update).not.toHaveBeenCalled();

    const missing = ticketPrisma(null);
    await resolveTicketDecisionsFromChatAnswer(missing.prisma as never, {
      ...answer,
      answers: [{ ticketRef: "TASK-999", answer: "Singapore" }],
    });
    expect(missing.prisma.$transaction).not.toHaveBeenCalled();

    const otherPrefix = ticketPrisma(ticketRow());
    await resolveTicketDecisionsFromChatAnswer(otherPrefix.prisma as never, {
      ...answer,
      answers: [{ ticketRef: "OPS-441", answer: "Singapore" }],
    });
    expect(otherPrefix.prisma.ticket.findFirst).not.toHaveBeenCalled();
  });
});

type Block = Record<string, unknown> & { kind: string };

function askBlock(overrides: Record<string, unknown> = {}): Block {
  return {
    kind: "ask",
    text: "Ship the release?",
    status: "pending",
    actions: [
      { id: "choice-1", label: "Ship" },
      { id: "choice-2", label: "Hold" },
    ],
    ticketRef: "TASK-441",
    ...overrides,
  };
}

function retirePrisma(messageBlocks: Block[][], options: { stillWaiting?: boolean } = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findFirst: vi.fn(async () => (options.stillWaiting === false ? null : { id: "run-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findMany: vi.fn(async () =>
        messageBlocks.map((blocks, index) => ({ id: `msg-${index}`, blocks })),
      ),
      update: vi.fn(async () => ({})),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({})) },
    attempt: { updateMany: vi.fn(async () => ({})) },
    task: { updateMany: vi.fn(async () => ({})) },
  };
  const prisma = {
    run: {
      findMany: vi.fn(async () => [
        { id: "run-1", threadId: "thread-1", botId: "bot-1", userId: "user-1", taskId: "task-1" },
      ]),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx };
}

describe("retiring the chat questions a settled ticket leaves", () => {
  const input = { spaceId: "space-1", ticketRef: "TASK-441", answer: "Closed TASK-441" };

  it("answers the matching question, cancels its waiting run and reports the retirement", async () => {
    const { prisma, tx } = retirePrisma([[askBlock()]]);

    await expect(retireWaitingQuestionsForTicket(prisma as never, input)).resolves.toBe(1);

    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "run-1", status: "waiting_input" }),
      data: expect.objectContaining({ status: "cancelled", checkpoint: null }),
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-0" },
      data: {
        blocks: [
          expect.objectContaining({
            kind: "ask",
            status: "answered",
            answer: "Closed TASK-441",
            ticketRef: "TASK-441",
          }),
        ],
      },
    });
    expect(events.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "run.cancelled", runId: "run-1" }),
    );
  });

  it("matches the ticket ref case-insensitively", async () => {
    const { prisma } = retirePrisma([[askBlock({ ticketRef: "task-441" })]]);

    await expect(retireWaitingQuestionsForTicket(prisma as never, input)).resolves.toBe(1);
  });

  it("never touches a run that also waits on a secret, an approval or a batch", async () => {
    const secret = retirePrisma([[askBlock({ input: "secret" })]]);
    await expect(retireWaitingQuestionsForTicket(secret.prisma as never, input)).resolves.toBe(0);
    expect(secret.tx.run.updateMany).not.toHaveBeenCalled();

    const approval = retirePrisma([[askBlock({ approvalEffectId: "effect-1" })]]);
    await expect(retireWaitingQuestionsForTicket(approval.prisma as never, input)).resolves.toBe(0);
    expect(approval.tx.run.updateMany).not.toHaveBeenCalled();

    const batch = retirePrisma([
      [askBlock({ items: [{ id: "item-1", question: "Ship?", ticketRef: "TASK-441" }] })],
    ]);
    await expect(retireWaitingQuestionsForTicket(batch.prisma as never, input)).resolves.toBe(0);
    expect(batch.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a run alone when it holds another pending question, or none about the ticket", async () => {
    const other = retirePrisma([[askBlock(), askBlock({ ticketRef: undefined, text: "Lunch?" })]]);
    await expect(retireWaitingQuestionsForTicket(other.prisma as never, input)).resolves.toBe(0);
    expect(other.tx.run.updateMany).not.toHaveBeenCalled();

    const answered = retirePrisma([[askBlock({ status: "answered", answer: "Ship" })]]);
    await expect(retireWaitingQuestionsForTicket(answered.prisma as never, input)).resolves.toBe(0);
    expect(answered.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing once the run has left its waiting state", async () => {
    const { prisma, tx } = retirePrisma([[askBlock()]], { stillWaiting: false });

    await expect(retireWaitingQuestionsForTicket(prisma as never, input)).resolves.toBe(0);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });
});
