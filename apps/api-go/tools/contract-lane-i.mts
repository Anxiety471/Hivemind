/**
 * Lane I cases: groups.list, groups.listArchived, bots.list, bots.listArchived and bots.get —
 * the sidebar reads whose previews come from plainTextFromMarkdown over opened message blocks.
 *
 * Every seed is a row of the case's own Spaces and people, with ids that reset() clears. Times are
 * fixed so both sides of a case seed identical values and the list orders are total.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 0, 1));
// A wake time the run-wakeup scanner will never reach, for runs seeded only to be read.
const NEVER = new Date(Date.UTC(2099, 0, 1));
const at = (seconds: number) => new Date(OLD.getTime() + seconds * 1000);

type MessageSeed = {
  seq: number;
  blocks: unknown[];
  role?: string;
  runKey?: string;
  replyToSeq?: number;
  created?: number;
  /** An absolute instant, for rows that must be recent (a ringing call). */
  createdAt?: Date;
  /** A `call:<id>:request` nonce is what the roster's incoming-call query selects. */
  clientNonce?: string;
};

type RunSeed = {
  key: string;
  status: string;
  trigger: string;
  created?: number;
  /**
   * A queued run with no wake time is due at once for the TypeScript run-wakeup scanner, which
   * then publishes a `runs` space change from its own timer mid-case. These cases only read the
   * status a queued run shows, so they park the wake time out of reach.
   */
  wakeAt?: Date;
};

type BotSeed = {
  key: string;
  space?: 0 | 1 | 2;
  archived?: boolean;
  pinned?: boolean;
  positioned?: number;
  created?: number;
  updated?: number;
  fields?: Record<string, unknown>;
  thread?: boolean;
  nextMessageSeq?: number;
  runs?: RunSeed[];
  messages?: MessageSeed[];
  computer?: { key: string; scope: string };
  read?: { unread: boolean; snoozedUntil?: Date };
};

type GroupSeed = {
  key: string;
  space?: 0 | 1 | 2;
  archived?: boolean;
  pinned?: boolean;
  updated?: number;
  created?: number;
  fields?: Record<string, unknown>;
  thread?: boolean;
  members?: Array<{ bot: string; created?: number }>;
  messages?: MessageSeed[];
  read?: { unread: boolean; snoozedUntil?: Date };
};

export function laneICases(system: System): Case[] {
  const messageID = (threadId: string, seq: number) => `${threadId}-m${seq}`;

  const seedBot = async (seeded: Seeded, spec: BotSeed) => {
    const user = seeded.userId;
    const spaceId = seeded.spaces[spec.space ?? 0];
    const id = `${user}-${spec.key}`;
    const threadId = `${user}-${spec.key}-th`;
    let computerId: string | null = null;
    if (spec.computer) {
      computerId = `${user}-${spec.computer.key}`;
      await system.computer.create({
        data: {
          id: computerId, spaceId, userId: user, kind: "local", scope: spec.computer.scope,
          scopeKey: `${computerId}-sk`, homeKey: `${computerId}-hk`,
        },
      });
    }
    await system.bot.create({
      data: {
        id, spaceId, userId: user, name: `Bot ${spec.key}`, color: "#3B82F6",
        createdAt: at(spec.created ?? 0), updatedAt: at(spec.updated ?? 0),
        ...(spec.archived ? { archivedAt: at(1) } : {}),
        ...(spec.pinned === undefined ? {} : { pinned: spec.pinned }),
        ...(spec.positioned === undefined ? {} : { position: spec.positioned }),
        ...(computerId ? { computerId } : {}),
        ...(spec.fields ?? {}),
      },
    });
    if (spec.thread === false) return { id, threadId: null as string | null, spaceId };
    await system.thread.create({
      data: { id: threadId, spaceId, userId: user, botId: id, nextMessageSeq: spec.nextMessageSeq ?? 0 },
    });
    if (spec.read) {
      await system.threadRead.create({
        data: {
          threadId, userId: user, spaceId, unread: spec.read.unread,
          ...(spec.read.snoozedUntil ? { snoozedUntil: spec.read.snoozedUntil } : {}),
        },
      });
    }
    const runIDs = new Map<string, string>();
    for (const run of spec.runs ?? []) {
      const taskId = `${user}-${spec.key}-${run.key}-task`;
      const runId = `${user}-${spec.key}-${run.key}-run`;
      await system.task.create({
        data: {
          id: taskId, spaceId, botId: id, threadId, userId: user, prompt: "task",
          status: "running", createdAt: at(run.created ?? 0),
        },
      });
      await system.run.create({
        data: {
          id: runId, spaceId, botId: id, threadId, taskId, userId: user,
          status: run.status, trigger: run.trigger, createdAt: at(run.created ?? 0),
          ...(run.wakeAt ? { wakeAt: run.wakeAt } : {}),
        },
      });
      runIDs.set(run.key, runId);
    }
    for (const message of spec.messages ?? []) {
      await system.message.create({
        data: {
          id: messageID(threadId, message.seq), threadId, seq: message.seq,
          role: message.role ?? "bot", blocks: message.blocks,
          createdAt: message.createdAt ?? at(message.created ?? message.seq + 10),
          ...(message.runKey ? { runId: runIDs.get(message.runKey) } : {}),
          ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
          ...(message.replyToSeq === undefined ? {} : { replyToMessageId: messageID(threadId, message.replyToSeq) }),
        },
      });
    }
    return { id, threadId, spaceId };
  };

  const seedGroup = async (seeded: Seeded, spec: GroupSeed) => {
    const user = seeded.userId;
    const spaceId = seeded.spaces[spec.space ?? 0];
    const id = `${user}-${spec.key}`;
    const threadId = `${user}-${spec.key}-th`;
    await system.chatGroup.create({
      data: {
        id, spaceId, userId: user, name: `Group ${spec.key}`,
        createdAt: at(spec.created ?? 0), updatedAt: at(spec.updated ?? 0),
        ...(spec.archived ? { archivedAt: at(1) } : {}),
        ...(spec.pinned === undefined ? {} : { pinned: spec.pinned }),
        ...(spec.fields ?? {}),
      },
    });
    for (const member of spec.members ?? []) {
      await system.chatGroupMember.create({
        data: {
          id: `${id}-${member.bot}`, groupId: id, botId: `${user}-${member.bot}`,
          createdAt: at(member.created ?? 0),
        },
      });
    }
    if (spec.thread === false) return;
    await system.thread.create({
      data: { id: threadId, spaceId, userId: user, groupId: id, nextMessageSeq: spec.messages?.length ?? 0 },
    });
    if (spec.read) {
      await system.threadRead.create({
        data: {
          threadId, userId: user, spaceId, unread: spec.read.unread,
          ...(spec.read.snoozedUntil ? { snoozedUntil: spec.read.snoozedUntil } : {}),
        },
      });
    }
    for (const message of spec.messages ?? []) {
      await system.message.create({
        data: {
          id: messageID(threadId, message.seq), threadId, seq: message.seq,
          role: message.role ?? "user", blocks: message.blocks,
          createdAt: message.createdAt ?? at(message.created ?? message.seq + 10),
        },
      });
    }
  };

  const seedAll = (bots: BotSeed[], groups: GroupSeed[] = []) => async (seeded: Seeded) => {
    for (const bot of bots) await seedBot(seeded, bot);
    for (const group of groups) await seedGroup(seeded, group);
  };

  const text = (value: string) => ({ kind: "text", text: value });
  const delivery = (value: string) => ({ kind: "delivery", text: value });
  const group = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `groups-list-${name}`, procedure: "groups.list", input: undefined, ...extra,
  });
  const archivedGroup = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `groups-archived-${name}`, procedure: "groups.listArchived", input: undefined, ...extra,
  });
  const bot = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `bots-list-${name}`, procedure: "bots.list", input: undefined, ...extra,
  });
  const archivedBot = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `bots-archived-${name}`, procedure: "bots.listArchived", input: undefined, ...extra,
  });
  const getBot = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bots-get-${name}`, procedure: "bots.get", input, ...extra,
  });

  const twoBots: BotSeed[] = [
    { key: "gb1", created: 1 },
    { key: "gb2", created: 2 },
  ];

  return [
    // ---- groups.list -------------------------------------------------------------------------
    group("empty"),
    group(
      "basic",
      {
        seed: seedAll(twoBots, [{
          key: "g1", updated: 100,
          members: [{ bot: "gb1", created: 1 }, { bot: "gb2", created: 2 }],
          messages: [{ seq: 0, blocks: [text("**Hello** [world](https://x.y) and `code`")] }],
        }]),
      },
    ),
    group(
      "order",
      {
        seed: seedAll(twoBots, [
          { key: "ga", pinned: true, updated: 10, created: 1, members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gb", pinned: false, updated: 30, created: 2, members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gc", pinned: false, updated: 20, created: 3, members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gd", pinned: true, updated: 40, created: 4, members: [{ bot: "gb1" }, { bot: "gb2" }] },
        ]),
      },
    ),
    group(
      "preview-newest",
      {
        seed: seedAll(twoBots, [{
          key: "g1",
          members: [{ bot: "gb1" }, { bot: "gb2" }],
          messages: [
            { seq: 0, blocks: [text("old text")] },
            { seq: 1, blocks: [delivery("hidden prompt")] },
            { seq: 2, blocks: [{ kind: "card", lines: [{ k: "a", v: "b" }] }, text("**newest** text")] },
          ],
        }]),
      },
    ),
    group(
      "preview-delivery-only",
      {
        seed: seedAll(twoBots, [{
          key: "g1",
          members: [{ bot: "gb1" }, { bot: "gb2" }],
          messages: [{ seq: 0, blocks: [delivery("prompt"), text("body")] }],
        }]),
      },
    ),
    group(
      "preview-nonstring-text",
      {
        seed: seedAll(twoBots, [{
          key: "g1",
          members: [{ bot: "gb1" }, { bot: "gb2" }],
          messages: [{ seq: 0, blocks: [{ kind: "card", text: 7 }, text("- a\n- b")] }],
        }]),
      },
    ),
    group(
      "preview-markdown-table",
      {
        seed: seedAll(twoBots, [{
          key: "g1",
          members: [{ bot: "gb1" }, { bot: "gb2" }],
          messages: [{
            seq: 0,
            blocks: [text("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n&amp; <b>x</b> \\*y\\* 😀")],
          }],
        }]),
      },
    ),
    group(
      "min-members",
      {
        seed: seedAll(twoBots, [
          { key: "gone", updated: 30, members: [{ bot: "gb1" }] },
          { key: "none", updated: 20 },
          { key: "kept", updated: 10, members: [{ bot: "gb1" }, { bot: "gb2" }] },
        ]),
      },
    ),
    group(
      "archived-bot-member",
      {
        seed: seedAll(
          [twoBots[0]!, { ...twoBots[1]!, archived: true }, { key: "gb3", created: 3 }],
          [
            { key: "half", members: [{ bot: "gb1" }, { bot: "gb2" }] },
            { key: "full", members: [{ bot: "gb1" }, { bot: "gb3" }] },
          ],
        ),
      },
    ),
    group(
      "read-state",
      {
        seed: seedAll(twoBots, [{
          key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }],
          read: { unread: true, snoozedUntil: new Date(Date.UTC(2026, 0, 1)) },
        }]),
      },
    ),
    group(
      "other-space",
      {
        seed: seedAll(twoBots, [
          { key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gx", space: 1, members: [{ bot: "gb1" }, { bot: "gb2" }] },
        ]),
      },
    ),
    group(
      "other-space-header",
      {
        space: 1,
        seed: seedAll(twoBots, [
          { key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gx", space: 1, members: [{ bot: "gb1" }, { bot: "gb2" }] },
        ]),
      },
    ),
    group(
      "no-thread",
      { seed: seedAll(twoBots, [{ key: "g1", thread: false, members: [{ bot: "gb1" }, { bot: "gb2" }] }]) },
    ),
    group(
      "filtered-no-thread",
      {
        // The second group is left out (one active bot), so its missing thread must not be asked
        // for: TypeScript filters before it maps (groups.ts:358-378).
        seed: seedAll(
          [twoBots[0]!, { ...twoBots[1]!, archived: true }, { key: "gb3", created: 3 }],
          [
            { key: "gone", thread: false, members: [{ bot: "gb1" }, { bot: "gb2" }] },
            { key: "kept", updated: 5, members: [{ bot: "gb1" }, { bot: "gb3" }] },
          ],
        ),
      },
    ),
    group("archived-excluded", {
      seed: seedAll(twoBots, [
        { key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] },
        { key: "gold", archived: true, members: [{ bot: "gb1" }, { bot: "gb2" }] },
      ]),
    }),
    group(
      "member-order-and-avatars",
      {
        seed: seedAll(
          [
            { key: "gb1", fields: { avatarSet: "rakazo" } },
            { key: "gb2", fields: { avatarSet: "weird" } },
            { key: "gb3" },
          ],
          [{
            key: "g1",
            members: [
              { bot: "gb2", created: 30 },
              { bot: "gb1", created: 10 },
              { bot: "gb3", created: 20 },
            ],
          }],
        ),
      },
    ),
    group(
      "member-status",
      {
        seed: seedAll(
          [
            {
              key: "gb1",
              runs: [
                { key: "a", status: "queued", trigger: "user", created: 1, wakeAt: NEVER },
                { key: "b", status: "waiting_input", trigger: "user", created: 2 },
              ],
            },
            { key: "gb2", runs: [{ key: "a", status: "running", trigger: "user", created: 1 }, { key: "b", status: "leased", trigger: "user", created: 2 }] },
          ],
          [{ key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] }],
        ),
      },
    ),
    group(
      "section",
      {
        seed: async (seeded: Seeded) => {
          await system.botSection.create({
            data: { id: `${seeded.userId}-sec`, spaceId: seeded.spaces[0], userId: seeded.userId, name: "Section", position: 0 },
          });
          await seedAll(twoBots, [{ key: "g1", fields: { sectionId: `${seeded.userId}-sec` }, members: [{ bot: "gb1" }, { bot: "gb2" }] }])(seeded);
        },
      },
    ),
    group("anonymous", {
      anonymous: true,
      seed: seedAll(twoBots, [{ key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] }]),
    }),
    group("junk-input-ignored", {
      input: { anything: 1 },
      seed: seedAll(twoBots, [{ key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] }]),
    }),

    // ---- groups.listArchived ----------------------------------------------------------------
    archivedGroup(
      "includes-archived",
      {
        seed: seedAll(twoBots, [
          { key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] },
          { key: "gold", archived: true, members: [{ bot: "gb1" }, { bot: "gb2" }] },
        ]),
      },
    ),
    archivedGroup(
      "includes-too-few-active",
      {
        seed: seedAll(
          [twoBots[0]!, { ...twoBots[1]!, archived: true }, { key: "gb3", created: 3 }],
          [
            { key: "half", members: [{ bot: "gb1" }, { bot: "gb2" }] },
            { key: "full", members: [{ bot: "gb1" }, { bot: "gb3" }] },
          ],
        ),
      },
    ),
    archivedGroup(
      "archived-bot-in-roster",
      {
        seed: seedAll(
          [twoBots[0]!, { ...twoBots[1]!, archived: true, fields: { avatarSet: "rakazo" } }, { key: "gb3", created: 3 }],
          [
            { key: "gold", archived: true, updated: 20, members: [{ bot: "gb1" }, { bot: "gb2" }] },
            { key: "garch1", archived: true, updated: 10, members: [{ bot: "gb2" }] },
          ],
        ),
      },
    ),
    archivedGroup(
      "filtered-no-thread",
      {
        // "gone" is selected (it has an archived member) but filtered (two active bots), so its
        // missing thread is never asked for.
        seed: seedAll(
          [twoBots[0]!, { ...twoBots[1]!, archived: true }, { key: "gb3", created: 3 }],
          [
            { key: "gold", archived: true, updated: 5, members: [{ bot: "gb1" }, { bot: "gb3" }] },
            { key: "gone", thread: false, members: [{ bot: "gb1" }, { bot: "gb2" }, { bot: "gb3" }] },
          ],
        ),
      },
    ),
    archivedGroup("empty"),
    archivedGroup("other-space-header", {
      space: 1,
      seed: seedAll(twoBots, [
        { key: "g1", members: [{ bot: "gb1" }, { bot: "gb2" }] },
        { key: "gold", space: 1, archived: true, members: [{ bot: "gb1" }, { bot: "gb2" }] },
      ]),
    }),
    archivedGroup("no-thread", {
      seed: seedAll(twoBots, [{ key: "gold", thread: false, archived: true, members: [{ bot: "gb1" }] }]),
    }),
    archivedGroup("anonymous", {
      anonymous: true,
      seed: seedAll(twoBots, [{ key: "gold", archived: true, members: [{ bot: "gb1" }, { bot: "gb2" }] }]),
    }),

    // ---- bots.list ---------------------------------------------------------------------------
    bot("empty"),
    bot(
      "basic",
      {
        seed: seedAll([{
          key: "b1",
          fields: { description: "does things", instructions: "be kind", webhookSecretId: "wh-secret" },
          messages: [{ seq: 0, blocks: [text("**Hello** from the bot")] }],
        }]),
      },
    ),
    bot(
      "order",
      {
        seed: seedAll([
          { key: "b1", pinned: true, positioned: 5, created: 1 },
          { key: "b2", pinned: false, positioned: 1, created: 2 },
          { key: "b3", pinned: false, positioned: 0, created: 3 },
          { key: "b4", pinned: false, positioned: 0, created: 1 },
        ]),
      },
    ),
    bot("archived-excluded", {
      seed: seedAll([{ key: "b1" }, { key: "b2", archived: true }]),
    }),
    bot("other-space-excluded", {
      seed: seedAll([{ key: "b1" }, { key: "bx", space: 1 }]),
    }),
    bot("other-space-header", {
      space: 1,
      seed: seedAll([{ key: "b1" }, { key: "bx", space: 1, messages: [{ seq: 0, blocks: [text("space two")] }] }]),
    }),
    bot("no-thread", { seed: seedAll([{ key: "b1", thread: false }]) }),
    bot(
      "invalid-row-before-missing-thread",
      {
        // mapBot runs for every row and only then does the router parse the array, so the
        // missing thread wins over an earlier row that is outside BotSchema.
        seed: seedAll([
          { key: "b1", created: 1, fields: { thinkingLevel: "" } },
          { key: "b2", created: 2, thread: false },
        ]),
      },
    ),
    bot(
      "missing-thread-before-invalid-row",
      {
        seed: seedAll([
          { key: "b1", created: 1, thread: false },
          { key: "b2", created: 2, fields: { thinkingLevel: "" } },
        ]),
      },
    ),
    bot(
      "preview-newest-invisible",
      {
        seed: seedAll([{
          key: "b1",
          messages: [
            { seq: 0, blocks: [text("older text")] },
            { seq: 1, blocks: [delivery("hidden")] },
            { seq: 2, blocks: [{ kind: "meta", text: "note" }] },
          ],
        }]),
      },
    ),
    bot(
      "preview-peer-receipt",
      {
        seed: seedAll([{
          key: "b1",
          runs: [{ key: "peer", status: "completed", trigger: "bot_message", created: 1 }],
          messages: [
            { seq: 0, role: "user", blocks: [text("hello")] },
            { seq: 1, blocks: [{ kind: "bot_message_received", intent: "request" }], runKey: "peer" },
            { seq: 2, blocks: [text("peer reply")], runKey: "peer" },
          ],
        }]),
      },
    ),
    bot(
      "preview-peer-relay",
      {
        seed: seedAll([{
          key: "b1",
          runs: [{ key: "peer", status: "completed", trigger: "bot_message", created: 1 }],
          messages: [
            { seq: 0, blocks: [text("hello")] },
            { seq: 1, blocks: [text("peer reply")], runKey: "peer" },
            { seq: 2, blocks: [{ kind: "bot_message_received", intent: "result" }], runKey: "peer", replyToSeq: 0 },
          ],
        }]),
      },
    ),
    bot(
      "preview-background-run",
      {
        seed: seedAll([{
          key: "b1",
          runs: [{ key: "tickets", status: "completed", trigger: "tickets", created: 1 }],
          messages: [
            { seq: 0, blocks: [text("chat text")] },
            { seq: 1, blocks: [text("ticket work")], runKey: "tickets" },
            { seq: 2, blocks: [{ kind: "ask", text: "which one?" }], runKey: "tickets" },
          ],
        }]),
      },
    ),
    bot(
      "preview-page-pages",
      {
        seed: seedAll([{
          key: "b1",
          messages: [
            { seq: 0, blocks: [text("deep page text")] },
            ...Array.from({ length: 20 }, (_, index) => ({
              seq: index + 1,
              blocks: [delivery(`prompt ${index}`)],
            })),
          ],
        }]),
      },
    ),
    bot(
      "preview-five-page-cap",
      {
        seed: seedAll([{
          key: "b1",
          messages: [
            { seq: 0, blocks: [text("beyond five pages")] },
            ...Array.from({ length: 90 }, (_, index) => ({
              seq: index + 1,
              blocks: [delivery(`prompt ${index}`)],
            })),
          ],
        }]),
      },
    ),
    bot(
      "read-state",
      {
        seed: seedAll([{
          key: "b1",
          read: { unread: true, snoozedUntil: new Date(Date.UTC(2026, 5, 1)) },
        }]),
      },
    ),
    bot(
      "status-active",
      {
        seed: seedAll([{
          key: "b1",
          runs: [
            { key: "a", status: "queued", trigger: "user", created: 1, wakeAt: NEVER },
            { key: "b", status: "running", trigger: "user", created: 2 },
            { key: "c", status: "running", trigger: "helper", created: 3 },
            { key: "d", status: "running", trigger: "tickets", created: 4 },
          ],
        }]),
      },
    ),
    bot(
      "status-waiting",
      {
        seed: seedAll([{
          key: "b1",
          runs: [
            { key: "a", status: "running", trigger: "user", created: 1 },
            { key: "b", status: "waiting_takeover", trigger: "user", created: 2 },
          ],
        }]),
      },
    ),
    bot(
      "run-error",
      {
        seed: seedAll([{
          key: "b1",
          runs: [{ key: "a", status: "failed", trigger: "user", created: 1 }],
        }]),
      },
    ),
    bot(
      "run-error-hidden-by-waiting",
      {
        seed: seedAll([{
          key: "b1",
          runs: [
            { key: "a", status: "failed", trigger: "user", created: 1 },
            { key: "b", status: "waiting_input", trigger: "user", created: 2 },
          ],
        }]),
      },
    ),
    bot(
      "run-error-from-helper-thread-is-ignored",
      {
        seed: seedAll([{
          key: "b1",
          runs: [{ key: "a", status: "failed", trigger: "helper", created: 1 }],
        }]),
      },
    ),
    bot(
      "computer-modes",
      {
        seed: seedAll([
          { key: "b1", created: 1, computer: { key: "c1", scope: "dedicated" } },
          { key: "b2", created: 2, computer: { key: "c2", scope: "team" } },
          { key: "b3", created: 3 },
        ]),
      },
    ),
    bot(
      "instruction-history",
      {
        seed: seedAll([{
          key: "b1",
          fields: {
            instructionHistory: [
              { id: "v1", instructions: "one", reason: "first", createdAt: "2021-01-01T00:00:00.000Z", extra: "dropped" },
              { id: "v2", instructions: "two", reason: "second", createdAt: "2021-01-02T00:00:00.000Z" },
            ],
          },
        }]),
      },
    ),
    bot("instruction-history-empty", { seed: seedAll([{ key: "b1", fields: { instructionHistory: [] } }]) }),
    bot(
      "instruction-history-invalid",
      { seed: seedAll([{ key: "b1", fields: { instructionHistory: [{ id: "v1" }] } }]) },
    ),
    bot(
      "model-and-thinking",
      {
        seed: seedAll([
          { key: "b1", created: 1, fields: { modelProvider: "azure-openai-responses", modelId: "gpt-5", thinkingLevel: "max", replyMode: "messages" } },
          { key: "b2", created: 2, fields: { modelProvider: "", modelId: "", thinkingLevel: null } },
          { key: "b3", created: 3, fields: { modelProvider: "anthropic", thinkingLevel: "off" } },
        ]),
      },
    ),
    bot(
      "invalid-thinking-level",
      { seed: seedAll([{ key: "b1", fields: { thinkingLevel: "" } }]) },
    ),
    bot(
      "disabled-tools",
      {
        seed: seedAll([
          { key: "b1", created: 1, fields: { disabledBuiltinTools: [" shell ", "not_a_tool", "shell", "web_search"] } },
          { key: "b2", created: 2, fields: { disabledBuiltinTools: [] } },
        ]),
      },
    ),
    bot(
      "identity-fields",
      {
        seed: seedAll([
          {
            key: "b1",
            created: 1,
            fields: {
              avatarSet: "rakazo", parentBotId: null, spawnKey: "onboarding:first",
              teamChatRules: "be brief", crossSpaceCommunication: false, dailyCheckIns: false,
              fleetManagement: false, memoryScope: "shared", autoSpeak: true, voiceId: "voice-1",
            },
          },
          { key: "b2", created: 2, fields: { avatarSet: "weird", memoryScope: "isolated", spawnKey: null } },
        ]),
      },
    ),
    bot(
      "incoming-call",
      {
        seed: seedAll([{
          key: "b1",
          messages: [
            {
              seq: 0,
              blocks: [{
                kind: "call_request", callId: "call-1", status: "ringing", reason: "urgent",
                opening: "hello", expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }],
              createdAt: new Date(),
              clientNonce: "call:call-1:request",
            },
          ],
        }]),
      },
    ),
    bot(
      "incoming-call-expired",
      {
        seed: seedAll([{
          key: "b1",
          messages: [{
            seq: 0,
            blocks: [{
              kind: "call_request", callId: "call-1", status: "ringing", reason: "urgent",
              opening: "hello", expiresAt: "2020-01-01T00:00:00.000Z",
            }],
            createdAt: new Date(),
            clientNonce: "call:call-1:request",
          }],
        }]),
      },
    ),
    bot(
      "incoming-call-not-first-block",
      {
        seed: seedAll([{
          key: "b1",
          messages: [{
            seq: 0,
            blocks: [
              text("hi"),
              { kind: "call_request", callId: "c", status: "ringing", reason: "r", opening: "o", expiresAt: "2099-01-01T00:00:00.000Z" },
            ],
            createdAt: new Date(),
            clientNonce: "call:call-1:request",
          }],
        }]),
      },
    ),
    bot(
      "incoming-call-nonstring",
      {
        seed: seedAll([{
          key: "b1",
          messages: [{
            seq: 0,
            blocks: [{
              kind: "call_request", callId: 7, status: "ringing", reason: "urgent",
              opening: "hello", expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }],
            createdAt: new Date(),
            clientNonce: "call:call-1:request",
          }],
        }]),
      },
    ),
    bot("anonymous", { anonymous: true, seed: seedAll([{ key: "b1" }]) }),
    bot("junk-input-ignored", { input: { botId: 1 }, seed: seedAll([{ key: "b1" }]) }),

    // ---- bots.listArchived -------------------------------------------------------------------
    archivedBot("includes-archived", { seed: seedAll([{ key: "b1" }, { key: "b2", archived: true, messages: [{ seq: 0, blocks: [text("archived preview")] }] }]) }),
    archivedBot("empty"),
    archivedBot("anonymous", { anonymous: true, seed: seedAll([{ key: "b2", archived: true }]) }),

    // ---- bots.get ----------------------------------------------------------------------------
    getBot("found", { botId: "__user__-b1" }, { seed: seedAll([{ key: "b1", messages: [{ seq: 0, blocks: [text("hi")] }] }]) }),
    getBot("another", { botId: "__user__-b2" }, { seed: seedAll([{ key: "b1" }, { key: "b2" }]) }),
    getBot("archived", { botId: "__user__-b2" }, { seed: seedAll([{ key: "b1" }, { key: "b2", archived: true }]) }),
    getBot("other-space", { botId: "__user__-bx" }, { seed: seedAll([{ key: "b1" }, { key: "bx", space: 1 }]) }),
    getBot("unknown", { botId: "missing" }, { seed: seedAll([{ key: "b1" }]) }),
    getBot("empty-id", { botId: "" }, { seed: seedAll([{ key: "b1" }]) }),
    getBot("number-id", { botId: 7 }, { seed: seedAll([{ key: "b1" }]) }),
    getBot("null-input", null, { seed: seedAll([{ key: "b1" }]) }),
    getBot("no-input", undefined, { seed: seedAll([{ key: "b1" }]) }),
    getBot("array-input", [], { seed: seedAll([{ key: "b1" }]) }),
    getBot("extra-keys", { botId: "__user__-b1", more: true }, { seed: seedAll([{ key: "b1" }]) }),
    getBot(
      "other-row-invalid-thinking",
      { botId: "__user__-b1" },
      { seed: seedAll([{ key: "b1", created: 1 }, { key: "b2", created: 2, fields: { thinkingLevel: "" } }]) },
    ),
    getBot(
      "other-row-invalid-call",
      { botId: "__user__-b1" },
      {
        seed: seedAll([
          { key: "b1", created: 1 },
          {
            key: "b2", created: 2,
            messages: [{
              seq: 0,
              // Must still be ringing at call time, or the invalid callId never reaches the
              // output parse and the case proves nothing.
              blocks: [{ kind: "call_request", callId: 7, status: "ringing", reason: "r", opening: "o", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
              createdAt: new Date(),
              clientNonce: "call:call-2:request",
            }],
          },
        ]),
      },
    ),
    getBot("anonymous", { botId: "__user__-b1" }, { anonymous: true, seed: seedAll([{ key: "b1" }]) }),
  ];
}
