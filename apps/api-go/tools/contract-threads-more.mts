/**
 * threads.messages and groups.get cases, compared between the TypeScript API and Go. Placeholders
 * are expanded by withIds: `__s-<key>__` is the row `<userId>-<key>`.
 *
 * `declines` says who must answer: true when Go has to hand the request to TypeScript (a reply
 * preview or a block schema that needs the TypeScript renderer), false when Go has to answer it.
 * The body must match TypeScript's either way.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const text = (value: string) => ({ kind: "text", text: value });
const years = new Date(Date.UTC(2020, 0, 1));

export function threadMoreCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  const bot = async (
    seeded: Seeded,
    key: string,
    extra: { space?: 0 | 1; thread?: boolean; archived?: boolean } = {},
  ) => {
    await system.bot.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[extra.space ?? 0],
        userId: seeded.userId,
        name: `Bot ${key}`,
        color: "blue",
        createdAt: years,
        updatedAt: years,
        ...(extra.archived ? { archivedAt: years } : {}),
      },
    });
    if (extra.thread === false) return;
    await system.thread.create({
      data: {
        id: id(seeded, `th-${key}`),
        spaceId: seeded.spaces[extra.space ?? 0],
        userId: seeded.userId,
        botId: id(seeded, key),
        nextMessageSeq: 500,
        nextEventSeq: 500,
      },
    });
  };

  const group = async (
    seeded: Seeded,
    key: string,
    members: string[],
    extra: { archived?: boolean; space?: 0 | 1 } = {},
  ) => {
    await system.chatGroup.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[extra.space ?? 0],
        userId: seeded.userId,
        name: `Group ${key}`,
        createdAt: years,
        updatedAt: years,
        ...(extra.archived ? { archivedAt: years } : {}),
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
        spaceId: seeded.spaces[extra.space ?? 0],
        userId: seeded.userId,
        groupId: id(seeded, key),
        nextMessageSeq: 500,
        nextEventSeq: 500,
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
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, seq)),
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

  const other = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: id(seeded, "other"),
        name: "Other Person",
        email: `${id(seeded, "other")}@example.test`,
        emailVerified: true,
      },
    });

  /** n messages alternating user/bot in a bot thread, skipping one seq when asked. */
  const many = async (seeded: Seeded, count: number, thread = "b1", exclude?: number) => {
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
    name: `tm-${name}`,
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
    name: `gg-${name}`,
    procedure: "groups.get",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });

  const tmCases: Case[] = [
    messages("bot-30-exact", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 30);
    }, { declines: false }),
    messages("bot-31", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 31);
    }, { declines: false }),
    messages("bot-before", { botId: "__s-b1__", before: 20 }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 40);
    }, { declines: false }),
    messages("bot-before-zero", { botId: "__s-b1__", before: 0 }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 5);
    }, { declines: false }),
    messages("bot-before-past-end", { botId: "__s-b1__", before: 999 }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 5);
    }, { declines: false }),
    messages("bot-empty", { botId: "__s-b1__" }, (seeded) => bot(seeded, "b1"), {
      declines: false,
    }),
    messages("bot-no-thread", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { thread: false }),
    ),
    messages("bot-archived", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { archived: true }),
    { declines: false }),
    messages("bot-other-space-wrong-header", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { space: 1 }),
    ),
    messages("bot-other-space-own-header", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { space: 1 }),
    { space: 1, declines: false }),

    // around: the 31-seq window, cut to the page size, with coveredThroughSeq.
    messages("around-seq", { botId: "__s-b1__", around: { seq: 35 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 70);
    }, { declines: false }),
    messages("around-seq-truncated", { botId: "__s-b1__", around: { seq: 0 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 70);
    }, { declines: false }),
    messages("around-seq-clamped", { botId: "__s-b1__", around: { seq: 2 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 40);
    }, { declines: false }),
    messages("around-seq-empty", { botId: "__s-b1__", around: { seq: 400 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 5);
    }, { declines: false }),
    messages(
      "around-message-id",
      { botId: "__s-b1__", around: { messageId: "__s-m35__" } },
      async (seeded) => {
        await bot(seeded, "b1");
        await many(seeded, 70, "b1", 35);
        await message(seeded, "b1", 35, [text("target")], {}, "m35");
      },
      { declines: false },
    ),
    messages(
      "around-message-id-wins-over-seq",
      { botId: "__s-b1__", around: { messageId: "__s-m5x__", seq: 40 } },
      async (seeded) => {
        await bot(seeded, "b1");
        await many(seeded, 70, "b1", 5);
        await message(seeded, "b1", 5, [text("target")], {}, "m5x");
      },
      { declines: false },
    ),
    messages("around-unknown-message-id", { botId: "__s-b1__", around: { messageId: "nope" } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 35);
    }, { declines: false }),
    messages("around-empty-object", { botId: "__s-b1__", around: {} }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 35);
    }, { declines: false }),
    messages("around-over-before", { botId: "__s-b1__", before: 2, around: { seq: 35 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 70);
    }, { declines: false }),
    messages(
      "around-other-thread-message-id",
      { botId: "__s-b1__", around: { messageId: "__s-mb2five__" } },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await many(seeded, 40);
        await many(seeded, 40, "b2", 5);
        await message(seeded, "b2", 5, [text("other thread")], {}, "mb2five");
      },
      { declines: false },
    ),

    // Peer and background runs.
    messages(
      "peer-and-background-filtered",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "peer", "b1", "b1", { status: "completed", trigger: "bot_message" });
        await run(seeded, "tick", "b1", "b1", { status: "completed", trigger: "tickets" });
        await run(seeded, "norm", "b1", "b1", { status: "completed", trigger: "user" });
        await message(seeded, "b1", 0, [text("plain")], { role: "user", authorUserId: seeded.userId });
        await message(seeded, "b1", 1, [{ kind: "steps", steps: [{ label: "s", count: 1 }] }], {
          runId: id(seeded, "peer"),
        });
        await message(seeded, "b1", 2, [text("peer text")], { runId: id(seeded, "peer") });
        await message(seeded, "b1", 3, [{ kind: "thinking", durationMs: 1, lines: [] }], {
          runId: id(seeded, "peer"),
        });
        await message(seeded, "b1", 4, [text("ticket text")], { runId: id(seeded, "tick") });
        await message(seeded, "b1", 5, [{ kind: "ask", text: "need input" }], {
          runId: id(seeded, "tick"),
        });
        await message(seeded, "b1", 6, [text("normal run")], { runId: id(seeded, "norm") });
        await message(seeded, "b1", 7, [text("dangling run")], { runId: "no-such-run" });
      },
      { declines: false },
    ),
    messages("include-peer-runs", { botId: "__s-b1__", includePeerRuns: true }, async (seeded) => {
      await bot(seeded, "b1");
      await run(seeded, "peer", "b1", "b1", { status: "completed", trigger: "bot_message" });
      await message(seeded, "b1", 0, [text("plain")]);
      await message(seeded, "b1", 1, [{ kind: "steps", steps: [{ label: "s", count: 1 }] }], {
        runId: id(seeded, "peer"),
      });
      await message(seeded, "b1", 2, [text("peer text")], { runId: id(seeded, "peer") });
    }, { declines: false }),
    messages(
      "include-peer-receipts",
      { botId: "__s-b1__", includePeerReceipts: true },
      async (seeded) => {
        await bot(seeded, "b1");
        await many(seeded, 5);
        for (let seq = 5; seq < 45; seq += 1)
          await message(
            seeded,
            "b1",
            seq,
            [{ kind: "bot_message_received", fromBotId: "x", fromBotName: "X", text: `r${seq}` }],
            { role: "user" },
          );
      },
      { declines: false },
    ),
    messages("receipt-only-newest-page-scans", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 12);
      for (let seq = 12; seq < 50; seq += 1)
        await message(
          seeded,
          "b1",
          seq,
          [{ kind: "bot_message_sent", toBotId: "x", toBotName: "X", text: `r${seq}` }],
          { role: "user" },
        );
    }, { declines: false }),
    messages(
      "peer-only-page-with-peer-runs",
      { botId: "__s-b1__", includePeerRuns: true },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "peer", "b1", "b1", { status: "completed", trigger: "bot_message" });
        for (let seq = 0; seq < 33; seq += 1)
          await message(seeded, "b1", seq, [text(`p${seq}`)], { runId: id(seeded, "peer") });
      },
      { declines: false },
    ),

    // Message shape: authors, reply previews, call ids, stored blocks.
    messages("authors", { botId: "__s-b1__" }, async (seeded) => {
      await other(seeded);
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("mine")], { role: "user", authorUserId: seeded.userId });
      await message(seeded, "b1", 1, [text("theirs")], {
        role: "user",
        authorUserId: id(seeded, "other"),
      });
      await message(seeded, "b1", 2, [text("gone")], { role: "user", authorUserId: "deleted-user" });
    }, { declines: false }),
    messages("call-id", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("during a call")], {
        role: "user",
        clientNonce: "call:abc:123",
      });
      await message(seeded, "b1", 1, [text("not a call")], { role: "user", clientNonce: "other" });
    }, { declines: false }),
    messages("reply-plain", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("the parent")], { role: "user", authorUserId: seeded.userId });
      await message(seeded, "b1", 1, [text("the reply")], {
        replyToMessageId: id(seeded, "mb1-0"),
      });
    }, { declines: false }),
    messages("reply-quote-only", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("quoted")], { replyQuote: "someone said" });
    }, { declines: false }),
    messages("reply-markdown-declined", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("Sure, I can do **that**.")]);
      await message(seeded, "b1", 1, [text("the reply")], {
        replyToMessageId: id(seeded, "mb1-0"),
      });
    }, { declines: true }),
    messages("reply-parent-other-thread", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await message(seeded, "b2", 0, [text("elsewhere")]);
      await message(seeded, "b1", 0, [text("here")], {
        replyToMessageId: id(seeded, "mb2-0"),
      });
    }, { declines: false }),
    messages("blocks-defaults-and-unknown-keys", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [
        { kind: "text", text: "kept", extra: 1 },
        { kind: "mcp_approval", name: "srv", serverId: "s1", transport: "sse", endpoint: null, needsOAuth: false },
        { kind: "voice_call", title: "t", farewell: "f", durationSeconds: 3 },
      ]);
    }, { declines: false }),
    messages("blocks-out-of-schema", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "text" }]);
    }),
    messages("blocks-not-a-list", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, { kind: "text", text: "not a list" });
    }, { declines: false }),
    messages("seq-negative-stored", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", -1, [text("negative")]);
    }),

    // Groups.
    messages("group", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b2", "b1"]);
      await many(seeded, 10, "g1");
    }, { declines: false }),
    messages("group-archived", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"], { archived: true });
    }),
    messages("group-one-active-member", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2", { archived: true });
      await group(seeded, "g1", ["b1", "b2"]);
    }),
    messages(
      "group-archived-member-left-out",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await bot(seeded, "b3", { archived: true });
        await group(seeded, "g1", ["b3", "b2", "b1"]);
        await many(seeded, 3, "g1");
      },
      { declines: false },
    ),

    // Validation.
    messages("unknown-bot", { botId: "nope" }),
    messages("unknown-group", { groupId: "nope" }),
    messages("neither", {}),
    messages("both", { botId: "__s-b1__", groupId: "__s-g1__" }),
    messages("empty-bot-id", { botId: "" }),
    messages("bot-id-number", { botId: 5 }),
    messages("bot-id-null", { botId: null }),
    messages("before-negative", { botId: "__s-b1__", before: -1 }),
    messages("before-float", { botId: "__s-b1__", before: 1.5 }),
    messages("before-string", { botId: "__s-b1__", before: "2" }),
    messages("before-null", { botId: "__s-b1__", before: null }),
    messages("before-int32-max", { botId: "__s-b1__", before: 2147483647 }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 3);
    }, { declines: false }),
    messages("before-above-int32", { botId: "__s-b1__", before: 2147483648 }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 3);
    }, { declines: false }),
    messages("before-unsafe-int", { botId: "__s-b1__", before: 9007199254740992 }),
    messages("around-seq-int32-max", { botId: "__s-b1__", around: { seq: 2147483647 } }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 3);
    }, { declines: false }),
    messages(
      "around-seq-near-int32-max",
      { botId: "__s-b1__", around: { seq: 2147483640 } },
      async (seeded) => {
        await bot(seeded, "b1");
        await many(seeded, 3);
      },
      { declines: false },
    ),
    messages("bool-string", { botId: "__s-b1__", includePeerRuns: "yes" }),
    messages("bool-null", { botId: "__s-b1__", includePeerReceipts: null }),
    messages("around-number", { botId: "__s-b1__", around: 5 }),
    messages("around-null", { botId: "__s-b1__", around: null }),
    messages("around-seq-string", { botId: "__s-b1__", around: { seq: "1" } }),
    messages("around-seq-negative", { botId: "__s-b1__", around: { seq: -1 } }),
    messages("around-message-empty", { botId: "__s-b1__", around: { messageId: "" } }),
    messages("around-message-number", { botId: "__s-b1__", around: { messageId: 5 } }),
    messages("around-extra-key", { botId: "__s-b1__", around: { messageId: "nope", more: 1 } }),
    messages("no-input", undefined),
    messages("null-input", null),
    messages("array-input", []),
    messages("anonymous", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await many(seeded, 3);
    }, { anonymous: true }),
  ];

  const ggCases: Case[] = [
    groupGet("basic", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b2", "b1"]);
      await message(seeded, "g1", 0, [text("hi group")], {
        role: "user",
        authorUserId: seeded.userId,
      });
      await message(seeded, "g1", 1, [text("hello")], { botId: id(seeded, "b1") });
    }, { declines: false }),
    groupGet("empty", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
    }, { declines: false }),
    groupGet("preview-markdown", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("Saved **monthly_sales_report.csv**")]);
    }, { declines: false }),
    groupGet("preview-delivery", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("real")]);
      await message(seeded, "g1", 1, [
        { kind: "delivery", text: 'Run routine "CRM sync":' },
        { kind: "text", text: "hidden prompt" },
      ]);
    }, { declines: false }),
    groupGet("preview-newest-peer-message", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await run(seeded, "peer", "g1", "b1", { status: "completed", trigger: "bot_message" });
      await message(seeded, "g1", 0, [text("the visible one")]);
      await message(
        seeded,
        "g1",
        1,
        [{ kind: "bot_message_received", fromBotId: "x", fromBotName: "X", text: "r" }],
        { runId: id(seeded, "peer") },
      );
    }, { declines: false }),
    groupGet("preview-not-a-text-block", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [{ kind: "steps", steps: [{ label: "Search", count: 1 }] }]);
    }, { declines: false }),
    groupGet("member-status", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await run(seeded, "r1", "g1", "b1", { status: "waiting_input", trigger: "user" });
      await run(seeded, "r2", "g1", "b2", { status: "running", trigger: "user" });
    }, { declines: false }),
    groupGet("read-state", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("unread")]);
      await system.threadRead.create({
        data: {
          threadId: id(seeded, "th-g1"),
          userId: seeded.userId,
          spaceId: seeded.spaces[0],
          unread: true,
          lastReadSeq: 0,
          snoozedUntil: new Date(Date.UTC(2030, 0, 1)),
        },
      });
    }, { declines: false }),
    groupGet("archived", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"], { archived: true });
    }),
    groupGet("one-active-member", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2", { archived: true });
      await group(seeded, "g1", ["b1", "b2"]);
    }),
    groupGet("archived-member-left-out", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await bot(seeded, "b3", { archived: true });
      await group(seeded, "g1", ["b3", "b2", "b1"]);
      await message(seeded, "g1", 0, [text("x")]);
    }, { declines: false }),
    groupGet("no-thread", { groupId: "__s-g1__" }, async (seeded) => {
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
    groupGet("other-space-wrong-header", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1", { space: 1 });
      await bot(seeded, "b2", { space: 1 });
      await group(seeded, "g1", ["b1", "b2"], { space: 1 });
    }),
    groupGet("receipt-page-scans", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("visible")], { role: "user" });
      for (let seq = 1; seq < 40; seq += 1)
        await message(
          seeded,
          "g1",
          seq,
          [{ kind: "bot_message_received", fromBotId: "x", fromBotName: "X", text: `r${seq}` }],
        );
    }, { declines: false }),
    groupGet("reply-preview", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("parent")]);
      await message(seeded, "g1", 1, [text("reply")], { replyToMessageId: id(seeded, "mg1-0") });
    }, { declines: false }),
    groupGet("reply-markdown-declined", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [text("Sure, I can do **that**.")]);
      await message(seeded, "g1", 1, [text("reply")], { replyToMessageId: id(seeded, "mg1-0") });
    }, { declines: true }),
    groupGet("blocks-undecidable-declined", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [
        {
          kind: "ask",
          text: "which key?",
          status: "pending",
          credential: { name: "k", destination: { kind: "bot", id: "b" } },
        },
      ]);
    }, { declines: true }),
    groupGet("blocks-out-of-schema", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
      await message(seeded, "g1", 0, [{ kind: "text" }]);
    }),
    groupGet("unknown", { groupId: "nope" }),
    groupGet("empty-id", { groupId: "" }),
    groupGet("id-number", { groupId: 5 }),
    groupGet("id-null", { groupId: null }),
    groupGet("extra-key", { groupId: "__s-g1__", more: 1 }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
    }, { declines: false }),
    groupGet("no-input", undefined),
    groupGet("array-input", []),
    groupGet("anonymous", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"]);
    }, { anonymous: true }),
  ];

  return [...tmCases, ...ggCases];
}
