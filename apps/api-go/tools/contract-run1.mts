/**
 * Run slice 1 cases: routines.testRun, skills.testRun and mcp.assignments.approve.
 *
 * Placeholders: `__s-<name>__` expands to `<userId>-<name>` (withIds), so reset
 * (which clears the user's bots, threads, messages and events) owns every row a
 * case seeds. The procedures' task/run/assignment rows are compared through the
 * `run1*` section databaseState adds for these names.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const PLAYBOOK = {
  whenToUse: "when the report is due",
  inputs: ["date", "owner"],
  steps: ["collect", "write"],
  howToCheck: "the report lists both days",
  whatToReturn: "a short summary",
  approvalBoundaries: "do not send",
  failureHandling: "report the error",
};

export function run1Cases(system: System): Case[] {
  const id = (seeded: Seeded, name: string) => `${seeded.userId}-${name}`;

  const bot = (seeded: Seeded, name: string, spaceIndex: 0 | 1 | 2 = 0, extra = {}) =>
    system.bot.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name,
        color: "blue",
        ...extra,
      },
    });

  const thread = (seeded: Seeded, name: string, botName: string, spaceIndex: 0 | 1 | 2 = 0) =>
    system.thread.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        botId: id(seeded, botName),
      },
    });

  const routine = (
    seeded: Seeded,
    name: string,
    botName: string,
    prompt: string,
    extra = {},
    spaceIndex: 0 | 1 | 2 = 0,
  ) =>
    system.routine.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        botId: id(seeded, botName),
        userId: seeded.userId,
        name,
        prompt,
        crons: [],
        ...extra,
      },
    });

  const skill = (
    seeded: Seeded,
    name: string,
    botName: string,
    extra = {},
    spaceIndex: 0 | 1 | 2 = 0,
    userId = seeded.userId,
  ) =>
    system.taughtSkill.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        botId: id(seeded, botName),
        userId,
        name,
        goal: "prepare the report",
        status: "saved",
        playbook: PLAYBOOK,
        ...extra,
      },
    });

  const server = (
    seeded: Seeded,
    name: string,
    extra = {},
    spaceIndex: 0 | 1 | 2 = 0,
    userId = seeded.userId,
  ) =>
    system.mcpServer.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId,
        slug: name,
        name: `Server ${name}`,
        transport: "stdio",
        command: "run",
        allSpaces: true,
        ...extra,
      },
    });

  const card = (
    seeded: Seeded,
    name: string,
    threadName: string,
    serverName: string,
    status: string,
    seq: number,
  ) =>
    system.message.create({
      data: {
        id: id(seeded, name),
        threadId: id(seeded, threadName),
        botId: id(seeded, threadName.replace(/^t/, "b")),
        role: "bot",
        seq,
        blocks: [
          {
            kind: "mcp_approval",
            name: "Server",
            serverId: id(seeded, serverName),
            transport: "stdio",
            endpoint: null,
            needsOAuth: false,
            status,
          },
        ],
      },
    });

  /** A queued run that holds the chat (HOLDS_CHAT): the connected follow-up is skipped. */
  const holdingRun = async (seeded: Seeded, name: string, botName: string, threadName: string) => {
    const taskId = id(seeded, `${name}-task`);
    await system.task.create({
      data: {
        id: taskId,
        spaceId: seeded.spaces[0],
        botId: id(seeded, botName),
        threadId: id(seeded, threadName),
        userId: seeded.userId,
        prompt: "busy",
        status: "queued",
      },
    });
    await system.run.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        botId: id(seeded, botName),
        threadId: id(seeded, threadName),
        taskId,
        userId: seeded.userId,
        status: "queued",
        trigger: "user",
      },
    });
  };

  const routineSeed =
    (prompt = "Do the routine", extra: Record<string, unknown> = {}) =>
    async (seeded: Seeded) => {
      await bot(seeded, "r1b");
      await thread(seeded, "r1t", "r1b");
      await routine(seeded, "r1r", "r1b", prompt, extra);
    };

  const skillSeed = (extra: Record<string, unknown> = {}) => async (seeded: Seeded) => {
    await bot(seeded, "r1b");
    await thread(seeded, "r1t", "r1b");
    await skill(seeded, "r1k", "r1b", extra);
  };

  const approveSeed = (status = "pending") => async (seeded: Seeded) => {
    await bot(seeded, "r1b");
    await thread(seeded, "r1t", "r1b");
    await server(seeded, "r1s");
    await card(seeded, "r1m", "r1t", "r1s", status, 1);
  };

  const routineRun = (
    name: string,
    input: unknown,
    extra: Partial<Case> = {},
    seed = routineSeed(),
  ): Case => ({
    name: `run1-routine-${name}`,
    procedure: "routines.testRun",
    input,
    seed,
    // The harness's in-memory wakeup queue executes the run in TypeScript, whose
    // own run lifecycle publishes extra space changes Go does not run.
    ignoreSignals: true,
    ...extra,
  });

  const skillRun = (name: string, input: unknown, extra: Partial<Case> = {}, seed = skillSeed()): Case => ({
    name: `run1-skill-${name}`,
    procedure: "skills.testRun",
    input,
    seed,
    ignoreSignals: true,
    ...extra,
  });

  const approve = (
    name: string,
    input: unknown,
    extra: Partial<Case> = {},
    seed = approveSeed(),
  ): Case => ({
    name: `run1-approve-${name}`,
    procedure: "mcp.assignments.approve",
    input,
    seed,
    ...extra,
  });

  return [
    // routines.testRun: the target, the pin, and the replay key.
    routineRun("plain", { routineId: "__s-r1r__" }),
    routineRun("pin", { routineId: "__s-r1r__" }, {}, routineSeed("Do it", {
      modelProvider: "openrouter",
      modelId: "acme/model",
      thinkingLevel: "high",
    })),
    routineRun("null-thinking", { routineId: "__s-r1r__" }, {}, routineSeed("Do it", {
      modelProvider: "openrouter",
      modelId: "acme/model",
      thinkingLevel: null,
    })),
    routineRun("goal-prompt", { routineId: "__s-r1r__" }, {}, routineSeed("")),
    routineRun(
      "replay",
      { routineId: "__s-r1r__", clientNonce: "nonce-1" },
      {},
      async (seeded: Seeded) => {
        await routineSeed()(seeded);
        const taskId = id(seeded, "r1rtask");
        await system.task.create({
          data: {
            id: taskId,
            spaceId: seeded.spaces[0],
            botId: id(seeded, "r1b"),
            threadId: id(seeded, "r1t"),
            userId: seeded.userId,
            prompt: "saved",
            status: "queued",
          },
        });
        await system.run.create({
          data: {
            id: id(seeded, "r1run"),
            spaceId: seeded.spaces[0],
            botId: id(seeded, "r1b"),
            threadId: id(seeded, "r1t"),
            taskId,
            userId: seeded.userId,
            status: "queued",
            trigger: "routine",
            routineId: id(seeded, "r1r"),
            clientNonce: `routine-run:${seeded.userId}:nonce-1`,
          },
        });
      },
    ),
    routineRun("unknown", { routineId: "missing" }, { seed: undefined }),
    routineRun(
      "other-space",
      { routineId: "__s-r1r__" },
      {},
      async (seeded: Seeded) => {
        await bot(seeded, "r1b", 1);
        await thread(seeded, "r1t", "r1b", 1);
        await routine(seeded, "r1r", "r1b", "Do it", {}, 1);
      },
    ),
    routineRun("archived-bot", { routineId: "__s-r1r__" }, {}, async (seeded: Seeded) => {
      await bot(seeded, "r1b", 0, { archivedAt: new Date() });
      await routine(seeded, "r1r", "r1b", "Do it");
    }),
    routineRun("threadless-bot", { routineId: "__s-r1r__" }, {}, async (seeded: Seeded) => {
      await bot(seeded, "r1b");
      await routine(seeded, "r1r", "r1b", "Do it");
    }),
    routineRun("empty-id", { routineId: "" }, { seed: undefined }),
    routineRun("id-number", { routineId: 5 }, { seed: undefined }),
    routineRun("no-input", undefined, { seed: undefined }),
    routineRun("null-input", null, { seed: undefined }),
    routineRun("extra-keys", { routineId: "__s-r1r__", more: 1 }),
    routineRun("nonce-empty", { routineId: "__s-r1r__", clientNonce: "" }),
    routineRun("nonce-too-long", { routineId: "__s-r1r__", clientNonce: "x".repeat(201) }),
    routineRun("nonce-number", { routineId: "__s-r1r__", clientNonce: 5 }),
    routineRun("anonymous", { routineId: "__s-r1r__" }, { anonymous: true }),

    // skills.testRun: saved/draft, explicit empty prompt, name fallback, ownership.
    skillRun("saved", { skillId: "__s-r1k__" }),
    skillRun("draft", { skillId: "__s-r1k__" }, {}, skillSeed({ status: "draft" })),
    skillRun("empty-prompt", { skillId: "__s-r1k__", prompt: "" }),
    skillRun(
      "goal-fallback",
      { skillId: "__s-r1k__" },
      {},
      skillSeed({ name: "", goal: "G".repeat(120) }),
    ),
    skillRun("recording", { skillId: "__s-r1k__" }, {}, skillSeed({ status: "recording" })),
    skillRun(
      "other-space",
      { skillId: "__s-r1k__" },
      {},
      async (seeded: Seeded) => {
        await bot(seeded, "r1b", 1);
        await thread(seeded, "r1t", "r1b", 1);
        await skill(seeded, "r1k", "r1b", {}, 1);
      },
    ),
    skillRun("unknown", { skillId: "missing" }, { seed: undefined }),
    skillRun("empty-id", { skillId: "" }, { seed: undefined }),
    skillRun("prompt-null", { skillId: "__s-r1k__", prompt: null }),
    skillRun("prompt-number", { skillId: "__s-r1k__", prompt: 5 }),
    skillRun("no-input", undefined, { seed: undefined }),
    skillRun("anonymous", { skillId: "__s-r1k__" }, { anonymous: true }),

    // mcp.assignments.approve: settings, chat card, the dismissal race, and scope.
    approve("settings", { botId: "__s-r1b__", serverId: "__s-r1s__" }, {}, async (seeded: Seeded) => {
      await bot(seeded, "r1b");
      await thread(seeded, "r1t", "r1b");
      await server(seeded, "r1s");
    }),
    approve("settings-card", { botId: "__s-r1b__", serverId: "__s-r1s__" }),
    approve(
      "chat",
      { botId: "__s-r1b__", serverId: "__s-r1s__", threadId: "__s-r1t__" },
      { ignoreSignals: true },
    ),
    approve(
      "dismissed-race",
      { botId: "__s-r1b__", serverId: "__s-r1s__", threadId: "__s-r1t__" },
      {},
      approveSeed("dismissed"),
    ),
    approve(
      "busy-chat",
      { botId: "__s-r1b__", serverId: "__s-r1s__", threadId: "__s-r1t__" },
      {},
      async (seeded: Seeded) => {
        await approveSeed()(seeded);
        await holdingRun(seeded, "r1busy", "r1b", "r1t");
      },
    ),
    approve("unknown-bot", { botId: "missing", serverId: "__s-r1s__" }),
    approve("unknown-server", { botId: "__s-r1b__", serverId: "missing" }),
    approve(
      "disabled-server",
      { botId: "__s-r1b__", serverId: "__s-r1s__" },
      {},
      async (seeded: Seeded) => {
        await bot(seeded, "r1b");
        await thread(seeded, "r1t", "r1b");
        await server(seeded, "r1s", { enabled: false });
      },
    ),
    approve(
      "other-space-server",
      { botId: "__s-r1b__", serverId: "__s-r1s__" },
      {},
      async (seeded: Seeded) => {
        await bot(seeded, "r1b");
        await thread(seeded, "r1t", "r1b");
        await server(seeded, "r1s", { allSpaces: false }, 1);
      },
    ),
    approve("empty-bot", { botId: "", serverId: "__s-r1s__" }),
    approve("missing-server", { botId: "__s-r1b__" }),
    approve("empty-thread", { botId: "__s-r1b__", serverId: "__s-r1s__", threadId: "" }),
    approve("thread-number", { botId: "__s-r1b__", serverId: "__s-r1s__", threadId: 5 }),
    approve("null-input", null, { seed: undefined }),
    approve("anonymous", { botId: "__s-r1b__", serverId: "__s-r1s__" }, { anonymous: true }),
  ];
}
