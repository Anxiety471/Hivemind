import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TicketChange } from "./ticket-changes.js";
import { recordTicketIssueState, recordTicketPullRequestState } from "./ticket-links.js";
import { createTicket, updateTicket } from "./ticket-tools.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)(
  "tickets following their linked pull requests and issues (PostgreSQL)",
  () => {
    let prisma: PrismaClient;
    let system: PrismaClient;
    let close: () => Promise<void>;
    let provisioned = false;
    let userId: string;
    let spaceId: string;
    const address = `ticket-pr-${randomUUID()}`;
    const changes: TicketChange[] = [];
    const deps = () => ({
      prisma: system,
      onTicketChange: vi.fn(async (change: TicketChange) => {
        changes.push(change);
      }),
    });

    beforeAll(async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      system = asSystem(prisma);
      close = async () => {
        try {
          await prisma.$disconnect();
        } finally {
          await db.pool.end();
        }
      };
      const identity = await runAsSystem("test fixture", () =>
        provisionMessagingIdentity(prisma, { provider: "test", address }),
      );
      provisioned = true;
      ({ userId, spaceId } = identity);
    });

    afterAll(async () => {
      try {
        if (prisma && provisioned) {
          await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
          await system.organization.deleteMany({ where: { id: spaceId } });
          await system.user.deleteMany({ where: { id: userId } });
        }
      } finally {
        await close?.();
      }
    });

    const first = "https://git.example.com/acme/app/pull/7";
    const second = "https://git.example.com/acme/app/pull/8";

    async function linkedTicket() {
      const created = await createTicket(deps(), {
        spaceId,
        userId,
        title: "Ship the export",
        pullRequests: [{ url: "https://Git.Example.com/Acme/App/pull/7/files" }, { url: second }],
      });
      if ("error" in created) throw new Error(created.error);
      const blocked = await updateTicket(deps(), {
        spaceId,
        userId,
        id: created.ticket.id,
        status: "blocked",
        decision: {
          question: "Merge it?",
          options: ["Merge", "Wait", "Drop"],
          recommended: "Merge",
        },
      });
      if ("error" in blocked) throw new Error(blocked.error);
      return blocked.ticket;
    }

    it("moves a ticket to done once a merge leaves none of its pull requests open", async () => {
      const ticket = await linkedTicket();
      expect(ticket.pullRequests).toEqual([
        { url: first, state: "open" },
        { url: second, state: "open" },
      ]);

      await expect(
        recordTicketPullRequestState(deps(), { spaceId, url: second, state: "closed" }),
      ).resolves.toBe(1);
      const stillBlocked = await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stillBlocked.status).toBe("blocked");

      changes.length = 0;
      await expect(
        recordTicketPullRequestState(deps(), {
          spaceId,
          url: "https://git.example.com/ACME/app/pull/7",
          state: "merged",
        }),
      ).resolves.toBe(1);
      const done = await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(done.status).toBe("done");
      expect(done.completedAt).not.toBeNull();
      expect(done.decision).toBeNull();
      expect(done.pullRequests).toEqual([
        { url: first, state: "merged" },
        { url: second, state: "closed" },
      ]);
      expect(changes).toEqual([
        expect.objectContaining({ ticketId: ticket.id, wakeAssignee: false, wakeBotIds: [] }),
      ]);

      // A redelivered event changes nothing.
      await expect(
        recordTicketPullRequestState(deps(), { spaceId, url: first, state: "merged" }),
      ).resolves.toBe(0);
    });

    it("keeps a ticket open while another linked pull request is still open", async () => {
      const ticket = await linkedTicket();
      await expect(
        recordTicketPullRequestState(deps(), { spaceId, url: first, state: "merged" }),
      ).resolves.toBe(1);
      const row = await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(row.status).toBe("blocked");
    });

    it("leaves tickets in other Spaces alone", async () => {
      const ticket = await linkedTicket();
      await expect(
        recordTicketPullRequestState(deps(), {
          spaceId: `other-${randomUUID()}`,
          url: first,
          state: "merged",
        }),
      ).resolves.toBe(0);
      const row = await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(row.pullRequests).toEqual(ticket.pullRequests);
    });

    it("keeps a recorded state when an update relinks the same pull request", async () => {
      const ticket = await linkedTicket();
      await recordTicketPullRequestState(deps(), { spaceId, url: first, state: "merged" });
      const updated = await updateTicket(deps(), {
        spaceId,
        userId,
        id: ticket.id,
        pullRequests: [
          { url: `${first}#discussion` },
          { url: "https://git.example.com/acme/app/pull/9" },
        ],
      });
      if ("error" in updated) throw new Error(updated.error);
      expect(updated.ticket.pullRequests).toEqual([
        { url: first, state: "merged" },
        { url: "https://git.example.com/acme/app/pull/9", state: "open" },
      ]);
    });

    it("finishes a blocked ticket when an update records the merge, dropping the question sent with it", async () => {
      const ticket = await linkedTicket();
      const updated = await updateTicket(deps(), {
        spaceId,
        userId,
        id: ticket.id,
        pullRequests: [
          { url: first, state: "merged" },
          { url: second, state: "closed" },
        ],
        decision: {
          question: "Close it now that it merged?",
          options: ["Close", "Keep open", "Leave blocked"],
          recommended: "Close",
        },
      });
      if ("error" in updated) throw new Error(updated.error);
      expect(updated.ticket.status).toBe("done");
      expect(updated.ticket.completedAt).not.toBeNull();
      const row = await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(row.decision).toBeNull();
    });

    it("keeps the status an update sets alongside a merge", async () => {
      const ticket = await linkedTicket();
      const updated = await updateTicket(deps(), {
        spaceId,
        userId,
        id: ticket.id,
        status: "doing",
        pullRequests: [{ url: first, state: "merged" }],
      });
      if ("error" in updated) throw new Error(updated.error);
      expect(updated.ticket.status).toBe("doing");
    });

    it("creates a ticket for already merged work as done", async () => {
      const created = await createTicket(deps(), {
        spaceId,
        userId,
        title: "Ship the import",
        pullRequests: [{ url: first, state: "merged" }],
      });
      if ("error" in created) throw new Error(created.error);
      expect(created.ticket.status).toBe("done");
      expect(created.ticket.completedAt).not.toBeNull();
    });

    it("tracks linked issues and a repository without moving the ticket", async () => {
      const issue = "https://git.example.com/acme/app/issues/3";
      const created = await createTicket(deps(), {
        spaceId,
        userId,
        title: "Fix the crash",
        issues: [{ url: "https://Git.Example.com/Acme/App/issues/3#issuecomment-1" }],
        repository: "https://git.example.com/Acme/App.git",
      });
      if ("error" in created) throw new Error(created.error);
      expect(created.ticket).toMatchObject({
        issues: [{ url: issue, state: "open" }],
        repository: "https://git.example.com/acme/app",
      });

      await expect(
        recordTicketIssueState(deps(), { spaceId, url: issue, state: "closed" }),
      ).resolves.toBe(1);
      const closed = await system.ticket.findUniqueOrThrow({ where: { id: created.ticket.id } });
      expect(closed.status).toBe("todo");
      expect(closed.issues).toEqual([{ url: issue, state: "closed" }]);
      // A pull request with the same number is a different link.
      await expect(
        recordTicketPullRequestState(deps(), {
          spaceId,
          url: "https://git.example.com/acme/app/pull/3",
          state: "merged",
        }),
      ).resolves.toBe(0);

      const updated = await updateTicket(deps(), {
        spaceId,
        userId,
        id: created.ticket.id,
        issues: [{ url: issue }, { url: "https://git.example.com/acme/app/issues/4" }],
        repository: null,
      });
      if ("error" in updated) throw new Error(updated.error);
      expect(updated.ticket).toMatchObject({
        issues: [
          { url: issue, state: "closed" },
          { url: "https://git.example.com/acme/app/issues/4", state: "open" },
        ],
        repository: null,
      });
    });

    it("refuses a pull request link where an issue or repository belongs", async () => {
      const refused = await createTicket(deps(), {
        spaceId,
        userId,
        title: "Mixed up links",
        issues: [{ url: first }],
        repository: first,
      });
      expect(refused).toEqual({ error: expect.stringContaining("issue link") });
      expect("error" in refused && refused.error).toContain("repository link");
    });
  },
);
