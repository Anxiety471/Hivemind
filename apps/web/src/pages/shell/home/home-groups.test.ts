import type { Ticket } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { homeGroups } from "./home-groups";

function ticket(id: string, status: Ticket["status"], updatedAt: string): Ticket {
  return {
    id,
    boardId: "b",
    spaceId: "s",
    number: 1,
    ref: `T-${id}`,
    title: id,
    description: null,
    status,
    priority: "normal",
    assigneeBotId: null,
    ownerUserId: null,
    ownerBotId: null,
    workerBotIds: [],
    createdByBotId: null,
    createdByUserId: null,
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
    pullRequests: [],
  };
}

describe("homeGroups", () => {
  it("sorts tickets into stages, newest first", () => {
    const groups = homeGroups([
      ticket("a", "doing", "2026-01-01T00:00:00Z"),
      ticket("b", "review", "2026-01-02T00:00:00Z"),
      ticket("c", "todo", "2026-01-01T00:00:00Z"),
      ticket("d", "done", "2026-01-01T00:00:00Z"),
      ticket("e", "closed", "2026-01-03T00:00:00Z"),
    ]);
    expect(groups.inProgress.map((item) => item.id)).toEqual(["b", "a"]);
    expect(groups.planned.map((item) => item.id)).toEqual(["c"]);
    expect(groups.closed.map((item) => item.id)).toEqual(["e", "d"]);
  });
});
