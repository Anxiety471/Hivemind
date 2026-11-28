/**
 * Reply-preview cases for the block kinds whose quoted text Go reads directly: the preview a reply
 * to a message produces (threads.get's `replyPreview`), compared between the TypeScript API and Go.
 *
 * `agent_message_received` (quoted text) and `import_setup` (its item names) were missing from Go's
 * replyBlockText table, so Go answered an empty caption where TS quoted the block — a silent wire
 * diff, not a 500: the two are now pinned here.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const years = new Date(Date.UTC(2020, 0, 1));

export function replyPreviewCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  const bot = async (seeded: Seeded) => {
    await system.bot.create({
      data: {
        id: id(seeded, "b1"),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: "Bot b1",
        color: "blue",
        createdAt: years,
        updatedAt: years,
      },
    });
    await system.thread.create({
      data: {
        id: id(seeded, "th-b1"),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        botId: id(seeded, "b1"),
        nextMessageSeq: 500,
        nextEventSeq: 500,
      },
    });
  };

  const message = (seeded: Seeded, seq: number, blocks: unknown, extra: Record<string, unknown> = {}) =>
    system.message.create({
      data: {
        id: id(seeded, `m-${seq}`),
        threadId: id(seeded, "th-b1"),
        seq,
        role: "bot",
        blocks,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, seq)),
        ...extra,
      },
    });

  /** A bot message holding `blocks`, then the person's reply to it; threads.get returns both. */
  const replyTo = async (seeded: Seeded, blocks: unknown) => {
    await bot(seeded);
    await message(seeded, 0, blocks);
    await message(seeded, 1, [{ kind: "text", text: "thanks" }], {
      role: "user",
      authorUserId: seeded.userId,
      replyToMessageId: id(seeded, "m-0"),
    });
  };

  const get = (name: string, seed: (seeded: Seeded) => Promise<void>): Case => ({
    name: `rp-${name}`,
    procedure: "threads.get",
    input: { botId: "__s-b1__" },
    seed,
    declines: false,
  });

  return [
    get("agent-message-text", (seeded) =>
      replyTo(seeded, [
        {
          kind: "agent_message_received",
          agentName: "orchestrator",
          text: "Build finished on branch feat/x",
        },
      ]),
    ),
    get("import-setup-item-names", (seeded) =>
      replyTo(seeded, [
        {
          kind: "import_setup",
          items: [
            { kind: "routine", routineId: "r1", name: "Nightly" },
            { kind: "skill", name: "Deploy", needs: [] },
          ],
        },
      ]),
    ),
    get("import-setup-undone-quotes-nothing", (seeded) =>
      replyTo(seeded, [{ kind: "import_setup", items: [], undone: true }]),
    ),
  ];
}
