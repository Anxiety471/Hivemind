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
      data: { id: `${userId}-sp-${id}`, spaceId, userId, name: id, color: "blue", updatedAt: OLD, ...extra },
    });
  await bot("b1", spaces[0]);
  await bot("b2", spaces[0], { pinned: true });
  await bot("barch", spaces[0], { archivedAt: OLD });
  await bot("bother", spaces[1]);
  const thread = (id: string, spaceId: string, extra: Record<string, unknown>, next = 10) =>
    system.thread.create({
      data: { id: `${userId}-sp-${id}`, spaceId, userId, nextMessageSeq: next, nextEventSeq: next, ...extra },
    });
  await thread("t-b1", spaces[0], { botId: `${userId}-sp-b1` });
  await thread("t-b2", spaces[0], { botId: `${userId}-sp-b2` });
  await thread("t-barch", spaces[0], { botId: `${userId}-sp-barch` });
  await thread("t-bother", spaces[1], { botId: `${userId}-sp-bother` });
  const message = (id: string, threadId: string, seq: number, blocks: unknown[]) =>
    system.message.create({
      data: { id: `${userId}-sp-${id}`, threadId: `${userId}-sp-${threadId}`, seq, role: "user", blocks },
    });
  await message("m1", "t-b1", 1, [{ kind: "text", text: "Newest in chat one" }]);
  await message("m2", "t-b2", 1, [{ kind: "text", text: "**Pinned** chat" }]);
  await message("m3", "t-bother", 1, [{ kind: "delivery", text: "hidden" }]);
  await system.threadRead.create({
    data: { threadId: `${userId}-sp-t-b1`, userId, spaceId: spaces[0], unread: true, lastReadSeq: 0 },
  });
  await system.botSection.create({
    data: { id: `${userId}-sp-sec1`, spaceId: spaces[0], userId, name: "Section A", position: 0 },
  });
  await system.botSection.create({
    data: { id: `${userId}-sp-sec2`, spaceId: spaces[1], userId, name: "Section B", position: 1 },
  });
  await system.bot.update({ where: { id: `${userId}-sp-b1` }, data: { sectionId: `${userId}-sp-sec1` } });
  await system.chatGroup.create({
    data: { id: `${userId}-sp-g1`, spaceId: spaces[0], userId, name: "Group one", updatedAt: OLD },
  });
  for (const member of ["b1", "b2"]) {
    await system.chatGroupMember.create({
      data: { id: `${userId}-sp-gm-${member}`, groupId: `${userId}-sp-g1`, botId: `${userId}-sp-${member}` },
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
    data: { id: `${userId}-rl-b1`, spaceId: spaces[0], userId, name: "Runner", color: "blue", updatedAt: OLD },
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
  await run("active", { taskId: `${userId}-rl-task-active`, status: "running", trigger: "user", updatedAt: new Date() });
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
        { kind: "bot_message_received", fromBotId: `${userId}-rl-other`, fromBotName: "Researcher", text: "Hi" },
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
    call(
      "peer-multi-blocks-declines",
      { filter: "active" },
      { seed: seedMulti, declines: true },
    ),
    // The recent list is terminal runs only, so the peer runs above do not reach it.
    call("recent-ignores-peer", { filter: "recent" }, { seed: seedRuns, declines: false }),
  ];
}

export function spaceRunCases(db: System): Case[] {
  system = db;
  return [...spaceCases(), ...runCases()];
}
