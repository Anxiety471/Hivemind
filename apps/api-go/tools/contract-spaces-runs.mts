/**
 * spaces.list and runs.list: the Space navigation the sidebar reads (spaces.ts:355) and
 * the activity rail (threads/runs.ts).
 *
 * spaces.list reads every Space the member belongs to, with each one's bots, groups,
 * external chats and sections; the seed puts a roster, an archived bot, a section, a group
 * and an external conversation across the fixture's Spaces. runs.list's bot_message
 * preview reads a source message's blocks: the cases cover a valid delivery block, a
 * multi-block message (Go declines) and the no-block fallbacks.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;
let system: System;

const OLD = new Date(Date.UTC(2020, 0, 1));
const FUTURE = new Date(Date.now() + 30 * 86_400_000);

/** A roster across three Spaces: open/archived bots, a section, a group and an external chat. */
async function seedRoster(seeded: Seeded) {
  const { userId, spaces } = seeded;
  const bot = (id: string, spaceId: string, extra: Record<string, unknown> = {}) =>
    system.bot.create({
      data: {
        id: `${userId}-sp-${id}`,
        spaceId,
        userId,
        name: id,
        color: "blue",
        updatedAt: OLD,
        ...extra,
      },
    });
  await bot("b1", spaces[0]);
  await bot("b2", spaces[0], { pinned: true });
  await bot("barch", spaces[0], { archivedAt: OLD });
  await bot("bother", spaces[1]);
  const thread = (id: string, spaceId: string, extra: Record<string, unknown>, next = 10) =>
    system.thread.create({
      data: {
        id: `${userId}-sp-${id}`,
        spaceId,
        userId,
        nextMessageSeq: next,
        nextEventSeq: next,
        ...extra,
      },
    });
  await thread("t-b1", spaces[0], { botId: `${userId}-sp-b1` });
  await thread("t-b2", spaces[0], { botId: `${userId}-sp-b2` });
  await thread("t-barch", spaces[0], { botId: `${userId}-sp-barch` });
  await thread("t-bother", spaces[1], { botId: `${userId}-sp-bother` });
  const message = (id: string, threadId: string, seq: number, blocks: unknown[]) =>
    system.message.create({
      data: {
        id: `${userId}-sp-${id}`,
        threadId: `${userId}-sp-${threadId}`,
        seq,
        role: "user",
        blocks,
      },
    });
  await message("m1", "t-b1", 1, [{ kind: "text", text: "Newest in chat one" }]);
  await message("m2", "t-b2", 1, [{ kind: "text", text: "**Pinned** chat" }]);
  await message("m3", "t-bother", 1, [{ kind: "delivery", text: "hidden" }]);
  await system.threadRead.create({
    data: {
      threadId: `${userId}-sp-t-b1`,
      userId,
      spaceId: spaces[0],
      unread: true,
      lastReadSeq: 0,
    },
  });
  await system.botSection.create({
    data: { id: `${userId}-sp-sec1`, spaceId: spaces[0], userId, name: "Section A", position: 0 },
  });
  await system.botSection.create({
    data: { id: `${userId}-sp-sec2`, spaceId: spaces[1], userId, name: "Section B", position: 1 },
  });
  await system.bot.update({
    where: { id: `${userId}-sp-b1` },
    data: { sectionId: `${userId}-sp-sec1` },
  });
  await system.chatGroup.create({
    data: { id: `${userId}-sp-g1`, spaceId: spaces[0], userId, name: "Group one", updatedAt: OLD },
  });
  for (const member of ["b1", "b2"]) {
    await system.chatGroupMember.create({
      data: {
        id: `${userId}-sp-gm-${member}`,
        groupId: `${userId}-sp-g1`,
        botId: `${userId}-sp-${member}`,
      },
    });
  }
  await thread("t-g1", spaces[0], { groupId: `${userId}-sp-g1` });
  await system.threadRead.create({
    data: {
      threadId: `${userId}-sp-t-g1`,
      userId,
      spaceId: spaces[0],
      unread: false,
      lastReadSeq: 9,
      snoozedUntil: FUTURE,
    },
  });
  await message("m4", "t-g1", 1, [{ kind: "card", lines: [] }]);
  await system.externalConversation.create({
    data: {
      id: `${userId}-sp-e1`,
      provider: "slack",
      workspaceId: "workspace",
      externalKey: "key",
      conversationId: "conversation",
      spaceId: spaces[1],
      botId: `${userId}-sp-bother`,
      userId,
      participantNames: ["Pat"],
      updatedAt: OLD,
    },
  });
  await thread("t-e1", spaces[1], { externalConversationId: `${userId}-sp-e1` });
  await message("m5", "t-e1", 1, [{ kind: "text", text: "External hi" }]);
  for (const [index, name] of ["Ada", "Bob"].entries()) {
    await system.externalMessage.create({
      data: {
        id: `${userId}-sp-em-${index}`,
        externalConversationId: `${userId}-sp-e1`,
        providerEventId: `event-${index}`,
        senderId: `sender-${index}`,
        senderName: name,
        senderIsBot: true,
        content: "x",
      },
    });
  }
  await system.botDeletion.create({
    data: {
      id: `${userId}-sp-del`,
      spaceId: spaces[2],
      name: "Gone",
      deletedByUserId: userId,
      memoriesPreserved: false,
    },
  });
}

/** One bot and chat with a task per run, so every run has its required task row. */
async function seedRuns(seeded: Seeded) {
  const { userId, spaces } = seeded;
  await system.bot.create({
    data: {
      id: `${userId}-rl-b1`,
      spaceId: spaces[0],
      userId,
      name: "Runner",
      color: "blue",
      updatedAt: OLD,
    },
  });
  await system.thread.create({
    data: {
      id: `${userId}-rl-t1`,
      spaceId: spaces[0],
      userId,
      botId: `${userId}-rl-b1`,
      nextMessageSeq: 20,
      nextEventSeq: 20,
    },
  });
  const task = (id: string, prompt: string) =>
    system.task.create({
      data: {
        id: `${userId}-rl-${id}`,
        spaceId: spaces[0],
        botId: `${userId}-rl-b1`,
        threadId: `${userId}-rl-t1`,
        userId,
        prompt,
        status: "completed",
      },
    });
  const run = (id: string, extra: Record<string, unknown>) =>
    system.run.create({
      data: {
        id: `${userId}-rl-${id}`,
        spaceId: spaces[0],
        botId: `${userId}-rl-b1`,
        threadId: `${userId}-rl-t1`,
        userId,
        ...extra,
      },
    });
  await task("task-active", "Review the report\n  now ");
  await run("active", {
    taskId: `${userId}-rl-task-active`,
    status: "running",
    trigger: "user",
    updatedAt: new Date(),
  });
  await task("task-ticket", "Ticket work");
  await run("ticket", {
    taskId: `${userId}-rl-task-ticket`,
    status: "running",
    trigger: "tickets",
    updatedAt: new Date(),
  });
  await task("task-recent", "Finished the report");
  await run("recent", {
    taskId: `${userId}-rl-task-recent`,
    status: "completed",
    trigger: "routine",
    completedAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 60_000),
  });
  await task("task-helper", "Helped");
  await run("helper", {
    taskId: `${userId}-rl-task-helper`,
    status: "completed",
    trigger: "helper",
    completedAt: new Date(Date.now() - 120_000),
    updatedAt: new Date(Date.now() - 120_000),
  });
  // A bot message the preview reads: one valid received block with its source message.
  const source = await system.message.create({
    data: {
      id: `${userId}-rl-source`,
      threadId: `${userId}-rl-t1`,
      seq: 1,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: `${userId}-rl-other`,
          fromBotName: "Researcher",
          text: "Can you check this?",
          intent: "request",
        },
      ],
    },
  });
  await task("task-peer", "Peer");
  await run("peer", {
    taskId: `${userId}-rl-task-peer`,
    status: "running",
    trigger: "bot_message",
    sourceMessageId: source.id,
    updatedAt: new Date(),
  });
}

/** A bot_message source whose blocks this port does not validate block by block. */
async function seedMulti(seeded: Seeded) {
  await seedRuns(seeded);
  const { userId } = seeded;
  const multi = await system.message.create({
    data: {
      id: `${userId}-rl-multi`,
      threadId: `${userId}-rl-t1`,
      seq: 2,
      role: "user",
      blocks: [
        { kind: "text", text: "hello" },
        {
          kind: "bot_message_received",
          fromBotId: `${userId}-rl-other`,
          fromBotName: "Researcher",
          text: "Hi",
        },
      ],
    },
  });
  await system.task.create({
    data: {
      id: `${userId}-rl-task-multi`,
      spaceId: seeded.spaces[0],
      botId: `${userId}-rl-b1`,
      threadId: `${userId}-rl-t1`,
      userId,
      prompt: "Multi",
      status: "completed",
    },
  });
  await system.run.create({
    data: {
      id: `${userId}-rl-multi`,
      spaceId: seeded.spaces[0],
      botId: `${userId}-rl-b1`,
      threadId: `${userId}-rl-t1`,
      userId,
      taskId: `${userId}-rl-task-multi`,
      status: "running",
      trigger: "bot_message",
      sourceMessageId: multi.id,
      updatedAt: new Date(),
    },
  });
}

/** The guest home organization needs the oldest LIVE OWNED organization, not the oldest live one. */
async function seedHomeOrg(seeded: Seeded) {
  const { userId } = seeded;
  await system.space.update({
    where: { id: seeded.spaces[0] },
    data: { deletingAt: new Date(Date.now() - 120_000) },
  });
  const now = Date.now();
  const foreign = async (suffix: string, role: string, at: number) => {
    const orgId = `${userId}-sp-o${suffix}`;
    const spaceId = `${userId}-sp-gs${suffix}`;
    await system.organization.upsert({
      where: { id: orgId },
      update: {},
      create: { id: orgId, name: `Org ${suffix}`, slug: `${orgId}-slug`, createdAt: new Date(at) },
    });
    await system.member.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      update: { role, createdAt: new Date(at) },
      create: { id: `${orgId}-m`, organizationId: orgId, userId, role, createdAt: new Date(at) },
    });
    await system.space.upsert({
      where: { id: spaceId },
      update: {},
      create: { id: spaceId, organizationId: orgId, name: `Space ${suffix}`, isDefault: true },
    });
    await system.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      update: { role, createdAt: new Date(at) },
      create: {
        id: `${spaceId}-m`,
        spaceId,
        organizationId: orgId,
        userId,
        role,
        createdAt: new Date(at),
      },
    });
    return spaceId;
  };
  // Older joined membership, then the owned one, then the host Space the caller is a guest in.
  await foreign("m", "member", now + 1_000);
  await foreign("o", "owner", now + 2_000);
  const host = await foreign("g", "guest", now + 3_000);
  seeded.spaces = [...seeded.spaces, host] as unknown as Seeded["spaces"];
}

/** Stored policies outside AutomatedSenderPoliciesSchema: the handler throws, so TS answers an opaque 500. */
async function seedBadPolicies(seeded: Seeded) {
  const { userId } = seeded;
  await system.bot.create({
    data: {
      id: `${userId}-sp-badpol`,
      spaceId: seeded.spaces[1],
      userId,
      name: "Bad policy bot",
      color: "blue",
    },
  });
  await system.thread.create({
    data: {
      id: `${userId}-sp-t-badpol`,
      spaceId: seeded.spaces[1],
      userId,
      botId: `${userId}-sp-badpol`,
      nextMessageSeq: 10,
      nextEventSeq: 10,
    },
  });
  await system.externalConversation.upsert({
    where: { id: `${userId}-sp-e-bad` },
    update: { automatedSenderPolicies: { alice: { name: "Alice", mode: "bogus" } } as never },
    create: {
      id: `${userId}-sp-e-bad`,
      provider: "slack",
      workspaceId: "workspace",
      externalKey: "key",
      conversationId: "conversation",
      spaceId: seeded.spaces[1],
      botId: `${userId}-sp-badpol`,
      userId,
      participantNames: ["Pat"],
      automatedSenderPolicies: { alice: { name: "Alice", mode: "bogus" } } as never,
    },
  });
  await system.thread.create({
    data: {
      id: `${userId}-sp-t-ebad`,
      spaceId: seeded.spaces[1],
      userId,
      externalConversationId: `${userId}-sp-e-bad`,
      nextMessageSeq: 10,
      nextEventSeq: 10,
    },
  });
}

/** Every bot_message block shape the preview answers: one run each, declined shapes apart. */
const ANSWERED_SHAPES: Array<[string, unknown[]]> = [
  [
    "one-valid",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Researcher",
        text: "Peek",
        intent: "request",
      },
    ],
  ],
  [
    "one-update",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Ops",
        text: "Done",
        intent: "result",
      },
    ],
  ],
  [
    "one-hop",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Ops",
        text: "Chained",
        hop: 2,
      },
    ],
  ],
  [
    "one-blank-text",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Ops",
        text: "   ",
        intent: "fyi",
      },
    ],
  ],
  [
    "one-nel-text",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "Ops", text: "\u0085" }],
  ],
  [
    "one-bom-text",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "Ops", text: "\ufeff" }],
  ],
  [
    "one-bad-intent",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Ops",
        text: "x",
        intent: "shout",
      },
    ],
  ],
  ["one-missing-from", [{ kind: "bot_message_received", fromBotName: "Ops", text: "x" }]],
  [
    "one-empty-id",
    [{ kind: "bot_message_received", fromBotId: "", fromBotName: "Ops", text: "x" }],
  ],
  [
    "one-empty-return",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Ops",
        text: "x",
        returnToMessageId: "",
      },
    ],
  ],
  [
    "one-fractional-hop",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "Ops", text: "Half", hop: 1.5 }],
  ],
  [
    "one-negative-hop",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "Ops", text: "Neg", hop: -1 }],
  ],
  ["empty", []],
  [
    "unknown-name",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "   ", text: "Anon" }],
  ],
  [
    "opaque-name",
    [
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "c1234567890123456789012345",
        text: "Anon",
      },
    ],
  ],
  [
    "long-text",
    [{ kind: "bot_message_received", fromBotId: "b1", fromBotName: "Ops", text: "y".repeat(400) }],
  ],
];

async function seedPeerBlocks(seeded: Seeded) {
  await seedRuns(seeded);
  const { userId } = seeded;
  let seq = 30;
  for (const [name, blocks] of ANSWERED_SHAPES) {
    seq += 1;
    const source = await system.message.create({
      data: {
        id: `${userId}-rl-src-${name}`,
        threadId: `${userId}-rl-t1`,
        seq,
        role: "user",
        blocks: blocks as never,
      },
    });
    await system.task.create({
      data: {
        id: `${userId}-rl-task-${name}`,
        spaceId: seeded.spaces[0],
        botId: `${userId}-rl-b1`,
        threadId: `${userId}-rl-t1`,
        userId,
        prompt: `prompt ${name}`,
        status: "completed",
      },
    });
    await system.run.create({
      data: {
        id: `${userId}-rl-${name}`,
        spaceId: seeded.spaces[0],
        botId: `${userId}-rl-b1`,
        threadId: `${userId}-rl-t1`,
        userId,
        taskId: `${userId}-rl-task-${name}`,
        status: "running",
        trigger: "bot_message",
        sourceMessageId: source.id,
        updatedAt: new Date(),
      },
    });
  }
  // A legacy plaintext block: pgx decodes its JSON numbers as float64, not json.Number.
  const legacy = await system.message.create({
    data: {
      id: `${userId}-rl-src-legacy`,
      threadId: `${userId}-rl-t1`,
      seq: 60,
      role: "user",
      blocks: [{ kind: "text", text: "placeholder" }],
    },
  });
  await system.$executeRawUnsafe(
    `UPDATE messages SET blocks = $1::jsonb WHERE id = $2`,
    JSON.stringify([
      {
        kind: "bot_message_received",
        fromBotId: "b1",
        fromBotName: "Legacy",
        text: "Unsealed",
        hop: 3,
      },
    ]),
    legacy.id,
  );
  await system.task.create({
    data: {
      id: `${userId}-rl-task-legacy`,
      spaceId: seeded.spaces[0],
      botId: `${userId}-rl-b1`,
      threadId: `${userId}-rl-t1`,
      userId,
      prompt: "legacy prompt",
      status: "completed",
    },
  });
  await system.run.create({
    data: {
      id: `${userId}-rl-legacy`,
      spaceId: seeded.spaces[0],
      botId: `${userId}-rl-b1`,
      threadId: `${userId}-rl-t1`,
      userId,
      taskId: `${userId}-rl-task-legacy`,
      status: "running",
      trigger: "bot_message",
      sourceMessageId: legacy.id,
      updatedAt: new Date(),
    },
  });
}

function spaceCases(): Case[] {
  const call = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `sp-${name}`,
    procedure: "spaces.list",
    input: {},
    ...extra,
  });
  return [
    call("empty"),
    call("no-input", { input: undefined }),
    call("roster", { seed: seedRoster }),
    call("roster-in-space-two", { seed: seedRoster, space: 1 }),
    call("roster-in-space-three", { seed: seedRoster, space: 2 }),
    call("input-ignored", { seed: seedRoster, input: { extra: true } }),
    call("anonymous", { seed: seedRoster, anonymous: true }),
    call("home-org-role", { seed: seedHomeOrg, space: 3 as unknown as 0 }),
    call("bad-policies", { seed: seedBadPolicies }),
  ];
}

function runCases(): Case[] {
  const call = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `rl-${name}`,
    procedure: "runs.list",
    input,
    ...extra,
  });
  return [
    call("active-empty", { filter: "active" }),
    call("recent-empty", { filter: "recent" }),
    call("active", { filter: "active" }, { seed: seedRuns }),
    call("recent", { filter: "recent" }, { seed: seedRuns }),
    call("active-with-tickets", { filter: "active", includeTickets: true }, { seed: seedRuns }),
    call("recent-with-tickets", { filter: "recent", includeTickets: true }, { seed: seedRuns }),
    call("active-no-input", undefined),
    call("bad-filter", { filter: "everything" }),
    call("filter-wrong-type", { filter: 3 }),
    call("include-wrong-type", { filter: "active", includeTickets: "yes" }),
    call("null-input", null),
    call("anonymous", { filter: "active" }, { anonymous: true }),
    call("peer-block-answers", { filter: "active" }, { seed: seedRuns, declines: false }),
    call("peer-blocks-answered", { filter: "active" }, { seed: seedPeerBlocks, declines: false }),
    call("peer-multi-blocks-declines", { filter: "active" }, { seed: seedMulti, declines: true }),
    // The recent list is terminal runs only, so the peer runs above do not reach it.
    call("recent-ignores-peer", { filter: "recent" }, { seed: seedRuns, declines: false }),
  ];
}

export function spaceRunCases(db: System): Case[] {
  system = db;
  return [...spaceCases(), ...runCases()];
}
