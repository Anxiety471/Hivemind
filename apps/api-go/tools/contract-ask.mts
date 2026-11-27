/**
 * `ask` batch cases (207fca777): AskItemSchema and AskActionSchema.description, ported to Go's
 * askBlock. TypeScript validates these inside the ask block; Go knew neither key, so it stripped
 * `items` and `actions[].description` from every batch ask it answered. The echo cases fail on
 * that stripping even though both sides answer 200; the malformed cases fail if Go accepts a
 * nested shape TypeScript refuses.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const years = new Date(Date.UTC(2020, 0, 1));

export function askCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  const bot = async (seeded: Seeded) => {
    await system.bot.create({
      data: {
        id: id(seeded, "askb1"),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: "Ask bot",
        color: "blue",
        createdAt: years,
        updatedAt: years,
      },
    });
    await system.thread.create({
      data: {
        id: id(seeded, "askth1"),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        botId: id(seeded, "askb1"),
        nextMessageSeq: 500,
        nextEventSeq: 500,
      },
    });
  };

  const message = (seeded: Seeded, seq: number, blocks: unknown) =>
    system.message.create({
      data: {
        id: id(seeded, `askm1-${seq}`),
        threadId: id(seeded, "askth1"),
        seq,
        role: "bot",
        blocks,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, seq)),
      },
    });

  /** A batch ask with both new keys on every item and action. */
  const ask = (items: unknown) => ({
    kind: "ask",
    text: "Three tickets need a decision.",
    items,
  });

  const richItems = [
    {
      id: "item-1",
      question: "Merge the release?",
      detail: "All checks passed",
      ticketRef: "T-1",
      actions: [
        { id: "yes", label: "Merge", description: "Ships 1.2.0", outcome: "created", recommended: true },
        { id: "no", label: "Wait", description: "Hold until Monday" },
      ],
      answer: "yes",
    },
    {
      id: "item-2",
      question: "Close the stale ticket?",
      actions: [{ id: "close", label: "Close", outcome: "cancelled" }],
    },
  ];

  const get = (name: string, blocks: unknown, extra: Partial<Case> = {}): Case => ({
    name: `ask-${name}`,
    procedure: "threads.get",
    input: { botId: "__s-askb1__" },
    seed: async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, blocks);
    },
    ...extra,
  });

  return [
    // Both new keys survive the sealed-block round trip and the body is identical on both sides.
    get("items-echo", [ask(richItems)], { declines: false }),
    // Unknown keys at every level are stripped by both zod and Go's object().
    get(
      "items-unknown-keys-stripped",
      [
        ask([
          {
            id: "item-3",
            question: "Q",
            junk: "strip me",
            actions: [{ id: "a", label: "A", description: "D", junk: 1 }],
          },
        ].map((item) => ({ ...item, itemsJunk: true }))),
      ].map((block) => ({ ...block, junkTop: 1 })),
      { declines: false },
    ),
    // TypeScript refuses these; a Go 200 here is the drift these cases exist for.
    get("items-missing-question", [ask([{ id: "item-4" }])]),
    get("items-question-not-string", [ask([{ id: "item-5", question: 5 }])]),
    get("items-actions-missing-label", [ask([{ id: "item-6", question: "Q", actions: [{ id: "a" }] }])]),
    get("items-action-description-not-string", [
      ask([{ id: "item-7", question: "Q", actions: [{ id: "a", label: "A", description: 5 }] }]),
    ]),
    // The message page reads the same block.
    {
      name: "ask-items-messages",
      procedure: "threads.messages",
      input: { botId: "__s-askb1__" },
      seed: async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [ask(richItems)]);
      },
      declines: false,
    },
  ];
}
