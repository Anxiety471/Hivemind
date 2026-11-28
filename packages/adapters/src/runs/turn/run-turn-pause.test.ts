import { describe, expect, it, vi } from "vitest";
import { singleAskTicketRef } from "./run-turn-pause.js";

function prismaFor(options: {
  board?: { id: string; ticketPrefix: string } | null;
  existingNumbers?: number[];
}) {
  const board = vi.fn(async () => options.board ?? null);
  const ticket = vi.fn(async ({ where }: { where: { number: number } }) =>
    (options.existingNumbers ?? []).includes(where.number)
      ? { id: `ticket-${where.number}` }
      : null,
  );
  return { board: { findFirst: board }, ticket: { findFirst: ticket }, spies: { board, ticket } };
}

const TASK_BOARD = { id: "board-1", ticketPrefix: "TASK" };

describe("single ask ticket links", () => {
  it("keeps a valid explicit ticketRef, normalized, without reading the board", async () => {
    const prisma = prismaFor({ board: TASK_BOARD });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", { ticketRef: " task-42 " }, "Any text"),
    ).resolves.toBe("TASK-42");
    expect(prisma.spies.board).not.toHaveBeenCalled();
  });

  it("drops an explicit ticketRef that is not a ticket ref", async () => {
    const prisma = prismaFor({ board: TASK_BOARD });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", { ticketRef: "not a ref" }, "TASK-7 here"),
    ).resolves.toBeUndefined();
  });

  it("links the one existing ticket the question names", async () => {
    const prisma = prismaFor({ board: TASK_BOARD, existingNumbers: [7] });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "Ship it after TASK-7 is reviewed?"),
    ).resolves.toBe("TASK-7");
    expect(prisma.spies.ticket).toHaveBeenCalledWith({
      where: { spaceId: "space-1", boardId: "board-1", number: 7 },
      select: { id: true },
    });
  });

  it("links nothing when the text names two different tickets", async () => {
    const prisma = prismaFor({ board: TASK_BOARD, existingNumbers: [7, 8] });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "TASK-7 or TASK-8?"),
    ).resolves.toBeUndefined();
    expect(prisma.spies.ticket).not.toHaveBeenCalled();
  });

  it("counts a repeated ref once, but a different number is another ref", async () => {
    const prisma = prismaFor({ board: TASK_BOARD, existingNumbers: [7] });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "task-7 is TASK-7 again"),
    ).resolves.toBe("TASK-7");
    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "task-7 is TASK-7, not TASK-70"),
    ).resolves.toBeUndefined();
  });

  it("ignores refs of another prefix and named tickets that do not exist", async () => {
    const prisma = prismaFor({ board: TASK_BOARD, existingNumbers: [] });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "OPS-12 and TASK-9?"),
    ).resolves.toBeUndefined();
    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "Only OPS-12 here"),
    ).resolves.toBeUndefined();
  });

  it("reads no board for text without any ref-shaped word", async () => {
    const prisma = prismaFor({ board: TASK_BOARD, existingNumbers: [1] });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "Pick a region, or wait?"),
    ).resolves.toBeUndefined();
    expect(prisma.spies.board).not.toHaveBeenCalled();
  });

  it("links nothing when the Space has no board", async () => {
    const prisma = prismaFor({ board: null });

    await expect(
      singleAskTicketRef(prisma as never, "space-1", {}, "TASK-7?"),
    ).resolves.toBeUndefined();
  });
});
