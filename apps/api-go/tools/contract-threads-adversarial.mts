/**
 * Reviewer's adversarial threads.messages / groups.get cases, registered in contract.mts. Compared
 * between the TypeScript API and Go exactly like contract-threads-more.mts.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const text = (value: string) => ({ kind: "text", text: value });
const years = new Date(Date.UTC(2020, 0, 1));

export function threadAdversarialCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  const bot = async (seeded: Seeded, key: string, space: 0 | 1 = 0) => {
    await system.bot.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        name: `Bot ${key}`,
        color: "blue",
        createdAt: years,
        updatedAt: years,
      },
    });
    await system.thread.create({
      data: {
        id: id(seeded, `th-${key}`),
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        botId: id(seeded, key),
        nextMessageSeq: 100000,
        nextEventSeq: 100000,
      },
    });
  };

  const group = async (seeded: Seeded, key: string, members: string[], space: 0 | 1 = 0) => {
    await system.chatGroup.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        name: `Group ${key}`,
        createdAt: years,
        updatedAt: years,
      },
    });
    let order = 0;
    for (const member of members) {
      await system.chatGroupMember.create({
        data: {
          id: id(seeded, `gm-${key}-${member}`),
          groupId: id(seeded, key),
          botId: id(seeded, member),
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, order++)),
        },
      });
    }
    await system.thread.create({
      data: {
        id: id(seeded, `th-${key}`),
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        groupId: id(seeded, key),
        nextMessageSeq: 100000,
        nextEventSeq: 100000,
      },
    });
  };

  const message = (
    seeded: Seeded,
    thread: string,
    seq: number,
    blocks: unknown,
    extra: Record<string, unknown> = {},
    idKey?: string,
  ) =>
    system.message.create({
      data: {
        id: id(seeded, idKey ?? `m${thread}-${seq}`),
        threadId: id(seeded, `th-${thread}`),
        seq,
        role: "bot",
        blocks,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 0, seq)),
        ...extra,
      },
    });

  const run = async (
    seeded: Seeded,
    key: string,
    thread: string,
    botKey: string,
    fields: Record<string, unknown>,
  ) => {
    await system.task.create({
      data: {
        id: id(seeded, `task-${key}`),
        spaceId: seeded.spaces[0],
        botId: id(seeded, botKey),
        threadId: id(seeded, `th-${thread}`),
        userId: seeded.userId,
        prompt: "p",
        status: "running",
      },
    });
    await system.run.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[0],
        botId: id(seeded, botKey),
        threadId: id(seeded, `th-${thread}`),
        taskId: id(seeded, `task-${key}`),
        userId: seeded.userId,
        status: "running",
        trigger: "user",
        ...fields,
      },
    });
  };

  const many = async (seeded: Seeded, count: number, thread = "a1", exclude?: number) => {
    for (let seq = 0; seq < count; seq += 1) {
      if (seq === exclude) continue;
      await message(seeded, thread, seq, [text(`message ${seq}`)], {
        role: seq % 2 ? "bot" : "user",
        authorUserId: seq % 2 ? undefined : seeded.userId,
      });
    }
  };

  const messages = (
    name: string,
    input: unknown,
    seed?: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `adv-tm-${name}`,
    procedure: "threads.messages",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });

  const groupGet = (
    name: string,
    input: unknown,
    seed?: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `adv-gg-${name}`,
    procedure: "groups.get",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });

  const tmCases: Case[] = [
    // A resolvable around ignores `before` entirely in TypeScript: a huge before must not fail.
    messages(
      "around-ignores-huge-before",
      { botId: "__s-a1__", before: 2147483648, around: { seq: 35 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 70);
      },
      { declines: false },
    ),
    messages(
      "around-message-id-ignores-huge-before",
      { botId: "__s-a1__", before: 2147483648, around: { messageId: "__s-targetmsg__" } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 70, "a1", 35);
        await message(seeded, "a1", 35, [text("target")], {}, "targetmsg");
      },
      { declines: false },
    ),
    // Control: with no around to resolve, the huge before is a request failure on both sides.
    messages(
      "huge-before-without-around",
      { botId: "__s-a1__", before: 2147483648 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 3);
      },
      { declines: false },
    ),
    messages(
      "huge-before-1e15",
      { botId: "__s-a1__", before: 1e15 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 3);
      },
      { declines: false },
    ),

    // The exact int4 boundary of the around window's upper bound.
    messages(
      "around-window-max-int32",
      { botId: "__s-a1__", around: { seq: 2147483632 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 3);
      },
      { declines: false },
    ),
    messages(
      "around-window-past-max-int32",
      { botId: "__s-a1__", around: { seq: 2147483633 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 3);
      },
      { declines: false },
    ),
    messages(
      "around-window-max-int32-with-rows",
      { botId: "__s-a1__", around: { seq: 2147483632 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await message(seeded, "a1", 2147483640, [text("high")]);
        await message(seeded, "a1", 2147483646, [text("higher")]);
      },
      { declines: false },
    ),

    // Validation: the refinement runs only when nothing was an invalid_type.
    messages("both-and-before-string", { botId: "__s-b1__", groupId: "__s-g1__", before: "2" }),
    messages("both-and-before-float", { botId: "__s-b1__", groupId: "__s-g1__", before: 1.5 }),
    messages("both-and-before-too-small", { botId: "__s-b1__", groupId: "__s-g1__", before: -1 }),
    messages("both-and-around-seq-string", {
      botId: "__s-b1__",
      groupId: "__s-g1__",
      around: { seq: "1" },
    }),
    messages("both-and-around-message-empty", {
      botId: "__s-b1__",
      groupId: "__s-g1__",
      around: { messageId: "" },
    }),
    messages("both-and-around-seq-negative", {
      botId: "__s-b1__",
      groupId: "__s-g1__",
      around: { seq: -1 },
    }),
    messages("both-and-around-message-number", {
      botId: "__s-b1__",
      groupId: "__s-g1__",
      around: { messageId: 5 },
    }),

    // Reply parent outside the page still yields its preview.
    messages(
      "reply-parent-outside-page",
      { botId: "__s-a1__" },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 40);
        await message(seeded, "a1", 40, [text("the reply")], {
          replyToMessageId: id(seeded, "ma1-0"),
        });
      },
      { declines: false },
    ),

    // A peer-hidden message as the around target: filtering happens after the window is read.
    messages(
      "around-peer-hidden-target",
      { botId: "__s-a1__", around: { seq: 30 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
        await run(seeded, "peer", "a1", "a1", { status: "completed", trigger: "bot_message" });
        await system.message.update({
          where: { id: id(seeded, "ma1-30") },
          data: {
            runId: id(seeded, "peer"),
            blocks: [{ kind: "thinking", durationMs: 1, lines: [] }],
          },
        });
      },
      { declines: false },
    ),

    // A before page whose whole window is peer chatter scans further back.
    messages(
      "before-page-scans-past-peer-window",
      { botId: "__s-a1__", before: 60 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
        await run(seeded, "peer", "a1", "a1", { status: "completed", trigger: "bot_message" });
        for (let seq = 30; seq < 60; seq += 1) {
          await system.message.update({
            where: { id: id(seeded, `ma1-${seq}`) },
            data: {
              runId: id(seeded, "peer"),
              blocks: [{ kind: "steps", steps: [{ label: "s", count: 1 }] }],
            },
          });
        }
      },
      { declines: false },
    ),

    // A receipt-only before page is returned as-is when receipts are kept.
    messages(
      "before-page-keeps-receipts",
      { botId: "__s-a1__", before: 60, includePeerReceipts: true },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
        for (let seq = 30; seq < 60; seq += 1) {
          await system.message.update({
            where: { id: id(seeded, `ma1-${seq}`) },
            data: {
              role: "user",
              blocks: [
                { kind: "bot_message_received", fromBotId: "x", fromBotName: "X", text: `r${seq}` },
              ],
            },
          });
        }
      },
      { declines: false },
    ),

    // A gap at the around seq leaves the window one row short, so it is not truncated.
    messages(
      "around-seq-gap",
      { botId: "__s-a1__", around: { seq: 36 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 70, "a1", 36);
      },
      { declines: false },
    ),

    // before=1 keeps only seq 0.
    messages(
      "before-one",
      { botId: "__s-a1__", before: 1 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 5);
      },
      { declines: false },
    ),

    // around on an empty thread.
    messages(
      "around-empty-thread",
      { botId: "__s-a1__", around: { seq: 5 } },
      (seeded) => bot(seeded, "a1"),
      {
        declines: false,
      },
    ),

    // A group's thread resolved through resolveWith, not groups.get's own query.
    messages(
      "group-other-space-own-header",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1", 1);
        await bot(seeded, "b2", 1);
        await group(seeded, "g1", ["b1", "b2"], 1);
        await many(seeded, 5, "g1");
      },
      { space: 1, declines: false },
    ),
    messages("group-without-thread", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await system.chatGroup.create({
        data: {
          id: id(seeded, "g1"),
          spaceId: seeded.spaces[0],
          userId: seeded.userId,
          name: "Group g1",
          createdAt: years,
          updatedAt: years,
        },
      });
      let order = 0;
      for (const member of ["b1", "b2"]) {
        await system.chatGroupMember.create({
          data: {
            id: id(seeded, `gm-g1-${member}`),
            groupId: id(seeded, "g1"),
            botId: id(seeded, member),
            createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, order++)),
          },
        });
      }
    }),

    // Page boundaries: exactly 30 rows below the cursor, and 31.
    messages(
      "before-boundary-exactly-a-page",
      { botId: "__s-a1__", before: 30 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
      },
      { declines: false },
    ),
    messages(
      "before-boundary-one-more",
      { botId: "__s-a1__", before: 31 },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
      },
      { declines: false },
    ),

    // The window holds exactly the page size, so it is truncated and covers through its last row.
    messages(
      "around-window-exactly-30",
      { botId: "__s-a1__", around: { seq: 14 } },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 40);
      },
      { declines: false },
    ),

    // includePeerRuns from a before cursor keeps the raw page.
    messages(
      "include-peer-runs-before",
      { botId: "__s-a1__", before: 40, includePeerRuns: true },
      async (seeded) => {
        await bot(seeded, "a1");
        await many(seeded, 60);
        await run(seeded, "peer", "a1", "a1", { status: "completed", trigger: "bot_message" });
        for (let seq = 30; seq < 40; seq += 1) {
          await system.message.update({
            where: { id: id(seeded, `ma1-${seq}`) },
            data: {
              runId: id(seeded, "peer"),
              blocks: [{ kind: "steps", steps: [{ label: "s", count: 1 }] }],
            },
          });
        }
      },
      { declines: false },
    ),
  ];

  const ggCases: Case[] = [
    groupGet(
      "other-space-own-header",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1", 1);
        await bot(seeded, "b2", 1);
        await group(seeded, "g1", ["b1", "b2"], 1);
        await message(seeded, "g1", 0, [text("elsewhere")]);
      },
      { space: 1, declines: false },
    ),
    groupGet(
      "forty-messages",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await group(seeded, "g1", ["b1", "b2"]);
        await many(seeded, 40, "g1");
      },
      { declines: false },
    ),
    groupGet(
      "reply-parent-outside-page",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await group(seeded, "g1", ["b1", "b2"]);
        await many(seeded, 40, "g1");
        await message(seeded, "g1", 40, [text("reply")], { replyToMessageId: id(seeded, "mg1-0") });
      },
      { declines: false },
    ),
    groupGet(
      "non-ascii-markdown-preview",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await group(seeded, "g1", ["b1", "b2"]);
        await system.chatGroup.update({
          where: { id: id(seeded, "g1") },
          data: { name: "Équipe été" },
        });
        await message(seeded, "g1", 0, [text("Résumé **été_2024**.csv `ok` — done")]);
      },
      { declines: false },
    ),
    groupGet(
      "member-newer-waiting-input",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await group(seeded, "g1", ["b1", "b2"]);
        await run(seeded, "old-takeover", "g1", "b1", {
          status: "waiting_takeover",
          trigger: "user",
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 1)),
        });
        await run(seeded, "new-waiting", "g1", "b1", {
          status: "waiting_input",
          trigger: "user",
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 5)),
        });
      },
      { declines: false },
    ),
    groupGet(
      "older-waiting-takeover",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await group(seeded, "g1", ["b1", "b2"]);
        await run(seeded, "old-waiting", "g1", "b1", {
          status: "waiting_input",
          trigger: "user",
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 1)),
        });
        await run(seeded, "new-takeover", "g1", "b1", {
          status: "waiting_takeover",
          trigger: "user",
          createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 5)),
        });
      },
      { declines: false },
    ),
  ];

  return [...tmCases, ...ggCases];
}
