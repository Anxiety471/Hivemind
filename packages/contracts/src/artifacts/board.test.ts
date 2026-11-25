import { describe, expect, it } from "vitest";
import {
  CreateTicketInput,
  DecideTicketInput,
  GetTicketInput,
  hasPendingTicketDecision,
  isTicketCompletedStatus,
  mergeTicketPullRequests,
  normalizePullRequestUrl,
  normalizeTicketDecision,
  parseTicketRef,
  pullRequestLabel,
  pullRequestMergeFinishesTicket,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketDecisionInputSchema,
  TicketSchema,
  UpdateTicketInput,
} from "./board.js";

describe("parseTicketRef", () => {
  it("matches the prefix case-insensitively and normalizes it", () => {
    expect(parseTicketRef("rak-42")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("  RaK-7  ")).toEqual({ prefix: "RAK", number: 7 });
  });

  it("rejects a reference whose prefix differs from the board", () => {
    expect(parseTicketRef("RAK-42", "RAK")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("rak-42", "RAK")).toEqual({ prefix: "RAK", number: 42 });
    expect(parseTicketRef("ABC-42", "RAK")).toBeNull();
  });

  it("rejects malformed references", () => {
    for (const value of ["RAK", "RAK-", "-42", "RAK 42", "RAK-0", "RAK-007", "42-RAK", ""]) {
      expect(parseTicketRef(value)).toBeNull();
    }
  });

  it("accepts the largest ticket number the database can store", () => {
    expect(parseTicketRef("RAK-2147483647")).toEqual({ prefix: "RAK", number: 2147483647 });
  });

  it.each([
    ["above the database maximum", "2147483648"],
    ["outside JavaScript integer precision", "9007199254740993"],
    ["within the API reference length limit", "9".repeat(115)],
    ["converted to infinity", "9".repeat(400)],
  ])("rejects a ticket number outside the database range: %s", (_label, number) => {
    expect(parseTicketRef(`RAK-${number}`)).toBeNull();
  });
});

describe("pull request links", () => {
  it.each([
    ["https://github.com/Acme/App/pull/241", "https://github.com/acme/app/pull/241"],
    [
      "  https://github.com/acme/app/pull/241/files?w=1#top ",
      "https://github.com/acme/app/pull/241",
    ],
    [
      "https://gitlab.example.com/group/sub/proj/-/merge_requests/5/diffs",
      "https://gitlab.example.com/group/sub/proj/-/merge_requests/5",
    ],
    [
      "https://bitbucket.org/team/repo/pull-requests/3/overview",
      "https://bitbucket.org/team/repo/pull-requests/3",
    ],
  ])("normalizes %s", (value, expected) => {
    expect(normalizePullRequestUrl(value)).toBe(expected);
  });

  it.each([
    ["plain http", "http://github.com/acme/app/pull/1"],
    ["an issue", "https://github.com/acme/app/issues/1"],
    ["a repository", "https://github.com/acme/app"],
    ["a number with a leading zero", "https://github.com/acme/app/pull/01"],
    ["a user name in the host", "https://user@github.com/acme/app/pull/1"],
    ["text after the number", "https://github.com/acme/app/pull/1abc"],
    ["an overlong link", `https://github.com/acme/${"a".repeat(500)}/pull/1`],
  ])("rejects %s", (_label, value) => {
    expect(normalizePullRequestUrl(value)).toBeNull();
  });

  it("labels a link by its repository and number", () => {
    expect(pullRequestLabel("https://github.com/acme/app/pull/241")).toBe("acme/app#241");
    expect(pullRequestLabel("https://gitlab.example.com/group/sub/proj/-/merge_requests/5")).toBe(
      "sub/proj#5",
    );
  });

  it("replaces the list in input order, keeping recorded states unless the input sets one", () => {
    const a = "https://github.com/acme/app/pull/1";
    const b = "https://github.com/acme/app/pull/2";
    const c = "https://github.com/acme/app/pull/3";
    expect(
      mergeTicketPullRequests(
        [
          { url: a, state: "merged" },
          { url: b, state: "open" },
        ],
        [{ url: c }, { url: a }, { url: b, state: "closed" }, { url: c, state: "merged" }],
      ),
    ).toEqual([
      { url: c, state: "open" },
      { url: a, state: "merged" },
      { url: b, state: "closed" },
    ]);
  });

  it("finishes a ticket only on a new merge that leaves nothing open", () => {
    const url = "https://github.com/acme/app/pull/1";
    const other = `${url}0`;
    const merged = { url, state: "merged" as const };
    expect(pullRequestMergeFinishesTicket([], [])).toBe(false);
    expect(pullRequestMergeFinishesTicket([], [{ url, state: "closed" }])).toBe(false);
    expect(pullRequestMergeFinishesTicket([], [merged, { url: other, state: "open" }])).toBe(false);
    expect(pullRequestMergeFinishesTicket([], [merged, { url: other, state: "closed" }])).toBe(
      true,
    );
    expect(pullRequestMergeFinishesTicket([{ url, state: "open" }], [merged])).toBe(true);
    // Closing the last open link after an earlier merge records no new merge.
    expect(
      pullRequestMergeFinishesTicket(
        [merged, { url: other, state: "open" }],
        [merged, { url: other, state: "closed" }],
      ),
    ).toBe(false);
  });

  it("rejects a ticket update linking something that is not a pull request", () => {
    const parsed = UpdateTicketInput.safeParse({
      id: "ticket-1",
      pullRequests: [{ url: "https://github.com/acme/app/issues/1" }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["pullRequests", 0, "url"]);
  });
});

describe("ticket contracts", () => {
  const ticket = {
    id: "ticket-1",
    boardId: "board-1",
    spaceId: "space-1",
    number: 1,
    ref: "RAK-1",
    title: "Ship the board",
    description: null,
    status: "todo",
    priority: "normal",
    assigneeBotId: null,
    ownerUserId: "user-1",
    ownerBotId: null,
    workerBotIds: [],
    createdByBotId: null,
    createdByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    pullRequests: [],
  };

  it("accepts a ticket document and rejects unknown statuses", () => {
    expect(TicketSchema.parse(ticket).status).toBe("todo");
    expect(TicketSchema.parse({ ...ticket, status: "closed" }).status).toBe("closed");
    expect(() => TicketSchema.parse({ ...ticket, status: "archived" })).toThrow();
  });

  it("orders statuses with closed last and treats done and closed as completed", () => {
    expect(TICKET_STATUSES).toEqual(["todo", "doing", "review", "blocked", "done", "closed"]);
    expect(isTicketCompletedStatus("done")).toBe(true);
    expect(isTicketCompletedStatus("closed")).toBe(true);
    expect(isTicketCompletedStatus("review")).toBe(false);
  });

  it("always creates tickets with a known priority and no caller-chosen status", () => {
    expect(CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1" })).toEqual({
      title: "Ship",
      assigneeBotId: "bot-1",
      priority: "normal",
    });
    expect(
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", priority: "urgent" })
        .priority,
    ).toBe("urgent");
    const withoutStatus = CreateTicketInput.parse({
      title: "Ship",
      assigneeBotId: "bot-1",
      status: "doing",
    } as never);
    expect(withoutStatus).not.toHaveProperty("status");
    expect(() =>
      CreateTicketInput.parse({ title: "Ship", assigneeBotId: "bot-1", priority: "whenever" }),
    ).toThrow();
    expect(TICKET_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("requires exactly one of id or ref when fetching", () => {
    expect(GetTicketInput.parse({ ref: "RAK-1" })).toEqual({ ref: "RAK-1" });
    expect(GetTicketInput.parse({ id: "ticket-1" })).toEqual({ id: "ticket-1" });
    expect(() => GetTicketInput.parse({})).toThrow();
    expect(() => GetTicketInput.parse({ id: "ticket-1", ref: "RAK-1" })).toThrow();
  });

  it("allows creating a ticket owned by the user with multiple worker bots or none", () => {
    expect(CreateTicketInput.parse({ title: "Ship" })).toEqual({
      title: "Ship",
      priority: "normal",
    });
    expect(
      CreateTicketInput.parse({
        title: "Ship",
        ownerUserId: "user-1",
        workerBotIds: ["bot-1", "bot-2"],
      }),
    ).toEqual({
      title: "Ship",
      ownerUserId: "user-1",
      workerBotIds: ["bot-1", "bot-2"],
      priority: "normal",
    });
    expect(() =>
      CreateTicketInput.parse({ title: "Ship", ownerUserId: "user-1", ownerBotId: "bot-1" }),
    ).toThrow();
  });

  it("supports updating owner and worker bots independently while rejecting ambiguous owners", () => {
    expect(
      UpdateTicketInput.parse({
        id: "ticket-1",
        ownerUserId: "user-1",
        workerBotIds: ["bot-2", "bot-3"],
      }),
    ).toEqual({
      id: "ticket-1",
      ownerUserId: "user-1",
      workerBotIds: ["bot-2", "bot-3"],
    });
    expect(UpdateTicketInput.parse({ id: "ticket-1", assigneeBotId: null }).assigneeBotId).toBe(
      null,
    );
    expect(() =>
      UpdateTicketInput.parse({ id: "ticket-1", ownerUserId: "user-1", ownerBotId: "bot-2" }),
    ).toThrow();
  });

  it("validates 3-option + 1-recommended ticket decisions", () => {
    const input = TicketDecisionInputSchema.parse({
      question: "  Keep nightly tarballs in R2?  ",
      options: ["  Skip tarballs ", "Upload bundles", "Disable repair snapshots"],
      recommended: "skip tarballs",
    });
    const normalized = normalizeTicketDecision(input);
    expect(normalized).toEqual({
      question: "Keep nightly tarballs in R2?",
      options: [
        { id: "choice-1", label: "Skip tarballs", recommended: true },
        { id: "choice-2", label: "Upload bundles" },
        { id: "choice-3", label: "Disable repair snapshots" },
      ],
    });
    expect(hasPendingTicketDecision({ decision: normalized })).toBe(true);
    expect(hasPendingTicketDecision({ decision: null })).toBe(false);
    expect(
      hasPendingTicketDecision({
        decision: { ...normalized, answer: "Skip tarballs", answeredAt: "2026-11-21T00:00:00Z" },
      }),
    ).toBe(false);

    expect(() =>
      TicketDecisionInputSchema.parse({
        question: "Pick one?",
        options: ["One", "Two"],
        recommended: "One",
      }),
    ).toThrow();

    expect(() =>
      TicketDecisionInputSchema.parse({
        question: "Pick one?",
        options: ["One", "Two", "Three"],
        recommended: "Four",
      }),
    ).toThrow();

    expect(() =>
      TicketDecisionInputSchema.parse({
        question: "Pick one?",
        options: ["One", "one", "Three"],
        recommended: "One",
      }),
    ).toThrow();

    expect(DecideTicketInput.parse({ ticketId: "t1", optionId: "opt_1" })).toEqual({
      ticketId: "t1",
      optionId: "opt_1",
    });
    expect(
      DecideTicketInput.parse({ ticketId: "t1", customAnswer: "  Wait until Monday  " }),
    ).toEqual({
      ticketId: "t1",
      customAnswer: "Wait until Monday",
    });
    expect(() => DecideTicketInput.parse({ ticketId: "t1" })).toThrow();
    expect(() =>
      DecideTicketInput.parse({ ticketId: "t1", optionId: "opt_1", customAnswer: "Both" }),
    ).toThrow();
  });
});
