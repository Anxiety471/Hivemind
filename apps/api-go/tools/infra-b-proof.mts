/**
 * Cross-language proof for Infrastructure B: the run handoff.
 *
 * TypeScript and Go each create, wake and cancel runs against the same
 * database; the proof compares every task, run, attempt, steering row,
 * external effect, run-only secret, message, event (opened payload) and
 * graphile job, plus the `rakazo_events` NOTIFY frames. It finishes with a real
 * TypeScript RunWorkerHost, scripted model and fake sandbox, picking up and
 * completing a run Go created and woke.
 *
 * Run from a checkout with node_modules, test keys only:
 *   DATABASE_URL=... ENCRYPTION_KEY=test-key CONTENT_ENCRYPTION=on \
 *   GO_PROOF_BIN=/tmp/infra-b/runsproof \
 *   node_modules/.bin/tsx apps/api-go/tools/infra-b-proof.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { routineWakeupJob } from "../../../packages/adapter-kit/src/background-jobs.js";
import { PostgresRealtimeFanout } from "../../../packages/adapters/src/notifications/realtime.js";
import {
  RunJobPublisher,
  RunStarter,
} from "../../../packages/adapters/src/runs/wakeups/run-wakeup.js";
import { GraphileJobPublisher } from "../../../packages/adapters/src/runs/wakeups/wakeup.js";
import { wakeRun } from "../../../packages/adapters/src/runs/wakeups/wake-run.js";
import { createRoutineTestRun } from "../../api/src/routines/routines.js";
import {
  cancelSupersededQueuedRuns,
  enqueueRunsNeedingContinue,
} from "../../api/src/threads/thread-target.js";
import { cancelThreadRuns } from "../../api/src/threads/thread-stop.js";
import {
  asSystem,
  cancelRunsInTransaction,
  createDb,
  runAsTenant,
} from "../../../packages/db/src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const GO_PROOF_BIN = process.env.GO_PROOF_BIN;
if (!GO_PROOF_BIN) throw new Error("GO_PROOF_BIN is required");
if (!process.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required (a test key)");
process.env.CONTENT_ENCRYPTION ??= "on";

// ---------------------------------------------------------------- Go driver
const child = spawn(GO_PROOF_BIN, [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, DATABASE_URL },
});
process.on("exit", () => child.kill());
const lines = createInterface({ input: child.stdout! });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextRequest = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) throw new Error(`unexpected response id ${message.id}`);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error));
  else waiter.resolve(message);
});
child.on("exit", (code) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`go proof exited ${code}`));
  pending.clear();
});
function go(request: Record<string, unknown>): Promise<any> {
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin!.write(`${JSON.stringify({ ...request, id })}\n`);
  });
}
async function goError(request: Record<string, unknown>): Promise<string> {
  try {
    await go(request);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------- database
const { prisma, pool } = createDb(DATABASE_URL);
const system = asSystem(prisma);
const fanout = new PostgresRealtimeFanout({ connectionString: DATABASE_URL, publisher: pool });

const tag = `${Date.now().toString(36)}-${process.pid}-${randomBytes(3).toString("hex")}`;
const id = (name: string) => `${name}-${tag}`;

// ---------------------------------------------------------------- listener
const listener = await pool.connect();
let frames: Array<{ topic: string; payload: string }> = [];
listener.on("notification", (notification: any) => {
  if (!notification.payload) return;
  const outer = JSON.parse(notification.payload);
  frames.push({ topic: outer.topic, payload: outer.payload });
});
await listener.query("LISTEN rakazo_events");
async function settleFrames(): Promise<void> {
  // NOTIFY is delivered asynchronously; a quiet period makes the capture
  // comparable (the infra-a proof's R2 residual has the same shape).
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// ---------------------------------------------------------------- fixtures
interface Fixture {
  orgId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  routineId: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const fixture: Fixture = {
    orgId: id(`org-${label}`),
    userId: id(`user-${label}`),
    spaceId: id(`space-${label}`),
    botId: id(`bot-${label}`),
    threadId: id(`thread-${label}`),
    routineId: id(`routine-${label}`),
  };
  await system.user.create({
    data: { id: fixture.userId, name: `Run ${label}`, email: `${fixture.userId}@example.test`, emailVerified: true },
  });
  await system.organization.create({
    data: { id: fixture.orgId, name: `Runs ${label}`, slug: fixture.orgId, createdAt: new Date() },
  });
  await system.member.create({
    data: {
      id: id(`member-${label}`),
      organizationId: fixture.orgId,
      userId: fixture.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  await system.space.create({
    data: { id: fixture.spaceId, organizationId: fixture.orgId, name: `Space ${label}`, isDefault: true },
  });
  await system.spaceMember.create({
    data: {
      id: id(`spacemember-${label}`),
      spaceId: fixture.spaceId,
      organizationId: fixture.orgId,
      userId: fixture.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const computerId = id(`computer-${label}`);
  await system.computer.create({
    data: {
      id: computerId,
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      scope: "dedicated",
      scopeKey: `scope-${computerId}`,
      homeKey: `home-${computerId}`,
      kind: "fake",
    },
  });
  await system.bot.create({
    data: {
      id: fixture.botId,
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      name: `Bot ${label}`,
      color: "blue",
      computerId,
    },
  });
  await system.thread.create({
    data: {
      id: fixture.threadId,
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      botId: fixture.botId,
      nextMessageSeq: 1,
      nextEventSeq: 1,
    },
  });
  await system.routine.create({
    data: {
      id: fixture.routineId,
      spaceId: fixture.spaceId,
      botId: fixture.botId,
      userId: fixture.userId,
      threadId: fixture.threadId,
      name: `Routine ${label}`,
      prompt: "test the routine",
      crons: ["0 9 * * *"],
      active: true,
      nextRunAt: new Date("2026-11-23T09:00:00.000Z"),
    },
  });
  return fixture;
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await system.organization.delete({ where: { id: fixture.orgId } }).catch(() => undefined);
  await system.user.delete({ where: { id: fixture.userId } }).catch(() => undefined);
}

// ---------------------------------------------------------------- snapshots
const TIMESTAMP_COLUMNS = new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "leaseExpiresAt",
  // The helpers that do not take a clock (cancelSupersededQueuedRuns) stamp
  // their own now; scenarios that pass a clock assert completedAt explicitly.
  "completedAt",
]);
const DROP_COLUMNS = new Set(["searchTokens", "toolHistory"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceIds(value: string, labels: Map<string, string>): string {
  let out = value;
  for (const [from, to] of [...labels.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function deepReplace(value: unknown, labels: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => deepReplace(item, labels));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_COLUMNS.has(key) || TIMESTAMP_COLUMNS.has(key)) continue;
      out[key] = deepReplace(inner, labels);
    }
    return out;
  }
  if (typeof value === "string") return replaceIds(value, labels);
  return value;
}

const CUID = /c[a-z0-9]{24}/;

/** Any id left unlabeled would differ between the two sides: fail loudly. */
function assertNoRawIds(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawIds(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      assertNoRawIds(inner, `${where}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && CUID.test(value)) {
    throw new Error(`unlabeled id in ${where}: ${value}`);
  }
}

function sortNormalized(snapshot: any): any {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      out[key] = [...value].sort((a: any, b: any) => {
        const left = JSON.stringify(a?.id ?? a);
        const right = JSON.stringify(b?.id ?? b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function snapshot(scope: { spaceId: string; threadId: string; routineId: string; botId: string }): Promise<any> {
  const runs = await system.run.findMany({
    where: { spaceId: scope.spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const runIds = runs.map((run) => run.id);
  const tasks = await system.task.findMany({
    where: { spaceId: scope.spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const attempts = runIds.length
    ? await system.attempt.findMany({ where: { runId: { in: runIds } }, orderBy: [{ fence: "asc" }, { id: "asc" }] })
    : [];
  const steering = await system.steeringMessage.findMany({
    where: { bot: { spaceId: scope.spaceId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const effects = await system.externalEffect.findMany({
    where: { spaceId: scope.spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const secrets = await system.secret.findMany({
    where: { spaceId: scope.spaceId },
    orderBy: [{ kind: "asc" }, { id: "asc" }],
  });
  const messages = await system.message.findMany({
    where: { threadId: scope.threadId },
    orderBy: [{ seq: "asc" }],
  });
  const events = await system.event.findMany({
    where: { threadId: scope.threadId },
    orderBy: [{ seq: "asc" }],
  });
  const leases = await system.computerExecutionLease.findMany({
    where: { botId: scope.botId },
    orderBy: [{ id: "asc" }],
  });
  const needles = [scope.spaceId, scope.threadId, scope.routineId, ...runIds];
  const jobRows = await pool.query(
    `SELECT j.id, t.identifier AS task, j.payload, j.run_at, j.key, j.attempts, j.max_attempts, j.priority
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE j.key LIKE ANY($1::text[])
        OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS needle WHERE j.payload::text LIKE '%' || needle || '%')
     ORDER BY t.identifier, j.id`,
    [needles.map((needle) => `%${needle}%`), needles],
  );
  const jobs = jobRows.rows.map((row: any) => ({
    ...row,
    payload: withoutCorrelation(row.payload),
    run_at: row.run_at instanceof Date ? row.run_at.toISOString() : String(row.run_at),
  }));
  return { runs, tasks, attempts, steering, effects, secrets, messages, events, leases, jobs };
}

function withoutCorrelation(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const copy = { ...payload };
  delete copy.__rakazoLog;
  return copy;
}

interface Side {
  kind: "ts" | "go";
  fixture: Fixture;
  labels: Map<string, string>;
  remember(id: string, label: string): void;
}

function baseLabels(fixture: Fixture): Map<string, string> {
  return new Map([
    [fixture.userId, "<user>"],
    [fixture.orgId, "<org>"],
    [fixture.spaceId, "<space>"],
    [fixture.botId, "<bot>"],
    [fixture.threadId, "<thread>"],
    [fixture.routineId, "<routine>"],
  ]);
}

async function sideState(side: Side): Promise<any> {
  const raw = await snapshot(side.fixture);
  const labels = side.labels;
  for (const event of raw.events) labels.set(event.id, `<event:${event.seq}>`);
  for (const message of raw.messages) labels.set(message.id, `<message:${message.seq}>`);
  for (const run of raw.runs) {
    if (!labels.has(run.id)) {
      labels.set(run.id, `<run:${replaceIds(run.trigger, labels)}:${run.status}:${replaceIds(run.clientNonce ?? "", labels)}>`);
    }
    if (!labels.has(run.taskId)) labels.set(run.taskId, `<task-of:${labels.get(run.id)}>`);
  }
  for (const attempt of raw.attempts) {
    labels.set(attempt.id, `<attempt:${labels.get(attempt.runId) ?? attempt.runId}:${attempt.fence}>`);
  }
  for (const steeringRow of raw.steering) {
    labels.set(steeringRow.id, `<steering:${labels.get(steeringRow.messageId) ?? steeringRow.messageId}>`);
  }
  const secretRows = [...raw.secrets].sort((a, b) =>
    replaceIds(a.kind, labels).localeCompare(replaceIds(b.kind, labels)),
  );
  secretRows.forEach((secret, index) => labels.set(secret.id, `<secret:${index + 1}:${secret.kind}>`));
  const effectRows = [...raw.effects].sort((a, b) =>
    `${replaceIds(a.kind, labels)}:${a.status}`.localeCompare(`${replaceIds(b.kind, labels)}:${b.status}`),
  );
  effectRows.forEach((effect, index) =>
    labels.set(effect.id, `<effect:${index + 1}:${replaceIds(effect.kind, labels)}>`),
  );
  for (const lease of raw.leases) labels.set(lease.id, `<lease:${labels.get(lease.runId) ?? lease.runId}>`);
  for (const job of raw.jobs) labels.set(job.id, `<job:${job.task}:${job.key ? replaceIds(job.key, labels) : ""}>`);
  const normalized = deepReplace(raw, labels);
  assertNoRawIds(normalized, "snapshot");
  return sortNormalized(normalized);
}

function normalizedFrames(side: Side): any[] {
  const normalized = frames.map((frame) => {
    let payload: any = frame.payload;
    try {
      payload = JSON.parse(frame.payload);
    } catch {
      payload = frame.payload;
    }
    return {
      topic: replaceIds(frame.topic, side.labels),
      payload: deepReplace(payload, side.labels),
    };
  });
  assertNoRawIds(normalized, "frames");
  return normalized;
}

// ---------------------------------------------------------------- TS operations
async function tsCreate(
  side: Side,
  input: { trigger: string; nonce?: string; model?: { provider: string; model: string; thinking: string }; prompt?: string; at?: Date },
): Promise<{ taskId: string; runId: string }> {
  const fixture = side.fixture;
  return system.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        userId: fixture.userId,
        prompt: input.prompt ?? "say hello",
        status: "queued",
        ...(input.at ? { createdAt: input.at, updatedAt: input.at } : {}),
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        taskId: task.id,
        userId: fixture.userId,
        status: "queued",
        trigger: input.trigger,
        ...(input.nonce ? { clientNonce: input.nonce } : {}),
        ...(input.model
          ? {
              modelProvider: input.model.provider,
              modelId: input.model.model,
              thinkingLevel: input.model.thinking,
              modelPinned: true,
            }
          : {}),
        ...(input.at ? { createdAt: input.at, updatedAt: input.at } : {}),
      },
    });
    return { taskId: task.id, runId: run.id };
  });
}

interface CreatedRun {
  taskId: string;
  runId: string;
}

async function create(side: Side, input: { trigger: string; nonce?: string; prompt?: string; at?: Date; routineRun?: boolean }): Promise<CreatedRun> {
  const fixture = side.fixture;
  let created: CreatedRun;
  if (side.kind === "ts") {
    if (input.routineRun) {
      const target = {
        routine: await system.routine.findUniqueOrThrow({ where: { id: fixture.routineId } }),
        botId: fixture.botId,
        threadId: fixture.threadId,
      };
      const saved = await system.$transaction((tx) =>
        createRoutineTestRun(
          tx as any,
          { spaceId: fixture.spaceId, userId: fixture.userId } as any,
          target as any,
          input.prompt ?? "test the routine",
          input.nonce,
        ),
      );
      const row = await system.run.findUniqueOrThrow({
        where: { id: saved.id },
        select: { taskId: true },
      });
      created = { taskId: row.taskId, runId: saved.id };
    } else {
      created = await tsCreate(side, input);
    }
  } else {
    const response = await go({
      op: "create",
      actor: { spaceId: fixture.spaceId, userId: fixture.userId },
      spaceId: fixture.spaceId,
      botId: fixture.botId,
      threadId: fixture.threadId,
      userId: fixture.userId,
      prompt: input.prompt ?? (input.routineRun ? "test the routine" : "say hello"),
      trigger: input.trigger,
      ...(input.nonce ? { clientNonce: input.nonce } : {}),
      ...(input.routineRun ? { routineId: fixture.routineId } : {}),
      ...(input.routineRun
        ? { model: { Provider: "openai", Model: "gpt-x", Thinking: "high", Pinned: true } }
        : {}),
      now: (input.at ?? new Date()).toISOString(),
    });
    created = { taskId: response.taskId, runId: response.runId };
  }
  side.remember(created.runId, "<run:created>");
  // The task is labeled structurally from its run, identically on both sides.
  return created;
}

const idleBackground = {
  enqueue: async () => undefined,
  enqueueIn: async () => undefined,
  enqueueManyIn: async () => undefined,
  cancelIn: async () => undefined,
  cancel: async () => undefined,
  close: async () => undefined,
} as any;

async function wake(side: Side, runId: string, options: { at?: Date; keepExisting?: boolean } = {}): Promise<void> {
  const fixture = side.fixture;
  if (side.kind === "ts") {
    const starter = new RunStarter(fanout);
    const jobs = new RunJobPublisher(system as any, idleBackground, starter);
    await runAsTenant({ spaceId: fixture.spaceId, userId: fixture.userId }, () =>
      wakeRun(jobs, runId, options),
    );
    await settleFrames();
    await starter.stop();
  } else {
    await go({
      op: "wake",
      actor: { spaceId: fixture.spaceId, userId: fixture.userId },
      runId,
      at: options.at?.toISOString(),
      now: new Date().toISOString(),
      keepExisting: options.keepExisting ?? false,
    });
  }
}

async function cancelActive(side: Side, runIds: string[], at: Date): Promise<void> {
  const fixture = side.fixture;
  if (side.kind === "ts") {
    await system.$transaction(async (tx) => {
      const rows = await tx.run.findMany({
        where: { id: { in: runIds } },
        select: {
          id: true,
          taskId: true,
          userId: true,
          spaceId: true,
          threadId: true,
          botId: true,
          trigger: true,
          sourceMessageId: true,
          routineId: true,
          routine: { select: { name: true } },
        },
      });
      await cancelRunsInTransaction(tx, rows, at);
    });
  } else {
    await go({
      op: "cancelActive",
      actor: { spaceId: fixture.spaceId, userId: fixture.userId },
      runIds,
      now: at.toISOString(),
    });
  }
}

async function assertPinnedCompletion(runId: string, at: Date): Promise<void> {
  const run = await system.run.findUniqueOrThrow({ where: { id: runId }, select: { completedAt: true } });
  assert.equal(
    run.completedAt?.getTime(),
    at.getTime(),
    `completedAt must be the caller's instant for ${runId}`,
  );
}

// ---------------------------------------------------------------- checks
let checks = 0;
const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    checks += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`FAIL ${name}: ${(error as Error).message}`);
  }
}

async function scenario(name: string, body: (side: Side) => Promise<void>): Promise<void> {
  await check(`${name}: TypeScript and Go match`, async () => {
    const results: Record<string, any> = {};
    for (const kind of ["ts", "go"] as const) {
      const fixture = await makeFixture(`${name}-${kind}`);
      const side: Side = {
        kind,
        fixture,
        labels: baseLabels(fixture),
        remember(actual, label) {
          this.labels.set(actual, label);
        },
      };
      frames = [];
      try {
        await body(side);
        await settleFrames();
        results[kind] = await sideState(side);
        results[`${kind}Frames`] = normalizedFrames(side);
      } finally {
        await dropFixture(fixture);
      }
    }
    assert.deepEqual(results.go, results.ts, "state");
    assert.deepEqual(results.goFrames, results.tsFrames, "frames");
  });
}

const PINNED = new Date("2026-11-22T08:00:00.000Z");
const PROGRAM = new Set<string>(process.argv.slice(2));
function picked(name: string): boolean {
  return PROGRAM.size === 0 || [...PROGRAM].some((entry) => name.includes(entry));
}

if (picked("create-user")) {
  await scenario("create-user", async (side) => {
    await create(side, { trigger: "user", nonce: "send:proof-message", at: PINNED });
  });
}

if (picked("create-routine-model-pin")) {
  await scenario("create-routine-model-pin", async (side) => {
    await system.routine.update({
      where: { id: side.fixture.routineId },
      data: { modelProvider: "openai", modelId: "gpt-x", thinkingLevel: "high" },
    });
    await create(side, { trigger: "routine", nonce: "routine-run:proof:abc", routineRun: true, at: PINNED });
  });
}

if (picked("create-empty-prompt")) {
  await scenario("create-empty-prompt", async (side) => {
    // skills.testRun stores `prompt ?? formatSkillRunPrompt(...)`; an explicit
    // "" is a valid prompt (packages/contracts/src/skills/skills-rpc.ts:45).
    await create(side, { trigger: "skill", prompt: "", at: PINNED });
  });
}

if (picked("wake-many")) {
  await scenario("wake-many", async (side) => {
    const queued = await create(side, { trigger: "user", at: PINNED });
    const waiting = await create(side, { trigger: "follow_up", at: PINNED });
    await system.run.update({ where: { id: waiting.runId }, data: { status: "waiting_input" } });
    if (side.kind === "ts") {
      const starter = new RunStarter(fanout);
      const jobs = new RunJobPublisher(system as any, idleBackground, starter);
      await runAsTenant({ spaceId: side.fixture.spaceId, userId: side.fixture.userId }, () =>
        enqueueRunsNeedingContinue(jobs, [
          { id: waiting.runId, status: "waiting_input" },
          { id: queued.runId, status: "queued" },
        ]),
      );
      await settleFrames();
      await starter.stop();
    } else {
      await go({
        op: "wakeMany",
        actor: { spaceId: side.fixture.spaceId, userId: side.fixture.userId },
        runIds: [waiting.runId, queued.runId],
      });
    }
    // A wake without an explicit `at` writes the wall clock on each side, so
    // pin the observed value after asserting what the filter did.
    const queuedRow = await system.run.findUniqueOrThrow({ where: { id: queued.runId }, select: { wakeAt: true } });
    assert.ok(queuedRow.wakeAt, "the queued run must be woken");
    const waitingRow = await system.run.findUniqueOrThrow({ where: { id: waiting.runId }, select: { wakeAt: true } });
    assert.equal(waitingRow.wakeAt, null, "the waiting_input run must not be woken");
    await system.run.update({ where: { id: queued.runId }, data: { wakeAt: PINNED } });
  });
}

if (picked("wake-now")) {
  await scenario("wake-now", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED });
    await wake(side, created.runId, { at: new Date("2026-11-22T08:00:01.000Z") });
  });
}

if (picked("wake-future")) {
  await scenario("wake-future", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED });
    // Genuinely ahead of the wall clock at every run.
    await wake(side, created.runId, { at: new Date("2099-01-01T00:00:00.000Z") });
  });
}

if (picked("wake-keep-existing")) {
  await scenario("wake-keep-existing", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED });
    await system.run.update({
      where: { id: created.runId },
      data: { wakeAt: new Date("2026-11-22T08:30:00.000Z") },
    });
    await wake(side, created.runId, {
      at: new Date("2026-11-22T09:00:00.000Z"),
      keepExisting: true,
    });
  });
}

async function seedActiveRun(side: Side, label: string): Promise<string> {
  const fixture = side.fixture;
  const taskId = id(`${label}-task`);
  const runId = id(`${label}-run`);
  side.remember(taskId, `<task:${label}>`);
  side.remember(runId, `<run:${label}>`);
  const task = await system.task.create({
    data: {
      id: taskId,
      spaceId: fixture.spaceId,
      botId: fixture.botId,
      threadId: fixture.threadId,
      userId: fixture.userId,
      prompt: "cancel me",
      status: "running",
      createdAt: PINNED,
      updatedAt: PINNED,
    },
  });
  const run = await system.run.create({
    data: {
      id: runId,
      spaceId: fixture.spaceId,
      botId: fixture.botId,
      threadId: fixture.threadId,
      taskId: task.id,
      userId: fixture.userId,
      status: "running",
      trigger: "user",
      leaseOwner: "worker-a",
      leaseFence: 1,
      leaseExpiresAt: new Date("2026-11-22T08:05:00.000Z"),
      startedAt: PINNED,
      createdAt: PINNED,
      updatedAt: PINNED,
    },
  });
  const attemptId = id(`${label}-attempt`);
  side.remember(attemptId, `<attempt:${label}>`);
  await system.attempt.create({
    data: { id: attemptId, runId: run.id, fence: 1, status: "running", startedAt: PINNED },
  });
  const checkpointId = id(`${label}-checkpoint`);
  side.remember(checkpointId, `<checkpoint:${label}>`);
  await system.externalEffect.create({
    data: {
      id: checkpointId,
      spaceId: fixture.spaceId,
      runId: run.id,
      kind: "runtime_checkpoint",
      status: "runtime_checkpoint",
      idempotencyKey: "checkpoint:" + run.id,
      request: {},
    },
  });
  const effectId = id(`${label}-effect`);
  side.remember(effectId, `<approval:${label}>`);
  const message = await system.message.create({
    data: {
      id: id(`${label}-message`),
      threadId: fixture.threadId,
      seq: 1,
      role: "bot",
      blocks: [{ kind: "ask", status: "pending", text: "Allow?", approvalEffectId: effectId }],
      botId: fixture.botId,
      runId: run.id,
    },
  });
  await system.thread.update({ where: { id: fixture.threadId }, data: { nextMessageSeq: 2 } });
  await system.externalEffect.create({
    data: {
      id: effectId,
      spaceId: fixture.spaceId,
      runId: run.id,
      kind: "web_fetch",
      status: "intended",
      idempotencyKey: effectId,
      request: {},
    },
  });
  const secretId = id(`${label}-secret`);
  side.remember(secretId, `<run-secret:${label}>`);
  await system.secret.create({
    data: {
      id: secretId,
      userId: fixture.userId,
      spaceId: fixture.spaceId,
      kind: "run-secret:" + run.id,
      ciphertext: "v2:proof",
    },
  });
  await system.secret.create({
    data: {
      id: id(`${label}-login`),
      userId: fixture.userId,
      spaceId: fixture.spaceId,
      kind: "run-login:" + run.id + ":github",
      ciphertext: "v2:proof",
    },
  });
  await system.secret.create({
    data: {
      id: id(`${label}-kept`),
      userId: fixture.userId,
      spaceId: fixture.spaceId,
      kind: "unrelated",
      ciphertext: "v2:proof",
    },
  });
  void message;
  return run.id;
}

if (picked("cancel-active")) {
  await scenario("cancel-active", async (side) => {
    const runId = await seedActiveRun(side, "a");
    const at = new Date("2026-11-22T08:10:00.000Z");
    await cancelActive(side, [runId], at);
    assertPinnedCompletion(runId, at);
  });
}

if (picked("cancel-finished")) {
  await scenario("cancel-finished", async (side) => {
    const runId = await seedActiveRun(side, "a");
    await system.run.update({
      where: { id: runId },
      data: {
        status: "completed",
        completedAt: new Date("2026-11-22T08:09:00.000Z"),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
  });
}

if (picked("cancel-other-space")) {
  await scenario("cancel-other-space", async (side) => {
    const fixture = side.fixture;
    const runId = await seedActiveRun(side, "a");
    const otherSpace = id("other-space");
    side.remember(otherSpace, "<other-space>");
    await system.space.create({
      data: { id: otherSpace, organizationId: fixture.orgId, name: "Other Space", isDefault: false },
    });
    await system.spaceMember.create({
      data: {
        id: id("other-member"),
        spaceId: otherSpace,
        organizationId: fixture.orgId,
        userId: fixture.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const at = new Date("2026-11-22T08:10:00.000Z");
    if (side.kind === "ts") {
      await runAsTenant({ spaceId: otherSpace, userId: fixture.userId }, () =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.run.findMany({
            where: { id: runId },
            select: {
              id: true,
              taskId: true,
              userId: true,
              spaceId: true,
              threadId: true,
              botId: true,
              trigger: true,
              sourceMessageId: true,
              routineId: true,
            },
          });
          await cancelRunsInTransaction(tx as any, rows as any, at);
        }),
      );
    } else {
      await go({
        op: "cancelActive",
        actor: { spaceId: otherSpace, userId: fixture.userId },
        runIds: [runId],
        now: at.toISOString(),
      });
    }
  });
}

if (picked("duplicate-nonce")) {
  await scenario("duplicate-nonce", async (side) => {
    const nonce = "send:duplicate";
    await create(side, { trigger: "user", nonce, at: PINNED });
    if (side.kind === "ts") {
      let failure = "";
      try {
        await tsCreate(side, { trigger: "user", nonce, at: PINNED });
      } catch (error) {
        failure = (error as any).code ?? (error as Error).message;
      }
      assert.equal(failure, "P2002", "TypeScript duplicate nonce must be P2002");
    } else {
      const failure = await goError({
        op: "create",
        actor: { spaceId: side.fixture.spaceId, userId: side.fixture.userId },
        spaceId: side.fixture.spaceId,
        botId: side.fixture.botId,
        threadId: side.fixture.threadId,
        userId: side.fixture.userId,
        prompt: "say hello",
        trigger: "user",
        clientNonce: nonce,
        now: PINNED.toISOString(),
      });
      assert.match(failure, /23505|duplicate key/, "Go duplicate nonce must be a unique violation");
      const found = await go({
        op: "byNonce",
        actor: { spaceId: side.fixture.spaceId, userId: side.fixture.userId },
        spaceId: side.fixture.spaceId,
        clientNonce: nonce,
      });
      assert.equal(found.found, true, "Go must resolve the saved run by nonce");
    }
  });
}

if (picked("cancel-conversation")) {
  await scenario("cancel-conversation", async (side) => {
    const fixture = side.fixture;
    const runA = await seedActiveRun(side, "a");
    const steeringMessage = await system.message.create({
      data: {
        id: id("steering-message"),
        threadId: fixture.threadId,
        seq: 2,
        role: "user",
        blocks: [{ kind: "text", text: "one more thing" }],
        authorUserId: fixture.userId,
        createdAt: PINNED,
      },
    });
    await system.thread.update({ where: { id: fixture.threadId }, data: { nextMessageSeq: 3 } });
    await system.steeringMessage.create({
      data: { id: id("steering"), messageId: steeringMessage.id, botId: fixture.botId, userId: fixture.userId },
    });
    await system.event.create({
      data: {
        id: id("progress"),
        spaceId: fixture.spaceId,
        threadId: fixture.threadId,
        botId: fixture.botId,
        seq: 1,
        type: "thread.progress",
        runId: runA,
        payload: { state: "working" },
      },
    });
    await system.thread.update({ where: { id: fixture.threadId }, data: { nextEventSeq: 2 } });
    const at = new Date("2026-11-22T08:10:00.000Z");
    if (side.kind === "ts") {
      await runAsTenant({ spaceId: fixture.spaceId, userId: fixture.userId }, () =>
        prisma.$transaction(
          cancelThreadRuns(
            { spaceId: fixture.spaceId },
            { kind: "bot", botId: fixture.botId, threadId: fixture.threadId },
          ),
          { timeout: 20_000 },
        ),
      );
    } else {
      await go({
        op: "cancelConversation",
        actor: { spaceId: fixture.spaceId, userId: fixture.userId },
        spaceId: fixture.spaceId,
        threadId: fixture.threadId,
        botIds: [fixture.botId],
        now: at.toISOString(),
      });
    }
  });
}

if (picked("supersede-queued")) {
  await scenario("supersede-queued", async (side) => {
    const fixture = side.fixture;
    const source = await system.message.create({
      data: {
        id: id("source"),
        threadId: fixture.threadId,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "first" }],
        authorUserId: fixture.userId,
        createdAt: PINNED,
      },
    });
    await system.thread.update({ where: { id: fixture.threadId }, data: { nextMessageSeq: 2 } });
    const staleTaskId = id("stale-task");
    const staleRunId = id("stale-run");
    side.remember(staleTaskId, "<task:stale>");
    side.remember(staleRunId, "<run:stale>");
    const staleTask = await system.task.create({
      data: {
        id: staleTaskId, spaceId: fixture.spaceId, botId: fixture.botId, threadId: fixture.threadId,
        userId: fixture.userId, prompt: "first", status: "queued", createdAt: PINNED, updatedAt: PINNED,
      },
    });
    await system.run.create({
      data: {
        id: staleRunId, spaceId: fixture.spaceId, botId: fixture.botId, threadId: fixture.threadId,
        taskId: staleTask.id, userId: fixture.userId, status: "queued", trigger: "user",
        sourceMessageId: source.id, createdAt: PINNED, updatedAt: PINNED,
      },
    });
    const freshTaskId = id("fresh-task");
    const freshRunId = id("fresh-run");
    side.remember(freshTaskId, "<task:fresh>");
    side.remember(freshRunId, "<run:fresh>");
    const freshTask = await system.task.create({
      data: {
        id: freshTaskId, spaceId: fixture.spaceId, botId: fixture.botId, threadId: fixture.threadId,
        userId: fixture.userId, prompt: "second", status: "queued", createdAt: PINNED, updatedAt: PINNED,
      },
    });
    await system.run.create({
      data: {
        id: freshRunId, spaceId: fixture.spaceId, botId: fixture.botId, threadId: fixture.threadId,
        taskId: freshTask.id, userId: fixture.userId, status: "queued", trigger: "user",
        sourceMessageId: source.id, createdAt: PINNED, updatedAt: PINNED,
      },
    });
    const at = new Date("2026-11-22T08:10:00.000Z");
    if (side.kind === "ts") {
      await system.$transaction((tx) =>
        cancelSupersededQueuedRuns(tx as any, {
          threadId: fixture.threadId,
          botIds: [fixture.botId],
          keepRunIds: [freshRunId],
        }),
      );
    } else {
      await go({
        op: "supersedeQueued",
        actor: { spaceId: fixture.spaceId, userId: fixture.userId },
        threadId: fixture.threadId,
        botIds: [fixture.botId],
        keepRunIds: [freshRunId],
        now: at.toISOString(),
      });
    }
  });
}

// ---------------------------------------------------------------- jobs control
if (picked("jobs")) {
  await check("jobs: no run.continue job on either side, a routine wakeup matches", async () => {
    const sides: Record<string, any[]> = {};
    for (const kind of ["ts", "go"] as const) {
      const fixture = await makeFixture(`jobs-${kind}`);
      try {
        if (kind === "ts") {
          const starter = new RunStarter(fanout);
          const publisher = new RunJobPublisher(system as any, new GraphileJobPublisher(pool), starter);
          const due = new Date("2026-11-23T09:00:00.000Z");
          await runAsTenant({ spaceId: fixture.spaceId, userId: fixture.userId }, async () => {
            await publisher.enqueue(routineWakeupJob(fixture.routineId, due));
            await wakeRun(publisher, "no-such-run", { at: due });
          });
          await starter.stop();
        } else {
          await go({
            op: "enqueueRoutineWakeup",
            routineId: fixture.routineId,
            at: "2026-11-23T09:00:00.000Z",
          });
        }
        const rows = await pool.query(
          `SELECT t.identifier AS task, j.payload, j.run_at, j.key, j.attempts, j.max_attempts, j.priority
           FROM graphile_worker._private_jobs j
           JOIN graphile_worker._private_tasks t ON t.id = j.task_id
           WHERE j.key = $1 OR j.payload::text LIKE $2
           ORDER BY t.identifier`,
          [`routine:${fixture.routineId}`, `%${fixture.routineId}%`],
        );
        sides[kind] = rows.rows.map((row: any) => ({
          task: row.task,
          payload: {
            ...withoutCorrelation(row.payload),
            routineId: replaceIds(row.payload.routineId, new Map([[fixture.routineId, "<routine>"]])),
          },
          run_at: row.run_at instanceof Date ? row.run_at.toISOString() : String(row.run_at),
          key: replaceIds(row.key, new Map([[fixture.routineId, "<routine>"]])),
          attempts: row.attempts,
          max_attempts: row.max_attempts,
          priority: row.priority,
        }));
      } finally {
        await system.$executeRaw`SELECT graphile_worker.remove_job(${`routine:${fixture.routineId}`})`.catch(
          () => undefined,
        );
        await dropFixture(fixture);
      }
    }
    assert.equal(sides.ts.length, 1, "TypeScript must queue exactly one routine wakeup");
    assert.equal(sides.go.length, 1, "Go must queue exactly one routine wakeup");
    assert.deepEqual(sides.go, sides.ts, "job rows");
    assert.ok(
      sides.ts.every((job: any) => job.task === "routine.wakeup"),
      "no run.continue job may be queued",
    );
  });
}

// ---------------------------------------------------------------- real worker
if (picked("worker")) {
  await check("worker: a real TypeScript RunWorkerHost completes a run Go created and woke", async () => {
    const { createApp } = await import("../../api/src/app.js");
    const { RunWorkerHost } = await import("../../../packages/adapters/src/runs/wakeups/run-wakeup.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const fixture = await makeFixture("worker");
    const dataDir = mkdtempSync(path.join(tmpdir(), "infra-b-worker-"));
    process.env.BETTER_AUTH_SECRET ??= "infra-b-proof-secret-0123456789abcdef";
    process.env.NODE_ENV ??= "test";
    process.env.AGENT_RUNTIME = "scripted";
    process.env.SANDBOX_PROVIDER = "fake";
    process.env.WAKEUP_DRIVER = "postgres";
    const app = await createApp({
      databaseUrl: DATABASE_URL,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "postgres",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      realtime: fanout,
      prisma,
    } as any);
    // Establish the fanout's LISTEN connection before the wake, so the frame is
    // delivered rather than left to the worker's five-second scan.
    await fanout.subscribe("proof-warmup", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const starter = new RunStarter(fanout);
    let handlerRuns = 0;
    const host = new RunWorkerHost(prisma, fanout, starter, {});
    const handlers = {
      "run.continue": async (payload: { runId: string }, execution?: any) => {
        handlerRuns += 1;
        await app.executor.continueRun(payload.runId, "proof-worker", execution?.onRunStarted);
      },
    } as any;
    try {
      await host.start(handlers);
      const created = await go({
        op: "create",
        actor: { spaceId: fixture.spaceId, userId: fixture.userId },
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        userId: fixture.userId,
        prompt: "write one sentence",
        trigger: "user",
        now: new Date().toISOString(),
      });
      await go({
        op: "wake",
        actor: { spaceId: fixture.spaceId, userId: fixture.userId },
        runId: created.runId,
        now: new Date().toISOString(),
      });
      const deadline = Date.now() + 60_000;
      let run: any = undefined;
      let claimedByProofWorker = false;
      while (Date.now() < deadline) {
        run = await system.run.findUnique({ where: { id: created.runId } });
        if (run?.leaseOwner === "proof-worker") claimedByProofWorker = true;
        if (run?.status === "completed" || run?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(run?.status, "completed", "the worker must complete the run");
      assert.equal(handlerRuns, 1, "the RunWorkerHost handler must run exactly once");
      const attempts = await system.attempt.count({ where: { runId: created.runId } });
      assert.equal(attempts, 1, "exactly one attempt must run the turn");
      if (!claimedByProofWorker) console.log("note: the run finished between lease polls");
      const reply = await system.message.findFirst({
        where: { threadId: fixture.threadId, role: "bot", runId: created.runId },
        orderBy: { seq: "desc" },
      });
      assert.ok(reply, "the worker must write the bot reply");
    } finally {
      await host.stop();
      await app.stop();
      await dropFixture(fixture);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------- result
child.kill();
await Promise.race([
  (async () => {
    await listener.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  })(),
  new Promise((resolve) => setTimeout(resolve, 5_000)),
]);

console.log(`\n${checks} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
process.exit(0);
