import type { Case, Seeded } from "./contract.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 0, 1));

export function laneHTicketCases(system: System): Case[] {
  const withLab = async (seeded: Seeded) => {
    await system.user.update({ where: { id: seeded.userId }, data: { labs: ["board"] } });
  };
  const seedLabOnly = async (seeded: Seeded) => {
    await withLab(seeded);
  };
  const seedTicket =
    (
      options: {
        status?: string;
        title?: string;
        bot?: boolean;
        decision?: unknown;
        pullRequests?: unknown;
      } = {},
    ) =>
    async (seeded: Seeded) => {
      await withLab(seeded);
      const spaceId = seeded.spaces[0];
      if (options.bot) {
        await system.bot.create({
          data: {
            id: `${seeded.userId}-tkbot`,
            spaceId,
            userId: seeded.userId,
            name: "Potato · Dev Ops",
            color: "blue",
            updatedAt: OLD,
          },
        });
      }
      await system.board.create({
        data: {
          id: `${seeded.userId}-tkbd`,
          spaceId,
          name: "Board",
          ticketPrefix: "RAK",
          nextNumber: 2,
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
      await system.ticket.create({
        data: {
          id: `${seeded.userId}-tkt`,
          boardId: `${seeded.userId}-tkbd`,
          spaceId,
          number: 1,
          title: options.title ?? "First",
          status: options.status ?? "todo",
          priority: "normal",
          ...(options.decision !== undefined ? { decision: options.decision } : {}),
          ...(options.pullRequests !== undefined ? { pullRequests: options.pullRequests } : {}),
          createdByUserId: seeded.userId,
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
    };
  const c = (
    procedure: string,
    prefix: string,
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `${prefix}-${name}`,
    procedure,
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });

  const storedDecision = {
    question: "Keep tarballs?",
    options: [
      { id: "choice-1", label: "Skip tarballs", recommended: true },
      { id: "choice-2", label: "Store bundles" },
      { id: "choice-3", label: "Keep both" },
    ],
  };

  return [
    c(
      "tickets.get",
      "tkd-get",
      "with-decision",
      { id: "__s-tkt__" },
      seedTicket({ status: "blocked", decision: storedDecision }),
    ),
    c(
      "tickets.create",
      "tkd-create",
      "with-decision",
      {
        title: "Approve rollout",
        decision: {
          question: "Ship to prod now?",
          options: ["Canary 10%", "Full deploy", "Hold until Monday"],
          recommended: "Canary 10%",
        },
      },
      seedLabOnly,
      { ignoreSignals: true },
    ),
    c(
      "tickets.create",
      "tkd-create",
      "with-pull-requests",
      {
        title: "Track the rollout PR",
        pullRequests: [
          { url: "https://github.com/acme/app/pull/241/files" },
          { url: "https://gitlab.com/group/project/-/merge_requests/7", state: "merged" },
        ],
      },
      seedLabOnly,
      { ignoreSignals: true },
    ),
    c(
      "tickets.update",
      "tkd-update",
      "with-decision",
      {
        id: "__s-tkt__",
        status: "blocked",
        decision: {
          question: "Keep tarballs?",
          options: ["Skip tarballs", "Store bundles", "Keep both"],
          recommended: "Skip tarballs",
        },
      },
      seedTicket(),
    ),
    // The input replaces the list: a link left in keeps its recorded state (the uppercase link
    // normalizes to the stored one), a new link starts open unless stated, and an omitted link is
    // unlinked.
    c(
      "tickets.update",
      "tkd-update",
      "pull-requests-merge",
      {
        id: "__s-tkt__",
        pullRequests: [
          { url: " HTTPS://GitHub.com/Acme/App/Pull/241/files " },
          { url: "https://example.com/o/r/pull/9", state: "closed" },
        ],
      },
      seedTicket({
        pullRequests: [
          { url: "https://github.com/acme/app/pull/241", state: "merged" },
          { url: "https://example.com/o/r/pull/2", state: "open" },
        ],
      }),
    ),
    c(
      "tickets.update",
      "tkd-update",
      "invalid-decision-refused",
      {
        id: "__s-tkt__",
        decision: { question: "Pick?", options: ["One", "Two"], recommended: "One" },
      },
      seedTicket(),
    ),
    c(
      "tickets.decide",
      "tkd-decide",
      "option-choice",
      { ticketId: "__s-tkt__", optionId: "choice-1" },
      seedTicket({ status: "blocked", decision: storedDecision }),
    ),
    c(
      "tickets.decide",
      "tkd-decide",
      "custom-answer",
      { ticketId: "__s-tkt__", customAnswer: "Handle manually tomorrow" },
      seedTicket({ status: "review", decision: storedDecision }),
    ),
    c(
      "tickets.decide",
      "tkd-decide",
      "missing-option-refused",
      { ticketId: "__s-tkt__", optionId: "choice-99" },
      seedTicket({ status: "blocked" }),
    ),
    c(
      "tickets.decide",
      "tkd-decide",
      "anonymous",
      { ticketId: "__s-tkt__", optionId: "choice-1" },
      undefined,
      { anonymous: true },
    ),
  ];
}
