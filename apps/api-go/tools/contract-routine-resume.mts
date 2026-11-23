/**
 * bots.restore routine-resume cases: unarchiving a bot, or finishing a restore
 * that is already live, turns the caller's marked routines back on. A routine
 * runs with its owner's accounts, so another member's marked routine stays off;
 * a one-shot schedule stays off (archiving dropped its time) but loses its mark;
 * a change-trigger routine is checked a moment after the restore.
 *
 * Ids in inputs: `__s-rrbot__`, `__s-rrlive__`, `__s-rrbroken__`,
 * `__s-rrgrouparch__` and `__s-rrgrouplive__` are the case's bots, and
 * `__s-rrgroup__` its group. The routines are read back through routines.list,
 * whose nextRunAt near now the harness normalizes. resumeOnRestore itself is
 * not part of the routine DTO: the database state comparison added in
 * contract.mts reads the rows directly.
 */
import type { Case, Seeded } from "./contract.mts";

type CreateArgs = { data: Record<string, unknown> };
type Delegate = { create(args: CreateArgs): Promise<unknown> };
type System = { user: Delegate; bot: Delegate; routine: Delegate };

export function routineResumeCases(system: System): Case[] {
  const old = new Date(Date.UTC(2020, 0, 1));
  const addOtherUser = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: `${seeded.userId}-other`,
        name: "Other",
        email: `${seeded.userId}-other@example.test`,
        emailVerified: true,
      },
    });
  const addBot = (seeded: Seeded, id: string, archived: boolean) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: old,
        updatedAt: old,
        archivedAt: archived ? old : null,
      },
    });
  const addRoutine = (
    seeded: Seeded,
    id: string,
    bot: string,
    extra: Record<string, unknown> = {},
  ) =>
    system.routine.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        botId: `${seeded.userId}-${bot}`,
        userId: seeded.userId,
        name: id,
        prompt: "Water the plants",
        crons: ["*/5 * * * *"],
        timezone: "UTC",
        active: false,
        resumeOnRestore: true,
        createdAt: old,
        updatedAt: old,
        ...extra,
      },
    });
  const seedRestore = async (seeded: Seeded) => {
    await addOtherUser(seeded);
    await addBot(seeded, "rrbot", true);
    // Resumes at its next occurrence from now.
    await addRoutine(seeded, "rrcron", "rrbot");
    // The earliest of several schedules still lands within minutes of now.
    await addRoutine(seeded, "rrmulti", "rrbot", { crons: ["0 9 * * *", "*/5 * * * *"] });
    // A change trigger gets its first reading a moment from now.
    await addRoutine(seeded, "rrwatch", "rrbot", {
      crons: [],
      watch: { kind: "http", url: "https://example.test/changes" },
    });
    // Stays off: archiving dropped the time it was set for.
    await addRoutine(seeded, "rronce", "rrbot", { crons: ["@once"] });
    // Another member's routine stays off until they turn it on.
    await addRoutine(seeded, "rrtheirs", "rrbot", { userId: `${seeded.userId}-other` });
  };
  const seedLive = async (seeded: Seeded) => {
    await addBot(seeded, "rrlive", false);
    // The restore brought the bot back but stopped before its routines.
    await addRoutine(seeded, "rrfinish", "rrlive");
    // An explicit off cleared the mark, so the resume leaves it off.
    await addRoutine(seeded, "rrpaused", "rrlive", { resumeOnRestore: false });
  };
  const seedBroken = async (seeded: Seeded) => {
    await addBot(seeded, "rrbroken", true);
    // Malformed schedules are skipped: the routine is on, without a run time.
    await addRoutine(seeded, "rrbadcron", "rrbroken", { crons: ["not a cron"] });
  };
  const seedGroup = async (seeded: Seeded) => {
    await addOtherUser(seeded);
    await addBot(seeded, "rrgrouparch", true);
    await addBot(seeded, "rrgrouplive", false);
    // The archived member's routine resumes with the group; the live member's
    // finishes a restore that stopped before its routines.
    await addRoutine(seeded, "rrgrouparchcron", "rrgrouparch");
    await addRoutine(seeded, "rrgrouplivecron", "rrgrouplive");
    // Another member's marked routine stays off.
    await addRoutine(seeded, "rrgrouptheirs", "rrgrouplive", {
      userId: `${seeded.userId}-other`,
    });
    await system.chatGroup.create({
      data: {
        id: `${seeded.userId}-rrgroup`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: "Routines group",
        archivedAt: old,
        createdAt: old,
        updatedAt: old,
      },
    });
    await system.chatGroupMember.create({
      data: {
        id: `${seeded.userId}-rrgm1`,
        groupId: `${seeded.userId}-rrgroup`,
        botId: `${seeded.userId}-rrgrouparch`,
        createdAt: old,
      },
    });
    await system.chatGroupMember.create({
      data: {
        id: `${seeded.userId}-rrgm2`,
        groupId: `${seeded.userId}-rrgroup`,
        botId: `${seeded.userId}-rrgrouplive`,
        createdAt: old,
      },
    });
  };
  const restoreCase = (
    name: string,
    bot: string,
    seed: (seeded: Seeded) => Promise<void>,
  ): Case => ({
    name: `bot-restore-routines-${name}`,
    procedure: "bots.restore",
    input: { botId: `__s-${bot}__` },
    seed,
    after: [{ procedure: "routines.list", input: { botId: `__s-${bot}__` } }],
    // routines.list has no orderBy: compare it by id, as the other unordered reads are.
    unordered: true,
    // The resumed watch routine's first run executes in this process seconds later.
    gapMs: 5000,
  });
  return [
    restoreCase("archived", "rrbot", seedRestore),
    restoreCase("already-live", "rrlive", seedLive),
    restoreCase("malformed", "rrbroken", seedBroken),
    {
      name: "groups-restore-routines",
      procedure: "groups.restore",
      input: { groupId: "__s-rrgroup__" },
      seed: seedGroup,
      after: [
        { procedure: "routines.list", input: { botId: "__s-rrgrouparch__" } },
        { procedure: "routines.list", input: { botId: "__s-rrgrouplive__" } },
      ],
      // routines.list has no orderBy: compare it by id, as the other unordered reads are.
      unordered: true,
      // The resumed routines' first runs execute in this process seconds later.
      gapMs: 5000,
      // The restore publishes its roster and Space changes after the response on both sides;
      // give those publishes time to land in each side's own window before the next capture.
      settleMs: 5000,
    },
  ];
}
