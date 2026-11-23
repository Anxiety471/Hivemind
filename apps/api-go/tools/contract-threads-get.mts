/**
 * threads.get cases: the thread snapshot of a bot or a group, compared between the TypeScript API and
 * Go. Placeholders are expanded by withIds: `__s-<key>__` is the row `<userId>-<key>`.
 *
 * `declines` says who must answer: true when Go has to hand the request to TypeScript (a reply
 * preview that needs the Markdown renderer, a block schema Go leaves to TypeScript), false when Go
 * has to answer it itself. The body must match TypeScript's either way.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const text = (value: string) => ({ kind: "text", text: value });
const years = new Date(Date.UTC(2020, 0, 1));

export function threadGetCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  /** A Space-one bot with its thread (and optionally a computer), plus a second member and bots. */
  const bot = async (
    seeded: Seeded,
    key: string,
    extra: { space?: 0 | 1; thread?: boolean; archived?: boolean; computer?: string } = {},
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
        ...(extra.computer ? { computerId: id(seeded, extra.computer) } : {}),
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

  const group = async (seeded: Seeded, key: string, members: string[], archived = false) => {
    await system.chatGroup.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: `Group ${key}`,
        createdAt: years,
        updatedAt: years,
        ...(archived ? { archivedAt: years } : {}),
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
        spaceId: seeded.spaces[0],
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
  ) =>
    system.message.create({
      data: {
        id: id(seeded, `m${thread}-${seq}`),
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

  const event = (
    seeded: Seeded,
    thread: string,
    botKey: string,
    seq: number,
    type: string,
    payload: unknown,
    runKey?: string,
  ) =>
    system.event.create({
      data: {
        id: id(seeded, `ev-${thread}-${seq}`),
        spaceId: seeded.spaces[0],
        threadId: id(seeded, `th-${thread}`),
        botId: id(seeded, botKey),
        seq,
        type,
        payload,
        runId: runKey ? id(seeded, runKey) : null,
      },
    });

  const other = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: id(seeded, "other"),
        name: "Other Person",
        email: `${id(seeded, "other")}@example.test`,
        emailVerified: true,
      },
    });

  const computer = (seeded: Seeded, key: string, fields: Record<string, unknown> = {}) =>
    system.computer.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        scope: "team",
        scopeKey: `scope-${id(seeded, key)}`,
        homeKey: `home-${id(seeded, key)}`,
        kind: "docker",
        createdAt: years,
        updatedAt: years,
        ...fields,
      },
    });

  const get = (
    name: string,
    input: unknown,
    seed?: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `tg-${name}`,
    procedure: "threads.get",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });

  /** A bot (b1) whose thread holds one message of every kind a transcript shows. */
  const rich = async (seeded: Seeded) => {
    await other(seeded);
    await bot(seeded, "b1");
    await message(seeded, "b1", 0, [text("hello there")], {
      role: "user",
      authorUserId: seeded.userId,
    });
    await message(seeded, "b1", 1, [text("Sure, I can do **that**.\n\n- one\n- two")]);
    await message(seeded, "b1", 2, [
      {
        kind: "steps",
        steps: [
          {
            label: "Search the web",
            count: 2,
            detail: "cats",
            outcomes: { succeeded: 1, failed: 1 },
          },
          { label: "Read page", count: 1, note: "a note" },
        ],
        durationMs: 5000,
      },
      { kind: "thinking", durationMs: 1200, lines: ["a", "b"] },
    ]);
    await message(seeded, "b1", 3, [
      {
        kind: "ask",
        text: "Which one?",
        status: "answered",
        answer: "a",
        actions: [
          { id: "a", label: "A", recommended: true },
          { id: "b", label: "B" },
        ],
        settingsUpdate: {
          botId: id(seeded, "b1"),
          before: { modelProvider: "  p  ", autoSpeak: true },
          after: { thinkingLevel: null, voiceId: "v" },
        },
        receipt: { items: [{ name: "x", amount: "1" }], amountSource: "page" },
      },
      { kind: "choice", question: "Pick", options: [{ id: "1", letter: "A", label: "one" }] },
    ]);
    await message(seeded, "b1", 4, [
      { kind: "page", pageId: "p1", version: 2, title: "A page" },
      { kind: "image", artifactId: "art1", mimeType: "image/png", name: "pic.png" },
      { kind: "file", artifactId: "art2", mimeType: "text/plain", name: "n.txt", size: 12 },
      { kind: "chart", name: "c", spec: { marks: [{ data: [1, 2] }] }, data: [{ a: 1 }] },
    ]);
    // mcp_approval without its status takes the default; unknown keys are stripped.
    await message(seeded, "b1", 5, [
      {
        kind: "mcp_approval",
        name: "srv",
        serverId: "s1",
        transport: "sse",
        endpoint: null,
        needsOAuth: false,
        extra: { dropped: true },
      },
      { kind: "text", text: "kept", extra: 1 },
      "not a block",
      { notKind: 1 },
      { kind: "voice_call", title: "t", farewell: "f", durationSeconds: 3 },
      {
        kind: "app_connect",
        provider: "p",
        name: "n",
        description: "d",
        logo: null,
        status: "pending",
      },
    ]);
    await message(seeded, "b1", 6, [text("from the other person")], {
      role: "user",
      authorUserId: id(seeded, "other"),
      clientNonce: "call:abc:123",
    });
    await event(seeded, "b1", "b1", 0, "note", { n: 0 });
    await event(seeded, "b1", "b1", 9, "note", { n: 9 });
  };

  /** Two bots and a group of them. */
  const duo = async (seeded: Seeded) => {
    await other(seeded);
    await bot(seeded, "b1");
    await bot(seeded, "b2");
    await group(seeded, "g1", ["b2", "b1"]);
    await message(seeded, "g1", 0, [text("hi group")], {
      role: "user",
      authorUserId: seeded.userId,
    });
    await message(
      seeded,
      "g1",
      1,
      [text("hello"), { kind: "steps", steps: [{ label: "x", count: 1 }] }],
      {
        botId: id(seeded, "b1"),
      },
    );
    await event(seeded, "g1", "b1", 4, "note", { n: 4 });
  };

  /** n messages alternating user/bot in a bot thread. */
  const many = async (seeded: Seeded, count: number) => {
    await bot(seeded, "b1");
    for (let seq = 0; seq < count; seq += 1)
      await message(seeded, "b1", seq, [text(`message ${seq}`)], {
        role: seq % 2 ? "bot" : "user",
      });
  };

  const cases: Case[] = [
    get("bot-rich", { botId: "__s-b1__" }, rich, { declines: false }),
    get("bot-extra-keys-ignored", { botId: "__s-b1__", more: 1 }, rich, { declines: false }),
    get("bot-empty", { botId: "__s-b1__" }, (seeded) => bot(seeded, "b1"), { declines: false }),
    get(
      "bot-archived",
      { botId: "__s-b1__" },
      async (seeded) => bot(seeded, "b1", { archived: true }),
      {
        declines: false,
      },
    ),
    get("bot-without-thread", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { thread: false }),
    ),
    get("bot-other-space-wrong-header", { botId: "__s-b1__" }, (seeded) =>
      bot(seeded, "b1", { space: 1 }),
    ),
    get(
      "bot-other-space-own-header",
      { botId: "__s-b1__" },
      (seeded) => bot(seeded, "b1", { space: 1 }),
      {
        space: 1,
      },
    ),
    get("unknown-bot", { botId: "nope" }),
    get("unknown-group", { groupId: "nope" }),
    get("neither", {}),
    get("both", { botId: "__s-b1__", groupId: "__s-g1__" }),
    get("empty-bot-id", { botId: "" }),
    get("empty-both", { botId: "", groupId: "" }),
    get("bot-id-number", { botId: 5 }),
    get("bot-id-null", { botId: null }),
    get("group-id-array", { groupId: [] }),
    get("no-input", undefined),
    get("null-input", null),
    get("array-input", []),
    get("anonymous", { botId: "__s-b1__" }, rich, { anonymous: true }),

    get("group", { groupId: "__s-g1__" }, duo, { declines: false }),
    get("group-archived", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await group(seeded, "g1", ["b1", "b2"], true);
    }),
    get("group-one-active-member", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2", { archived: true });
      await group(seeded, "g1", ["b1", "b2"]);
    }),
    get("group-archived-member-left-out", { groupId: "__s-g1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await bot(seeded, "b2");
      await bot(seeded, "b3", { archived: true });
      await group(seeded, "g1", ["b3", "b2", "b1"]);
      await message(seeded, "g1", 0, [text("x")]);
    }),

    // Paging: only the newest 30, with the cursor to the rest.
    get("bot-30-exact", { botId: "__s-b1__" }, (seeded) => many(seeded, 30), { declines: false }),
    get("bot-31", { botId: "__s-b1__" }, (seeded) => many(seeded, 31), { declines: false }),
    get("bot-70-multi-page", { botId: "__s-b1__" }, (seeded) => many(seeded, 70), {
      declines: false,
    }),
    get("bot-peer-receipts-only-newest-page", { botId: "__s-b1__" }, async (seeded) => {
      await many(seeded, 12);
      for (let seq = 12; seq < 50; seq += 1)
        await message(
          seeded,
          "b1",
          seq,
          [{ kind: "bot_message_received", fromBotId: "x", fromBotName: "X", text: `r${seq}` }],
          { role: "user" },
        );
    }),

    // Messages of peer and background runs.
    get("peer-and-background-runs-filtered", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await run(seeded, "peer", "b1", "b1", { status: "completed", trigger: "bot_message" });
      await run(seeded, "tick", "b1", "b1", { status: "completed", trigger: "tickets" });
      await run(seeded, "norm", "b1", "b1", { status: "completed", trigger: "user" });
      await message(seeded, "b1", 0, [text("plain")], { role: "user" });
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
      await message(seeded, "b1", 6, [{ kind: "computer", state: "s", text: "t" }], {
        runId: id(seeded, "tick"),
      });
      await message(seeded, "b1", 7, [text("normal run")], { runId: id(seeded, "norm") });
      await message(seeded, "b1", 8, [text("dangling run")], { runId: "no-such-run" });
    }),

    get("background-run-user-messages", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await run(seeded, "tick", "b1", "b1", { status: "completed", trigger: "tickets" });
      await message(seeded, "b1", 0, [text("Are you free right now?")], {
        role: "user",
        runId: id(seeded, "tick"),
      });
      await message(seeded, "b1", 1, [{ kind: "delivery" }, text("Work on ticket TASK-1.")], {
        role: "user",
        runId: id(seeded, "tick"),
      });
      await message(seeded, "b1", 2, [text("ticket bot text")], { runId: id(seeded, "tick") });
    }),

    // Runs: active, waiting, failed, superseded; their live events.
    get(
      "bot-live-run",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("go")], { role: "user" });
        await run(seeded, "r1", "b1", "b1", {
          status: "running",
          modelProvider: "p",
          modelId: "m",
          startedAt: new Date(),
        });
        await event(seeded, "b1", "b1", 1, "thread.progress", { delta: "Looking into it. " }, "r1");
        await event(
          seeded,
          "b1",
          "b1",
          2,
          "agent.tool.called",
          { name: "web_search", detail: " cats " },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          3,
          "agent.tool.called",
          { name: "web_search", detail: "cats" },
          "r1",
        );
        await event(seeded, "b1", "b1", 4, "agent.tool.completed", { name: "web_search" }, "r1");
        await event(
          seeded,
          "b1",
          "b1",
          5,
          "thread.thinking",
          { segment: 0, durationMs: 1500, lines: ["x", 3, "y"] },
          "r1",
        );
        await event(seeded, "b1", "b1", 6, "thread.progress", { delta: "Half a sent" }, "r1");
        await event(seeded, "b1", "b1", 7, "agent.tool.called", { name: "ask_user" }, "r1");
        await event(seeded, "b1", "b1", 8, "agent.tool.called", { name: "READ_FILE" }, "r1");
        await event(
          seeded,
          "b1",
          "b1",
          9,
          "thread.subagent",
          { agentId: "a1", name: "Helper", task: "do", status: "running", progress: "50%" },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          10,
          "thread.subagent",
          { agentId: "a2", name: "Done", task: "t", status: "completed", result: "ok" },
          "r1",
        );
      },
      { declines: false },
    ),
    get(
      "bot-live-reset-and-activity",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "r1", "b1", "b1", { status: "leased" });
        await event(
          seeded,
          "b1",
          "b1",
          1,
          "thread.progress",
          { text: "Searching...", activity: true },
          "r1",
        );
        await event(seeded, "b1", "b1", 2, "thread.progress", { delta: "text then " }, "r1");
        await event(
          seeded,
          "b1",
          "b1",
          3,
          "agent.tool.called",
          { name: "run_command", detail: "ls" },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          4,
          "thread.progress",
          { reset: true, text: "again. " },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          5,
          "thread.thinking",
          { segment: 1, durationMs: "5", lines: ["l"] },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          6,
          "thread.thinking",
          { segment: 0, durationMs: -4, lines: [] },
          "r1",
        );
      },
      { declines: false },
    ),
    get(
      "bot-live-subagent-stops-with-pause",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "r1", "b1", "b1", { status: "waiting_input" });
        await event(
          seeded,
          "b1",
          "b1",
          1,
          "thread.subagent",
          { agentId: "a1", name: "H", task: "t", status: "running" },
          "r1",
        );
        await event(seeded, "b1", "b1", 2, "run.waiting_input", {}, "r1");
        await event(seeded, "b1", "b1", 3, "thread.progress", { delta: "after the wait. " }, "r1");
      },
      { declines: false },
    ),
    get(
      "bot-live-subagent-already-persisted",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "r1", "b1", "b1", { status: "running" });
        await message(seeded, "b1", 0, [
          { kind: "subagent", agentId: "a1", name: "H", task: "t", status: "completed" },
        ]);
        await event(
          seeded,
          "b1",
          "b1",
          1,
          "thread.subagent",
          { agentId: "a1", name: "H", task: "t", status: "running" },
          "r1",
        );
        await event(
          seeded,
          "b1",
          "b1",
          2,
          "thread.subagent",
          { agentId: "a2", name: "H2", task: "t", status: "running" },
          "r1",
        );
      },
      { declines: false },
    ),
    get(
      "bot-peer-run-active-not-live",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "r1", "b1", "b1", { status: "running", trigger: "bot_message" });
        await event(seeded, "b1", "b1", 1, "thread.progress", { delta: "hidden" }, "r1");
      },
      { declines: false },
    ),
    get(
      "bot-ticket-run-waiting-shows",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "r1", "b1", "b1", { status: "waiting_input", trigger: "tickets" });
        await run(seeded, "r2", "b1", "b1", { status: "running", trigger: "tickets" });
      },
      { declines: false },
    ),
    get(
      "bot-active-run-priority",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "q", "b1", "b1", {
          status: "queued",
          createdAt: new Date(Date.now() - 1000),
        });
        await run(seeded, "l", "b1", "b1", {
          status: "leased",
          createdAt: new Date(Date.now() - 2000),
        });
        await run(seeded, "w", "b1", "b1", {
          status: "waiting_input",
          createdAt: new Date(Date.now() - 3000),
        });
      },
      { declines: false },
    ),
    get(
      "bot-failed-latest",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", {
          status: "failed",
          error: `  ${"boom ".repeat(100)}  `,
          completedAt: new Date(),
          createdAt: new Date(Date.now() - 5000),
        });
      },
      { declines: false },
    ),
    get(
      "bot-failed-fallback-summary",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", {
          status: "failed",
          error: JSON.stringify({
            modelFallbackVersion: 1,
            primaryError: "p".repeat(400),
            backups: [
              { provider: "x", modelId: "y", status: "failed", reason: "r".repeat(350), extra: 1 },
            ],
          }),
        });
      },
      { declines: false },
    ),
    get(
      "bot-failed-emoji-clamp",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", {
          status: "failed",
          error: `${"a".repeat(299)}😀tail`,
        });
      },
      { declines: false },
    ),
    get(
      "bot-failed-no-error",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", { status: "failed", error: "   " });
      },
      { declines: false },
    ),
    get(
      "bot-failed-superseded-by-completed",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", {
          status: "failed",
          error: "old",
          createdAt: new Date(Date.now() - 9000),
        });
        await run(seeded, "c1", "b1", "b1", {
          status: "completed",
          createdAt: new Date(Date.now() - 1000),
        });
      },
      { declines: false },
    ),
    get(
      "bot-failed-with-ticket-completed-after",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await run(seeded, "f1", "b1", "b1", {
          status: "failed",
          error: "old",
          createdAt: new Date(Date.now() - 9000),
        });
        await run(seeded, "c1", "b1", "b1", {
          status: "completed",
          trigger: "tickets",
          createdAt: new Date(Date.now() - 1000),
        });
      },
      { declines: false },
    ),
    get(
      "bot-run-with-routine",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await system.routine.create({
          data: {
            id: id(seeded, "rt"),
            spaceId: seeded.spaces[0],
            botId: id(seeded, "b1"),
            userId: seeded.userId,
            name: "Morning",
            prompt: "p",
            timezone: "UTC",
            crons: [],
            updatedAt: new Date(),
          },
        });
        await run(seeded, "r1", "b1", "b1", {
          status: "running",
          trigger: "routine",
          routineId: id(seeded, "rt"),
        });
      },
      { declines: false },
    ),
    get("bot-run-invalid-trigger", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await run(seeded, "r1", "b1", "b1", { status: "running", trigger: "mystery" });
    }),
    get(
      "bot-helper-run-waiting-in-other-thread",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await message(seeded, "b1", 0, [text("card")]);
        await run(seeded, "h1", "b2", "b2", {
          status: "waiting_input",
          trigger: "helper",
          sourceMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "group-live-and-failed",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await duo(seeded);
        await run(seeded, "r1", "g1", "b1", { status: "running", modelId: "m" });
        await run(seeded, "r2", "g1", "b2", {
          status: "waiting_input",
          createdAt: new Date(Date.now() - 500),
        });
        await run(seeded, "fx", "g1", "b2", {
          status: "failed",
          error: "bad",
          completedAt: new Date(Date.now() - 4000),
        });
        await event(seeded, "g1", "b1", 5, "thread.progress", { delta: "typing" }, "r1");
      },
      { declines: false },
    ),
    get(
      "group-failed-terminal-wins-over-active",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await duo(seeded);
        await run(seeded, "r1", "g1", "b1", { status: "running" });
        await run(seeded, "fx", "g1", "b2", {
          status: "failed",
          error: "bad",
          completedAt: new Date(),
        });
      },
      { declines: false },
    ),
    get(
      "group-completed-after-failed",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await duo(seeded);
        await run(seeded, "fx", "g1", "b2", {
          status: "failed",
          error: "bad",
          completedAt: new Date(Date.now() - 3000),
        });
        await run(seeded, "ok", "g1", "b2", {
          status: "completed",
          completedAt: new Date(Date.now() - 1000),
        });
      },
      { declines: false },
    ),
    get(
      "group-member-statuses",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await duo(seeded);
        await run(seeded, "a", "b1", "b1", { status: "running" });
        await run(seeded, "b", "b1", "b1", {
          status: "queued",
          createdAt: new Date(Date.now() + 1000),
        });
        await run(seeded, "c", "b2", "b2", { status: "queued", trigger: "tickets" });
        await run(seeded, "d", "b2", "b2", { status: "leased", trigger: "helper" });
      },
      { declines: false },
    ),

    // Replies and their previews.
    get(
      "reply-to-user-parent",
      { botId: "__s-b1__" },
      async (seeded) => {
        await other(seeded);
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("**not markdown** to a user parent\nsecond line")], {
          role: "user",
          authorUserId: id(seeded, "other"),
        });
        await message(seeded, "b1", 1, [text("answer")], {
          replyToMessageId: id(seeded, "mb1-0"),
          replyQuote: "markdown",
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-bot-plain-text",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("Plain sentence, with commas. And 3.5 numbers")]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-bot-markdown",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("**Bold** start")]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: true },
    ),
    get(
      "reply-to-bot-multiline",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("line one\nline two")]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: true },
    ),
    get(
      "reply-to-bot-steps-then-text",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "steps", steps: [{ label: "Look", count: 1 }] },
          text(""),
        ]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-bot-cards-only",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "card", lines: [{ k: "a", v: "b" }] },
          { kind: "ask", text: "question?" },
          { kind: "choice", question: "pick one", options: [] },
        ]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-ask-kinds",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "ask", text: "secret please", input: "secret" },
          { kind: "ask", text: "approve?", approvalEffectId: "e1" },
          { kind: "ask", text: "a real question" },
        ]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-attachments",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "image", artifactId: "a1", mimeType: "image/png", name: "i.png" },
        ]);
        await message(seeded, "b1", 1, [
          { kind: "file", artifactId: "a2", mimeType: "text/plain", name: "f.txt", size: 1 },
        ]);
        await message(seeded, "b1", 2, [
          { kind: "page", pageId: "p1", version: 1, title: "Title" },
        ]);
        await message(seeded, "b1", 3, [
          { kind: "image", artifactId: "a1", mimeType: "image/png", name: "i.png" },
          text(""),
        ]);
        for (const seq of [0, 1, 2, 3])
          await message(seeded, "b1", 10 + seq, [text("ok")], {
            role: "user",
            replyToMessageId: id(seeded, `mb1-${seq}`),
          });
      },
      { declines: false },
    ),
    get(
      "reply-to-delivery",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [{ kind: "delivery" }, text("hidden prompt")], {
          role: "user",
        });
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-quote-without-parent",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("a")], { role: "user", replyQuote: "quoted" });
      },
      { declines: false },
    ),
    get(
      "reply-parent-in-other-thread",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await bot(seeded, "b2");
        await message(seeded, "b2", 0, [text("**md**")]);
        await message(seeded, "b1", 0, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb2-0"),
        });
      },
      { declines: false },
    ),
    get("reply-parent-with-invalid-block", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "text" }]);
      await message(seeded, "b1", 1, [text("ok")], {
        role: "user",
        replyToMessageId: id(seeded, "mb1-0"),
      });
    }),
    get(
      "reply-parent-with-junk-entry",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("fine"), 7]);
        await message(seeded, "b1", 1, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-to-bot-in-group",
      { groupId: "__s-g1__" },
      async (seeded) => {
        await duo(seeded);
        await message(seeded, "g1", 2, [text("Plain words only")], { botId: id(seeded, "b2") });
        await message(seeded, "g1", 3, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mg1-2"),
          authorUserId: id(seeded, "other"),
        });
      },
      { declines: false },
    ),
    get(
      "reply-parent-author-in-preview",
      { botId: "__s-b1__" },
      async (seeded) => {
        await other(seeded);
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [text("Said by other")], {
          role: "user",
          authorUserId: id(seeded, "other"),
        });
        await message(seeded, "b1", 1, [text("deleted author")], {
          role: "user",
          authorUserId: "gone-user",
        });
        await message(seeded, "b1", 2, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-0"),
        });
        await message(seeded, "b1", 3, [text("ok")], {
          role: "user",
          replyToMessageId: id(seeded, "mb1-1"),
        });
      },
      { declines: false },
    ),

    // Stored blocks the output schema refuses, strips or leaves to TypeScript.
    get("block-text-without-text", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "text" }]);
    }),
    get("block-unknown-kind", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "legacy_thing", text: "x" }]);
    }),
    get("block-bad-enum-and-ints", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "steps", steps: [{ label: "a", count: 0 }] }]);
    }),
    get("block-fractional-duration", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "thinking", durationMs: 1.5, lines: [] }]);
    }),
    get("block-routine-name-too-long", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [
        { kind: "routine_event", change: "created", name: "n".repeat(201) },
      ]);
    }),
    get("block-chart-too-many-rows", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [
        { kind: "chart", name: "c", spec: { data: new Array(5000).fill(1) }, data: [1] },
      ]);
    }),
    get("block-login-fields-duplicate", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [{ kind: "ask", text: "x", loginFields: ["User", " user "] }]);
    }),
    get(
      "block-login-fields-trimmed",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "ask", text: "x", loginFields: [" User ", "Pass"], sharedBrowser: true },
        ]);
      },
      { declines: false },
    ),
    get(
      "block-ask-with-credential-goes-to-typescript",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          {
            kind: "ask",
            text: "key?",
            input: "secret",
            credential: {
              name: "api-key",
              origin: "https://example.com",
              auth: { type: "bearer" },
            },
          },
        ]);
      },
      { declines: false },
    ),
    get(
      "block-one-time-code-goes-to-typescript",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "ask", text: "code?", oneTimeCode: { origin: "https://example.com" } },
        ]);
      },
      { declines: false },
    ),
    get(
      "block-import-setup-goes-to-typescript",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, [
          { kind: "import_setup", items: [{ kind: "routine", routineId: "r", name: "n" }] },
        ]);
      },
      { declines: false },
    ),
    get(
      "blocks-not-a-list",
      { botId: "__s-b1__" },
      async (seeded) => {
        await bot(seeded, "b1");
        await message(seeded, "b1", 0, { kind: "text", text: "not in a list" });
        await message(seeded, "b1", 1, "plain string");
      },
      { declines: false },
    ),
    get("message-invalid-role", { botId: "__s-b1__" }, async (seeded) => {
      await bot(seeded, "b1");
      await message(seeded, "b1", 0, [text("x")], { role: "robot" });
    }),

    // The computer.
    get(
      "computer-running-busy",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "running",
          homeRevision: "rev1",
          diskUsedBytes: 95n,
          diskFreeBytes: 5n,
        });
        await bot(seeded, "b1", { computer: "c1" });
        await run(seeded, "r1", "b1", "b1", { status: "running" });
        await system.computerExecutionLease.create({
          data: {
            id: id(seeded, "lease"),
            computerId: id(seeded, "c1"),
            botId: id(seeded, "b1"),
            runId: id(seeded, "r1"),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
      },
      { declines: false },
    ),
    get(
      "computer-lease-without-run",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", { state: "booting", kind: "desktop" });
        await bot(seeded, "b1", { computer: "c1" });
        await system.computerExecutionLease.create({
          data: {
            id: id(seeded, "lease"),
            computerId: id(seeded, "c1"),
            botId: id(seeded, "b1"),
            runId: "no-run",
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
      },
      { declines: false },
    ),
    get(
      "computer-expired-lease",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", { state: "suspending", kind: "boat" });
        await bot(seeded, "b1", { computer: "c1" });
        await system.computerExecutionLease.create({
          data: {
            id: id(seeded, "lease"),
            computerId: id(seeded, "c1"),
            botId: id(seeded, "b1"),
            runId: "no-run",
            expiresAt: new Date(Date.now() - 600_000),
          },
        });
      },
      { declines: false },
    ),
    get(
      "computer-takeover-requested",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "running",
          controlHolder: "bot",
          controlBotId: id(seeded, "b1"),
        });
        await bot(seeded, "b1", { computer: "c1" });
        await run(seeded, "r1", "b1", "b1", { status: "waiting_takeover" });
        await system.computerExecutionLease.create({
          data: {
            id: id(seeded, "lease"),
            computerId: id(seeded, "c1"),
            botId: id(seeded, "b1"),
            runId: id(seeded, "r1"),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
      },
      { declines: false },
    ),
    get(
      "computer-user-control-mine",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "running",
          controlHolder: "user",
          controlBotId: id(seeded, "b1"),
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        });
        await bot(seeded, "b1", { computer: "c1" });
      },
      { declines: false },
    ),
    get(
      "computer-user-control-by-other",
      { botId: "__s-b1__" },
      async (seeded) => {
        await other(seeded);
        await computer(seeded, "c1", {
          state: "running",
          controlHolder: "user",
          controlBotId: id(seeded, "b1"),
          controlLeaseId: "lease-1",
          controlUserId: id(seeded, "other"),
        });
        await bot(seeded, "b1", { computer: "c1" });
      },
      // The read enqueues computer.control-expire, which writes its event about a second
      // later; wait for it on both sides instead of racing the Go capture.
      { declines: false, settleMs: 5000 },
    ),
    get(
      "computer-states",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "quarantined",
          kind: "wuying",
          maintenanceId: null,
          scope: "dedicated",
        });
        await bot(seeded, "b1", { computer: "c1" });
      },
      { declines: false },
    ),
    get(
      "computer-maintenance-and-none-kind",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", { state: "running", kind: "none", maintenanceId: "m1" });
        await bot(seeded, "b1", { computer: "c1" });
        await computer(seeded, "c2", { state: "running", kind: "docker", maintenanceId: "m1" });
        await bot(seeded, "b2", { computer: "c2" });
      },
      { declines: false },
    ),
    get(
      "computer-unknown-kind-and-disk-dismissed",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "running",
          kind: "someday",
          diskUsedBytes: 91n,
          diskFreeBytes: 9n,
          diskDismissedPercent: 91,
        });
        await bot(seeded, "b1", { computer: "c1" });
      },
      { declines: false },
    ),
    get(
      "computer-disk-full-not-dismissed",
      { botId: "__s-b1__" },
      async (seeded) => {
        await computer(seeded, "c1", {
          state: "stopped",
          kind: "docker",
          diskUsedBytes: 999n,
          diskFreeBytes: 1n,
          diskDismissedPercent: 50,
        });
        await bot(seeded, "b1", { computer: "c1" });
      },
      { declines: false },
    ),
    get("computer-empty-kind", { botId: "__s-b1__" }, async (seeded) => {
      await computer(seeded, "c1", { kind: "" });
      await bot(seeded, "b1", { computer: "c1" });
    }),
    get("computer-bad-control-holder", { botId: "__s-b1__" }, async (seeded) => {
      await computer(seeded, "c1", { controlHolder: "weird" });
      await bot(seeded, "b1", { computer: "c1" });
    }),
    get(
      "shared-space-with-two-members",
      { botId: "__s-b1__" },
      async (seeded) => {
        await other(seeded);
        // Creating an organization member adds them to its default Space (space one).
        await system.member.create({
          data: {
            id: id(seeded, "om-other"),
            organizationId: seeded.orgId,
            userId: id(seeded, "other"),
            role: "member",
            createdAt: new Date(),
          },
        });
        await computer(seeded, "c1", { state: "running" });
        await bot(seeded, "b1", { computer: "c1" });
      },
      { declines: false },
    ),
  ];
  return cases;
}
