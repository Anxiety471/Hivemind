/**
 * Routines cases: routines.list, routines.listForMentions and routines.history.
 *
 * Placeholders are expanded by withIds (`__s-<name>__` is `<userId>-<name>`). Ids in this file are
 * `<userId>-<name>`, so reset (which clears the user's bots, threads, messages and events) owns them.
 */
import type { Case, Seeded } from "./contract.mts";

// The seeded Prisma client is passed untyped, as in the other case files; each helper names the
// model call it makes.
// biome-ignore lint/suspicious/noExplicitAny: the harness hands over its Prisma client as a value
type System = any;

export function routineCases(system: System): Case[] {
  const old = new Date(Date.UTC(2020, 0, 1));
  const base = new Date(Date.UTC(2026, 3, 1, 12, 0, 0, 0));
  const minute = (offset: number) => new Date(base.getTime() + offset * 60_000);
  const at = (offset: number) => minute(offset).toISOString();

  const addBot = (
    seeded: Seeded,
    id: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name: id,
        color: "blue",
        ...extra,
      },
    });

  const addRoutine = (
    seeded: Seeded,
    id: string,
    botId: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.routine.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        botId: `${seeded.userId}-${botId}`,
        userId: seeded.userId,
        name: id,
        prompt: "prompt",
        crons: [],
        createdAt: old,
        updatedAt: old,
        ...extra,
      },
    });

  const addThread = (
    seeded: Seeded,
    id: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.thread.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        ...extra,
      },
    });

  const addGroup = (seeded: Seeded, id: string, spaceIndex: 0 | 1 | 2) =>
    system.chatGroup.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name: id,
      },
    });

  const addRun = async (
    seeded: Seeded,
    id: string,
    botId: string,
    threadId: string,
    routineId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const taskId = `${seeded.userId}-task-${id}`;
    await system.task.create({
      data: {
        id: taskId,
        spaceId: seeded.spaces[0],
        botId: `${seeded.userId}-${botId}`,
        threadId: `${seeded.userId}-${threadId}`,
        userId: seeded.userId,
        prompt: "prompt",
        status: "completed",
      },
    });
    return system.run.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        botId: `${seeded.userId}-${botId}`,
        threadId: `${seeded.userId}-${threadId}`,
        taskId,
        userId: seeded.userId,
        status: "completed",
        trigger: "routine",
        routineId: `${seeded.userId}-${routineId}`,
        ...extra,
      },
    });
  };

  const addMessage = (
    seeded: Seeded,
    id: string,
    threadId: string,
    botId: string,
    seq: number,
    role: string,
    extra: Record<string, unknown> = {},
  ) =>
    system.message.create({
      data: {
        id: `${seeded.userId}-${id}`,
        threadId: `${seeded.userId}-${threadId}`,
        botId: `${seeded.userId}-${botId}`,
        seq,
        role,
        blocks: [{ kind: "text", text: id }],
        ...extra,
      },
    });

  // routines.list
  const listSeed = async (seeded: Seeded) => {
    await addBot(seeded, "lb", 0);
    await addBot(seeded, "lbad", 0);
    await addBot(seeded, "lbmp", 0);
    await addBot(seeded, "larch", 0, { archivedAt: old });
    await addBot(seeded, "lsp2", 1);
    await addRoutine(seeded, "lr1", "lb", 0, {
      name: "Morning brief",
      crons: ["0 9 * * *"],
      active: false,
      notify: false,
      inChat: true,
      webhookEnabled: true,
      githubEnabled: true,
      messageProvider: "telegram",
      emailSenders: "owner",
      modelProvider: "azure-openai-responses",
      modelId: "gpt-5",
      thinkingLevel: "high",
      watch: { kind: "command", command: "  df -h  ", everyMinutes: 30, unknown: 1 },
      watchState: {
        checkedAt: at(0),
        outcome: "unchanged",
        fingerprint: "x",
        detail: null,
      },
      lastRunAt: minute(1),
      nextRunAt: new Date(Date.now() + 3_600_000),
      createdAt: minute(2),
    });
    // A watch that no longer fits its schema and an unknown email sender read as null.
    await addRoutine(seeded, "lr2", "lb", 0, {
      name: "Plain",
      watch: { kind: "http", url: "http://example.com" },
      emailSenders: "boss",
    });
    // An overdue live routine is running late.
    await addRoutine(seeded, "lr3", "lb", 0, {
      name: "Late",
      active: true,
      nextRunAt: new Date(Date.now() - 10 * 60_000),
    });
    await addRoutine(seeded, "lr4", "lbad", 0, { thinkingLevel: "turbo" });
    await addRoutine(seeded, "lr5", "lbmp", 0, { messageProvider: "Not A Provider" });
    await addRoutine(seeded, "lr6", "larch", 0);
    await addRoutine(seeded, "lr7", "lsp2", 1);
  };
  const list = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `routine-list-${name}`,
    procedure: "routines.list",
    input,
    seed: listSeed,
    ...extra,
  });

  // routines.listForMentions
  const mentionSeed = async (seeded: Seeded) => {
    await addBot(seeded, "mb", 0);
    await addBot(seeded, "march", 0, { archivedAt: old });
    await addBot(seeded, "mx", 1);
    await addRoutine(seeded, "mr1", "mb", 0, {
      name: "Mention",
      active: true,
      nextRunAt: new Date(Date.now() + 3_600_000),
    });
    await addRoutine(seeded, "mr2", "march", 0);
    await addRoutine(seeded, "mr3", "mx", 1);
  };
  const mentions = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `routine-mentions-${name}`,
    procedure: "routines.listForMentions",
    input,
    seed: mentionSeed,
    ...extra,
  });

  // routines.history
  const historySeed = async (seeded: Seeded) => {
    await addBot(seeded, "hb", 0);
    await addBot(seeded, "harch", 0, { archivedAt: old });
    await addBot(seeded, "hbad", 0);
    await addGroup(seeded, "hg", 0);
    await addThread(seeded, "ht", 0, {
      botId: `${seeded.userId}-hb`,
      nextMessageSeq: 10,
      nextEventSeq: 10,
    });
    await addThread(seeded, "hgt", 0, { groupId: `${seeded.userId}-hg` });
    await addThread(seeded, "hbt", 0, { botId: `${seeded.userId}-hbad` });
    await addRoutine(seeded, "hr", "hb", 0);
    await addRoutine(seeded, "hrarch", "harch", 0);
    await addRoutine(seeded, "hrbad", "hbad", 0);
    await addRun(seeded, "hrun1", "hb", "ht", "hr", {
      createdAt: minute(1),
      startedAt: minute(1),
      completedAt: minute(2),
    });
    await addRun(seeded, "hrun2", "hb", "ht", "hr", {
      status: "failed",
      error: "boom",
      createdAt: minute(2),
    });
    await addRun(seeded, "hrun3", "hb", "hgt", "hr", {
      status: "cancelled",
      lateSince: minute(3),
      createdAt: minute(3),
    });
    await addRun(seeded, "hrun5", "hb", "ht", "hr", {
      status: "failed",
      error: "x".repeat(320),
      createdAt: minute(4),
    });
    // Two runs share an instant: the cursor breaks the tie by id.
    await addRun(seeded, "hrun6", "hb", "ht", "hr", { createdAt: minute(0) });
    await addRun(seeded, "hrun7", "hb", "ht", "hr", { createdAt: minute(0) });
    // The first bot message a run posted is its chat link; a user message is not.
    await addMessage(seeded, "hmsg-user", "ht", "hb", 4, "user");
    await addMessage(seeded, "hmsg-bot", "ht", "hb", 5, "bot", {
      runId: `${seeded.userId}-hrun1`,
    });
    await addRun(seeded, "hrun9", "hbad", "hbt", "hrbad", {
      status: "weird",
      createdAt: minute(5),
    });
  };
  const history = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `routine-history-${name}`,
    procedure: "routines.history",
    input,
    seed: historySeed,
    ...extra,
  });

  const list_: Case[] = [];

  // routines.list
  list_.push(list("own-bot", { botId: "__s-lb__" }, { unordered: true }));
  list_.push(list("own-bot-other-space", { botId: "__s-lsp2__" }, { space: 1, unordered: true }));
  list_.push(list("archived", { botId: "__s-larch__" }));
  list_.push(list("other-space-wrong-header", { botId: "__s-lsp2__" }));
  list_.push(list("unknown", { botId: "nope" }));
  list_.push(list("empty-id", { botId: "" }));
  list_.push(list("id-number", { botId: 5 }));
  list_.push(list("extra-keys", { botId: "__s-lb__", more: 1 }, { unordered: true }));
  list_.push(list("no-input", undefined));
  list_.push(list("null-input", null));
  list_.push(list("array-input", []));
  list_.push(list("output-thinking-level", { botId: "__s-lbad__" }));
  list_.push(list("output-message-provider", { botId: "__s-lbmp__" }));
  list_.push(list("anonymous", { botId: "__s-lb__" }, { anonymous: true }));

  // routines.listForMentions
  list_.push(mentions("one", { botIds: ["__s-mb__"] }, { unordered: true }));
  list_.push(
    mentions(
      "hidden-bots-dropped",
      { botIds: ["__s-mb__", "__s-march__", "__s-mx__", "nope"] },
      { unordered: true },
    ),
  );
  list_.push(mentions("archived-only", { botIds: ["__s-march__"] }, { unordered: true }));
  list_.push(mentions("other-space-only", { botIds: ["__s-mx__"] }, { unordered: true }));
  list_.push(mentions("duplicates", { botIds: ["__s-mb__", "__s-mb__"] }, { unordered: true }));
  list_.push(mentions("extra-keys", { botIds: ["__s-mb__"], more: 1 }, { unordered: true }));
  list_.push(mentions("empty", { botIds: [] }));
  list_.push(
    mentions("too-many", {
      botIds: Array.from({ length: 101 }, () => "__s-mb__"),
    }),
  );
  list_.push(mentions("not-array", { botIds: "x" }));
  list_.push(mentions("item-number", { botIds: ["__s-mb__", 5] }));
  list_.push(mentions("empty-item", { botIds: ["__s-mb__", ""] }));
  list_.push(mentions("no-input", undefined));
  list_.push(mentions("null-input", null));
  list_.push(mentions("array-input", []));
  list_.push(mentions("anonymous", { botIds: ["__s-mb__"] }, { anonymous: true }));

  // routines.history
  list_.push(history("all", { routineId: "__s-hr__" }));
  list_.push(history("limit-two", { routineId: "__s-hr__", limit: 2 }));
  list_.push(
    history("cursor", {
      routineId: "__s-hr__",
      limit: 2,
      before: { id: "__s-hrun3__", createdAt: at(3) },
    }),
  );
  list_.push(
    history("cursor-default-limit", {
      routineId: "__s-hr__",
      before: { id: "__s-hrun5__", createdAt: at(4) },
    }),
  );
  list_.push(
    history("cursor-tie-breaks-by-id", {
      routineId: "__s-hr__",
      before: { id: "__s-hrun7__", createdAt: at(0) },
    }),
  );
  list_.push(
    history("cursor-before-all", {
      routineId: "__s-hr__",
      before: { id: "__s-hrun6__", createdAt: at(0) },
    }),
  );
  list_.push(history("limit-one", { routineId: "__s-hr__", limit: 1 }));
  list_.push(history("cancelled-and-late", { routineId: "__s-hr__", limit: 20 }));
  list_.push(history("other-space", { routineId: "__s-hr__" }, { space: 1 }));
  list_.push(history("archived-bot", { routineId: "__s-hrarch__" }));
  list_.push(history("output-status", { routineId: "__s-hrbad__" }));
  list_.push(history("unknown", { routineId: "nope" }));
  list_.push(history("empty-id", { routineId: "" }));
  list_.push(history("id-number", { routineId: 5 }));
  list_.push(history("limit-zero", { routineId: "__s-hr__", limit: 0 }));
  list_.push(history("limit-high", { routineId: "__s-hr__", limit: 21 }));
  list_.push(history("limit-fraction", { routineId: "__s-hr__", limit: 1.5 }));
  list_.push(history("before-null", { routineId: "__s-hr__", before: null }));
  list_.push(history("before-missing-id", { routineId: "__s-hr__", before: { createdAt: at(1) } }));
  list_.push(
    history("before-bad-date", {
      routineId: "__s-hr__",
      before: { id: "__s-hrun1__", createdAt: "yesterday" },
    }),
  );
  list_.push(
    history("before-date-only", {
      routineId: "__s-hr__",
      before: { id: "__s-hrun1__", createdAt: "2026-04-01" },
    }),
  );
  list_.push(history("no-input", undefined));
  list_.push(history("null-input", null));
  list_.push(history("array-input", []));
  list_.push(history("anonymous", { routineId: "__s-hr__" }, { anonymous: true }));

  return list_;
}
