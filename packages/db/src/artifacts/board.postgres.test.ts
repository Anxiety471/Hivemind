import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsTenant } from "../database/row-security.js";
import {
  archiveCompletedTickets,
  ensureBoard,
  listTicketComments,
  toTicketCommentDto,
} from "./board.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("board creation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `board-organization-${suffix}`;
  const spaceId = `board-space-${suffix}`;
  const userId = `board-user-${suffix}`;
  const tenant = { spaceId, userId };
  let prisma: PrismaClient;
  let fixtures: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    fixtures = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await fixtures.user.create({
      data: {
        id: userId,
        name: "Board tester",
        email: `${userId}@example.test`,
      },
    });
    await fixtures.organization.create({
      data: {
        id: organizationId,
        name: "Board Org",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await fixtures.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await fixtures.organization.deleteMany({ where: { id: organizationId } });
    await fixtures.user.delete({ where: { id: userId } });
    await close();
  });
  it("allows concurrent first opens and returns the same board", async () => {
    const boards = await Promise.all(
      Array.from({ length: 8 }, () => runAsTenant(tenant, () => ensureBoard(prisma, spaceId))),
    );
    expect(new Set(boards.map((board) => board.id)).size).toBe(1);
    expect(boards.every((board) => board.name === "General")).toBe(true);
    expect(await fixtures.board.count({ where: { spaceId } })).toBe(1);
  });
  it("returns user and bot display names with comments", async () => {
    const board = await runAsTenant(tenant, () => ensureBoard(prisma, spaceId));
    const bot = await fixtures.bot.create({
      data: { spaceId, userId, name: "Planner", color: "blue" },
    });
    const ticket = await fixtures.ticket.create({
      data: { spaceId, boardId: board.id, number: 1, title: "Ship" },
    });
    await fixtures.ticketComment.createMany({
      data: [
        { ticketId: ticket.id, spaceId, authorUserId: userId, body: "Ready" },
        { ticketId: ticket.id, spaceId, authorBotId: bot.id, body: "Reviewed" },
      ],
    });
    const rows = await runAsTenant(tenant, () => listTicketComments(prisma, spaceId, ticket.id));
    const comments = rows.map(toTicketCommentDto);
    expect(comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Ready", authorName: "Board tester" }),
        expect.objectContaining({ body: "Reviewed", authorName: "Planner" }),
      ]),
    );
  });
  it("archives done and closed tickets a week past completion and leaves the rest", async () => {
    const board = await runAsTenant(tenant, () => ensureBoard(prisma, spaceId));
    const now = new Date("2026-06-15T12:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const make = (number: number, data: object) =>
      fixtures.ticket.create({
        data: { spaceId, boardId: board.id, number, title: `T${number}`, ...data },
      });
    const oldDone = await make(100, { status: "done", completedAt: daysAgo(8) });
    const oldClosed = await make(101, { status: "closed", completedAt: daysAgo(30) });
    const unstamped = await make(102, { status: "done", updatedAt: daysAgo(9) });
    const recent = await make(103, { status: "done", completedAt: daysAgo(6) });
    const reopened = await make(104, { status: "doing", completedAt: daysAgo(20) });
    const already = await make(105, {
      status: "done",
      completedAt: daysAgo(20),
      archivedAt: daysAgo(10),
    });
    const result = await archiveCompletedTickets(asSystem(prisma), now);
    expect(result.boards).toContainEqual({ spaceId, boardId: board.id });
    const archivedAt = async (id: string) =>
      (await fixtures.ticket.findUniqueOrThrow({ where: { id } })).archivedAt;
    expect(await archivedAt(oldDone.id)).toEqual(now);
    expect(await archivedAt(oldClosed.id)).toEqual(now);
    expect(await archivedAt(unstamped.id)).toEqual(now);
    expect(await archivedAt(recent.id)).toBeNull();
    expect(await archivedAt(reopened.id)).toBeNull();
    expect(await archivedAt(already.id)).toEqual(daysAgo(10));
    const again = await archiveCompletedTickets(asSystem(prisma), now);
    expect(again.boards).not.toContainEqual({ spaceId, boardId: board.id });
  });
});
