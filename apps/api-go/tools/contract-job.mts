/**
 * `job` message-block cases: the MCP job card a tool's result can post (fe86e0fcd, refined by
 * ec7aad93d and 697df64ef) over threads.get, threads.messages and threads.head, compared between
 * the TypeScript API and Go. Placeholders are expanded by withIds: `__s-<key>__` is the row
 * `<userId>-<key>`.
 *
 * Every card is seeded as plaintext and the Prisma write hook seals it, so what Go reads is exactly
 * what production stores — one `{"kind":"job","$sealed":"rkz1:…"}` entry per block, opened with
 * the Space key ring before the block schema sees it. That round trip is the bug these cases
 * cover: Go's blockSchemas had no `job` kind, so a thread holding one answered 500 "Output
 * validation failed" where TypeScript answered 200.
 *
 * `declines` says who must answer: false when Go has to answer it itself (the cases that must
 * stay served by Go), unset for the malformed cards both sides refuse with the same 500.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const years = new Date(Date.UTC(2020, 0, 1));

export function jobCases(system: System): Case[] {
  const id = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;

  /** A bot in Space one with its thread; the thread's seq counters start past every case seq. */
  const bot = async (seeded: Seeded, key = "b1") => {
    await system.bot.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[0],
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
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        botId: id(seeded, key),
        nextMessageSeq: 500,
        nextEventSeq: 500,
      },
    });
  };

  const message = (
    seeded: Seeded,
    seq: number,
    blocks: unknown,
    extra: Record<string, unknown> = {},
    thread = "b1",
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

  /** A run the page filter reads: peer (bot_message) and background (tickets) rows are filtered. */
  const run = async (
    seeded: Seeded,
    key: string,
    trigger: string,
    status = "completed",
    thread = "b1",
  ) => {
    await system.task.create({
      data: {
        id: id(seeded, `task-${key}`),
        spaceId: seeded.spaces[0],
        botId: id(seeded, "b1"),
        threadId: id(seeded, `th-${thread}`),
        userId: seeded.userId,
        prompt: "p",
        status: "completed",
      },
    });
    await system.run.create({
      data: {
        id: id(seeded, key),
        spaceId: seeded.spaces[0],
        botId: id(seeded, "b1"),
        threadId: id(seeded, `th-${thread}`),
        taskId: id(seeded, `task-${key}`),
        userId: seeded.userId,
        status,
        trigger,
      },
    });
  };

  /** One job card, with the fields this case changes. */
  const card = (fields: Record<string, unknown> = {}) => ({
    kind: "job",
    jobId: "job-1",
    title: "Fix the flaky test",
    state: "working",
    ...fields,
  });

  const get = (
    name: string,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `job-${name}`,
    procedure: "threads.get",
    input: { botId: "__s-b1__" },
    seed,
    ...extra,
  });

  const messages = (
    name: string,
    seed: (seeded: Seeded) => Promise<void>,
    input: unknown = { botId: "__s-b1__" },
    extra: Partial<Case> = {},
  ): Case => ({
    name: `job-${name}`,
    procedure: "threads.messages",
    input,
    seed,
    ...extra,
  });

  const head = (name: string, seed: (seeded: Seeded) => Promise<void>): Case => ({
    name: `job-${name}`,
    procedure: "threads.head",
    input: { botId: "__s-b1__" },
    seed,
    declines: false,
  });

  return [
    // The card itself: the shape production broke on.
    get(
      "get-minimal",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [card()]);
      },
      { declines: false },
    ),
    get(
      "get-full",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [
          card({
            jobId: "job-full",
            title: "Ship the release",
            agent: "Orca",
            branch: "feat/job-card",
            state: "finished",
            startedAt: Date.UTC(2026, 10, 26, 3, 0, 0),
            url: "https://example.test/jobs/job-full",
            reply: "All checks passed.\n\nMerged as 163daa2.",
          }),
        ]);
      },
      { declines: false },
    ),
    // Every state, so the enum is compared as a whole rather than one member at a time.
    get(
      "get-every-state",
      async (seeded) => {
        await bot(seeded);
        const states = ["starting", "working", "finished", "needs_input", "exited", "timed_out"];
        for (const [seq, state] of states.entries())
          await message(seeded, seq, [card({ jobId: `job-${state}`, title: state, state })]);
      },
      { declines: false },
    ),
    // Strings are trimmed on the way out: the wire value is what the schema parsed, not what the
    // tool posted.
    get(
      "get-trimmed",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [
          card({
            jobId: "  job-trim  ",
            title: "  Fix the build  ",
            agent: "  Orca  ",
            branch: "  feat/x  ",
            url: "  https://example.test/j  ",
            reply: "  done  ",
          }),
        ]);
      },
      { declines: false },
    ),
    // A job posts a card when it starts and again when its state is learned. The server keeps
    // both rows; only the client drops the stale one (withoutSupersededJobCards), so both sides
    // must return both here, in seq order.
    get(
      "get-superseded-cards",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [card({ jobId: "job-a", state: "working" })]);
        await message(seeded, 1, [card({ jobId: "job-a", state: "finished" })]);
        await message(seeded, 2, [card({ jobId: "job-b", state: "working" })]);
      },
      { declines: false },
    ),
    // A card beside other blocks: the parsed list keeps order and strips nothing it should keep.
    get(
      "get-beside-text-and-steps",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [
          { kind: "text", text: "Starting the job now." },
          card({ state: "starting" }),
          { kind: "steps", steps: [{ label: "Call the tool", count: 1 }] },
        ]);
        await message(seeded, 1, [card({ jobId: "job-c", state: "needs_input" })], {
          role: "user",
          authorUserId: seeded.userId,
        });
      },
      { declines: false },
    ),
    // A card never names a server or tool: unknown keys are stripped, not kept and not refused.
    get(
      "get-extra-keys-stripped",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [
          { ...card(), server: "github", tool: "start_job", structuredContent: { card: true } },
        ]);
      },
      { declines: false },
    ),
    // A job card does not count as a run's first reply (RESPONSE_BLOCK_KINDS), and a filtered peer
    // run's card-only message stays off the page while a text+card reply stays on it.
    get(
      "get-peer-run-card-filtered",
      async (seeded) => {
        await bot(seeded);
        await run(seeded, "peer", "bot_message");
        await message(seeded, 0, [card({ jobId: "job-peer" })], { runId: id(seeded, "peer") });
        await message(seeded, 1, [card({ jobId: "job-peer", state: "finished" })], {
          runId: id(seeded, "peer"),
        });
        await message(seeded, 2, [{ kind: "text", text: "done" }, card({ jobId: "job-peer" })], {
          runId: id(seeded, "peer"),
        });
      },
      { declines: false },
    ),
    // Replying to a card quotes its title (message-quote.ts's `job` case), which is the reply
    // preview Go builds without the Markdown renderer.
    get(
      "get-reply-preview-title",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [card({ title: "Fix the flaky test" })]);
        await message(seeded, 1, [{ kind: "text", text: "thanks" }], {
          role: "user",
          authorUserId: seeded.userId,
          replyToMessageId: id(seeded, "mb1-0"),
        });
      },
      { declines: false },
    ),
    // The malformed cards both sides refuse; a mismatch here would mean Go accepted a card
    // TypeScript refuses (a 200 where the API answers 500).
    get("get-unknown-state", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ state: "running" })]);
    }),
    get("get-missing-title", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [{ kind: "job", jobId: "j", state: "working" }]);
    }),
    get("get-blank-job-id", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ jobId: "   " })]);
    }),
    get("get-title-too-long", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ title: "x".repeat(201) })]);
    }),
    get("get-reply-too-long", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ state: "finished", reply: "r".repeat(4001) })]);
    }),
    get("get-url-too-long", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ url: `https://example.test/${"u".repeat(2049)}` })]);
    }),
    get("get-agent-null", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ agent: null })]);
    }),
    get("get-started-at-negative", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ startedAt: -1 })]);
    }),

    // The same cards through the message page.
    messages(
      "messages-card",
      async (seeded) => {
        await bot(seeded);
        await message(seeded, 0, [card()]);
      },
      { botId: "__s-b1__" },
      { declines: false },
    ),
    messages("messages-unknown-state", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card({ state: "running" })]);
    }),
    // The head read does not parse blocks; it must still answer for a thread that holds one.
    head("head-card", async (seeded) => {
      await bot(seeded);
      await message(seeded, 0, [card()]);
    }),
  ];
}
