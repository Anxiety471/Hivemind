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
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { routineWakeupJob } from "../../../packages/adapter-kit/src/background-jobs.js";
import { PostgresRealtimeFanout } from "../../../packages/adapters/src/notifications/realtime.js";
import {
  RunJobPublisher,
  RunStarter,
} from "../../../packages/adapters/src/runs/wakeups/run-wakeup.js";
import { wakeRun } from "../../../packages/adapters/src/runs/wakeups/wake-run.js";
import { GraphileJobPublisher } from "../../../packages/adapters/src/runs/wakeups/wakeup.js";
import {
  asSystem,
  cancelRunsInTransaction,
  createDb,
  runAsTenant,
} from "../../../packages/db/src/index.js";
import { createRoutineTestRun } from "../../api/src/routines/routines.js";
import {
  cancelThreadRuns,
  STOPPED_BY_MESSAGE_NOTE,
  stoppedRoutineNote,
} from "../../api/src/threads/thread-stop.js";
import {
  cancelSupersededQueuedRuns,
  enqueueRunsNeedingContinue,
} from "../../api/src/threads/thread-target.js";

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
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
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
  // NOTIFY is delivered asynchronously: wait until the capture has been quiet
  // for a moment, so a frame that arrives a little late is neither missed by a
  // scenario's own counts nor missing from the state comparison.
  let seen = frames.length;
  let quietSince = Date.now();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (frames.length !== seen) {
      seen = frames.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= 250) return;
  }
}

// ---------------------------------------------------------------- fixtures
interface Fixture {
  orgId: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  routineId: string;
  computerId: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const fixture: Fixture = {
    orgId: id(`org-${label}`),
    userId: id(`user-${label}`),
    spaceId: id(`space-${label}`),
    botId: id(`bot-${label}`),
    threadId: id(`thread-${label}`),
    routineId: id(`routine-${label}`),
    computerId: id(`computer-${label}`),
  };
  await system.user.create({
    data: {
      id: fixture.userId,
      name: `Run ${label}`,
      email: `${fixture.userId}@example.test`,
      emailVerified: true,
    },
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
    data: {
      id: fixture.spaceId,
      organizationId: fixture.orgId,
      name: `Space ${label}`,
      isDefault: true,
    },
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
  const computerId = fixture.computerId;
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
    value.forEach((item, index) => {
      assertNoRawIds(item, `${where}[${index}]`);
    });
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

async function snapshot(scope: {
  spaceId: string;
  threadId: string;
  routineId: string;
  botId: string;
}): Promise<any> {
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
    ? await system.attempt.findMany({
        where: { runId: { in: runIds } },
        orderBy: [{ fence: "asc" }, { id: "asc" }],
      })
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
    [fixture.computerId, "<computer>"],
  ]);
}

async function sideState(side: Side): Promise<any> {
  const raw = await snapshot(side.fixture);
  const labels = side.labels;
  for (const event of raw.events) labels.set(event.id, `<event:${event.seq}>`);
  for (const message of raw.messages) labels.set(message.id, `<message:${message.seq}>`);
  for (const run of raw.runs) {
    if (!labels.has(run.id)) {
      labels.set(
        run.id,
        `<run:${replaceIds(run.trigger, labels)}:${run.status}:${replaceIds(run.clientNonce ?? "", labels)}>`,
      );
    }
    if (!labels.has(run.taskId)) labels.set(run.taskId, `<task-of:${labels.get(run.id)}>`);
  }
  for (const attempt of raw.attempts) {
    labels.set(
      attempt.id,
      `<attempt:${labels.get(attempt.runId) ?? attempt.runId}:${attempt.fence}>`,
    );
  }
  for (const steeringRow of raw.steering) {
    labels.set(
      steeringRow.id,
      `<steering:${labels.get(steeringRow.messageId) ?? steeringRow.messageId}>`,
    );
  }
  const secretRows = [...raw.secrets].sort((a, b) =>
    replaceIds(a.kind, labels).localeCompare(replaceIds(b.kind, labels)),
  );
  secretRows.forEach((secret, index) => {
    labels.set(secret.id, `<secret:${index + 1}:${secret.kind}>`);
  });
  const effectRows = [...raw.effects].sort((a, b) =>
    `${replaceIds(a.kind, labels)}:${a.status}`.localeCompare(
      `${replaceIds(b.kind, labels)}:${b.status}`,
    ),
  );
  effectRows.forEach((effect, index) => {
    labels.set(effect.id, `<effect:${index + 1}:${replaceIds(effect.kind, labels)}>`);
  });
  for (const lease of raw.leases)
    labels.set(lease.id, `<lease:${labels.get(lease.runId) ?? lease.runId}>`);
  for (const job of raw.jobs)
    labels.set(job.id, `<job:${job.task}:${job.key ? replaceIds(job.key, labels) : ""}>`);
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
interface CreateShape {
  trigger: string;
  nonce?: string;
  model?: { provider: string; model: string; thinking: string | null };
  /** `{modelPinned: true}` with no model columns: sendUserMessage's pin object. */
  modelPinPresent?: boolean;
  prompt?: string;
  at?: Date;
  wakeAt?: Date;
  groupReplyOptional?: boolean;
  sourceMessageId?: string;
  delegatedFromRunId?: string;
  retryOfRunId?: string;
  routineId?: string;
  /** The run's thread, when it is not the fixture's chat (a helper's own thread). */
  threadId?: string;
}

async function tsCreate(
  side: Side,
  input: CreateShape,
): Promise<{ taskId: string; runId: string }> {
  const fixture = side.fixture;
  const threadId = input.threadId ?? fixture.threadId;
  return system.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId,
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
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.nonce ? { clientNonce: input.nonce } : {}),
        ...(input.model
          ? {
              modelProvider: input.model.provider,
              modelId: input.model.model,
              thinkingLevel: input.model.thinking,
              modelPinned: true,
            }
          : {}),
        ...(input.modelPinPresent ? { modelPinned: true } : {}),
        ...(input.wakeAt ? { wakeAt: input.wakeAt } : {}),
        ...(input.groupReplyOptional ? { groupReplyOptional: true } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.delegatedFromRunId ? { delegatedFromRunId: input.delegatedFromRunId } : {}),
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.routineId ? { routineId: input.routineId } : {}),
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

async function create(
  side: Side,
  input: CreateShape & { routineRun?: boolean; label?: string },
): Promise<CreatedRun> {
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
    // routineRunModelPin: {} unless the routine names both a provider and a
    // model, and the caller spreads it (so no pin at all for {}).
    const routine = input.routineRun
      ? await system.routine.findUniqueOrThrow({
          where: { id: fixture.routineId },
          select: { modelProvider: true, modelId: true, thinkingLevel: true },
        })
      : undefined;
    const routinePin =
      routine?.modelProvider && routine.modelId
        ? {
            provider: routine.modelProvider,
            model: routine.modelId,
            thinking: routine.thinkingLevel,
          }
        : undefined;
    const response = await go({
      op: "create",
      actor: { spaceId: fixture.spaceId, userId: fixture.userId },
      spaceId: fixture.spaceId,
      botId: fixture.botId,
      threadId: input.threadId ?? fixture.threadId,
      userId: fixture.userId,
      prompt: input.prompt ?? (input.routineRun ? "test the routine" : "say hello"),
      trigger: input.trigger,
      ...(input.nonce ? { clientNonce: input.nonce } : {}),
      ...(input.routineRun ? { routineId: fixture.routineId } : {}),
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.model
        ? {
            model: {
              Provider: input.model.provider,
              Model: input.model.model,
              Thinking: input.model.thinking,
              Pinned: true,
            },
          }
        : routinePin
          ? {
              model: {
                Provider: routinePin.provider,
                Model: routinePin.model,
                Thinking: routinePin.thinking,
                Pinned: true,
              },
            }
          : {}),
      ...(input.modelPinPresent ? { model: { Pinned: true } } : {}),
      ...(input.wakeAt ? { wakeAt: input.wakeAt.toISOString() } : {}),
      ...(input.groupReplyOptional ? { groupReplyOptional: true } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.delegatedFromRunId ? { delegatedFromRunId: input.delegatedFromRunId } : {}),
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      now: (input.at ?? new Date()).toISOString(),
    });
    created = { taskId: response.taskId, runId: response.runId };
  }
  side.remember(created.runId, input.label ?? "<run:created>");
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

async function wake(
  side: Side,
  runId: string,
  options: { at?: Date; keepExisting?: boolean; now?: Date } = {},
): Promise<void> {
  const fixture = side.fixture;
  if (side.kind === "ts") {
    const starter = new RunStarter(fanout);
    const jobs = new RunJobPublisher(system as any, idleBackground, starter);
    await runAsTenant({ spaceId: fixture.spaceId, userId: fixture.userId }, () =>
      wakeRun(jobs, runId, { at: options.at, keepExisting: options.keepExisting }),
    );
    await settleFrames();
    await starter.stop();
  } else {
    await go({
      op: "wake",
      actor: { spaceId: fixture.spaceId, userId: fixture.userId },
      runId,
      at: options.at?.toISOString(),
      // Only the timestamp the caller injects: the due decision must not use it.
      now: (options.now ?? new Date()).toISOString(),
      keepExisting: options.keepExisting ?? false,
    });
  }
}

/** The frames this side published during its scenario, after the settle wait. */
function frameCount(): number {
  return frames.length;
}

/** Waits (bounded) for the expected frames: a NOTIFY can land just after a settle. */
async function expectFrames(count: number, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (frameCount() < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (frames.length !== count && count === 0) {
    // A negative expectation gets the settle's quiet window only.
    assert.equal(frames.length, 0, label);
    return;
  }
  assert.equal(frames.length, count, label);
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
  const run = await system.run.findUniqueOrThrow({
    where: { id: runId },
    select: { completedAt: true },
  });
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

interface ScenarioObservation {
  /** Label-free facts to compare between the sides (ids already replaced). */
  extra?: unknown;
}

async function scenario(
  name: string,
  body: (side: Side) => Promise<ScenarioObservation | void>,
  options: { unorderedFrames?: boolean } = {},
): Promise<void> {
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
        const observation = await body(side);
        await settleFrames();
        results[kind] = await sideState(side);
        const sideFrames = normalizedFrames(side);
        results[`${kind}Frames`] = options.unorderedFrames
          ? [...sideFrames].sort((left, right) =>
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
            )
          : sideFrames;
        results[`${kind}Extra`] = observation?.extra ?? null;
      } finally {
        await dropFixture(fixture);
      }
    }
    assert.deepEqual(results.go, results.ts, "state");
    assert.deepEqual(results.goFrames, results.tsFrames, "frames");
    assert.deepEqual(results.goExtra, results.tsExtra, "extra");
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
    await create(side, {
      trigger: "routine",
      nonce: "routine-run:proof:abc",
      routineRun: true,
      at: PINNED,
    });
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
  await scenario(
    "wake-many",
    async (side) => {
      const queued = await create(side, { trigger: "user", at: PINNED, label: "<run:queued>" });
      const takeover = await create(side, {
        trigger: "follow_up",
        at: new Date(PINNED.getTime() + 1),
        label: "<run:takeover>",
      });
      await system.run.update({
        where: { id: takeover.runId },
        data: { status: "waiting_takeover" },
      });
      const waiting = await create(side, {
        trigger: "follow_up",
        at: new Date(PINNED.getTime() + 2),
        label: "<run:waiting>",
      });
      await system.run.update({ where: { id: waiting.runId }, data: { status: "waiting_input" } });
      const finished = await create(side, {
        trigger: "user",
        at: new Date(PINNED.getTime() + 3),
        label: "<run:finished>",
      });
      await system.run.update({
        where: { id: finished.runId },
        data: { status: "completed", completedAt: new Date("2026-11-22T08:09:00.000Z") },
      });
      const candidates = [
        { id: waiting.runId, status: "waiting_input" },
        { id: queued.runId, status: "queued" },
        { id: takeover.runId, status: "waiting_takeover" },
        { id: finished.runId, status: "completed" },
      ];
      if (side.kind === "ts") {
        const starter = new RunStarter(fanout);
        const jobs = new RunJobPublisher(system as any, idleBackground, starter);
        await runAsTenant({ spaceId: side.fixture.spaceId, userId: side.fixture.userId }, () =>
          enqueueRunsNeedingContinue(jobs, candidates),
        );
        await settleFrames();
        await starter.stop();
      } else {
        await go({
          op: "wakeMany",
          actor: { spaceId: side.fixture.spaceId, userId: side.fixture.userId },
          threadId: side.fixture.threadId,
          runIds: candidates.map((candidate) => candidate.id),
        });
      }
      // A wake without an explicit `at` writes the wall clock on each side, so
      // pin the observed values after asserting what the filter did.
      for (const candidate of [
        { name: "queued", id: queued.runId, woke: true },
        { name: "waiting_takeover", id: takeover.runId, woke: true },
        { name: "waiting_input", id: waiting.runId, woke: false },
        { name: "completed", id: finished.runId, woke: false },
      ]) {
        const row = await system.run.findUniqueOrThrow({
          where: { id: candidate.id },
          select: { wakeAt: true },
        });
        assert.equal(Boolean(row.wakeAt), candidate.woke, `${candidate.name} wakeAt`);
        if (row.wakeAt) {
          await system.run.update({ where: { id: candidate.id }, data: { wakeAt: PINNED } });
        }
      }
      await expectFrames(2, "exactly the two continuation runs are announced");
    },
    { unorderedFrames: true },
  );
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

/** A user message in the fixture thread, so a run can name a source message. */
async function seedMessage(side: Side, seq: number, text: string): Promise<string> {
  const fixture = side.fixture;
  const messageId = id(`message-${seq}-${side.kind}`);
  await system.message.create({
    data: {
      id: messageId,
      threadId: fixture.threadId,
      seq,
      role: "user",
      blocks: [{ kind: "text", text }],
      authorUserId: fixture.userId,
      createdAt: PINNED,
    },
  });
  await system.thread.update({
    where: { id: fixture.threadId },
    data: { nextMessageSeq: seq + 1 },
  });
  return messageId;
}

/** A created run put into `running` with a live lease, as a worker claims it. */
async function claimRun(side: Side, runId: string): Promise<void> {
  await system.run.update({
    where: { id: runId },
    data: { status: "running", leaseOwner: "worker-a", leaseFence: 1, startedAt: PINNED },
  });
}

/** One run's cancel timestamps: `updatedAt` is statement time, never the caller's clock. */
async function assertStatementTime(
  runId: string,
  label: string,
  completedAt?: Date | null,
): Promise<void> {
  const row = await system.run.findUniqueOrThrow({
    where: { id: runId },
    select: { updatedAt: true, completedAt: true },
  });
  const drift = Math.abs(Date.now() - row.updatedAt.getTime());
  assert.ok(drift < 120_000, `${label} updatedAt must be statement time, drifted ${drift}ms`);
  if (completedAt === null) {
    const completedDrift = Math.abs(Date.now() - (row.completedAt?.getTime() ?? 0));
    assert.ok(
      row.completedAt && completedDrift < 120_000,
      `${label} completedAt must be its own now, drifted ${completedDrift}ms`,
    );
  } else if (completedAt) {
    assert.equal(
      row.completedAt?.getTime(),
      completedAt.getTime(),
      `${label} completedAt must be pinned`,
    );
  }
}

interface CancelConversationOptions {
  note?: { botId: string };
  helperMessageId?: string;
  writeNotes?: boolean;
}

/** cancelThreadRuns' comparable result: no ids, only counts and the notify cursor. */
async function cancelConversation(side: Side, options: CancelConversationOptions = {}) {
  const fixture = side.fixture;
  const target = { kind: "bot" as const, botId: fixture.botId, threadId: fixture.threadId };
  if (side.kind === "ts") {
    const result = await runAsTenant({ spaceId: fixture.spaceId, userId: fixture.userId }, () =>
      prisma.$transaction(
        cancelThreadRuns(
          { spaceId: fixture.spaceId },
          target,
          options.note,
          options.helperMessageId,
        ),
        { timeout: 20_000 },
      ),
    );
    return {
      eventSeq: result.eventSeq,
      cancelled: result.runIds.length,
      stoppedHelpers: result.stoppedHelpers.length,
      leases: result.leases.length,
      computers: result.computers.length,
    };
  }
  const response = await go({
    op: "cancelConversation",
    actor: { spaceId: fixture.spaceId, userId: fixture.userId },
    spaceId: fixture.spaceId,
    threadId: fixture.threadId,
    botIds: [fixture.botId],
    ...(options.note ? { noteBotId: options.note.botId } : {}),
    ...(options.helperMessageId ? { helperMessageId: options.helperMessageId } : {}),
    writeNotes: options.writeNotes ?? false,
  });
  return {
    eventSeq: response.eventSeq ?? null,
    cancelled: response.cancelled?.length ?? 0,
    stoppedHelpers: response.stoppedHelpers ?? 0,
    leases: response.leases?.length ?? 0,
    computers: response.computers?.length ?? 0,
  };
}

// cancelWithCredentialOrigin seeds an active run with one open ask, appends a
// bearer credential card carrying the given origin, cancels, and asserts how
// the open effect ends. TS and Go must agree on validity before the cancel.
async function cancelWithCredentialOrigin(
  side: Side,
  label: string,
  origin: string,
  effectStatus: "denied" | "intended",
): Promise<void> {
  const runId = await seedActiveRun(side, label);
  const message = await system.message.findFirstOrThrow({
    where: { runId },
    orderBy: { seq: "desc" },
  });
  await system.message.update({
    where: { id: message.id },
    data: {
      blocks: [
        ...(message.blocks as any[]),
        {
          kind: "ask",
          text: `Use ${origin}`,
          credential: { name: "site_key", origin, auth: { type: "bearer" } },
        },
      ],
    },
  });
  await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
  const effect = await system.externalEffect.findFirstOrThrow({
    where: { runId, kind: "web_fetch" },
  });
  assert.equal(effect.status, effectStatus, `${side.kind}: origin ${JSON.stringify(origin)}`);
}

if (picked("cancel-active")) {
  await scenario("cancel-active", async (side) => {
    const runId = await seedActiveRun(side, "a");
    const at = new Date("2026-11-22T08:10:00.000Z");
    await cancelActive(side, [runId], at);
    // completedAt is the caller's instant; updatedAt is Prisma's @updatedAt (the
    // statement's own now), never the pinned clock.
    assertPinnedCompletion(runId, at);
    await assertStatementTime(runId, "active cancel", at);
  });
}

if (picked("cancel-malformed-ask")) {
  await scenario("cancel-malformed-ask", async (side) => {
    const runId = await seedActiveRun(side, "malformed-ask");
    const message = await system.message.findFirstOrThrow({
      where: { runId },
      orderBy: { seq: "desc" },
    });
    // One invalid card after a valid open ask: MessageBlockSchema.array() fails
    // the whole list, so neither side may deny the ask's effect.
    await system.message.update({
      where: { id: message.id },
      data: {
        blocks: [...(message.blocks as any[]), { kind: "card", lines: [{ k: "missing-v" }] }],
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
    const effect = await system.externalEffect.findFirstOrThrow({
      where: { runId, kind: "web_fetch" },
    });
    assert.equal(
      effect.status,
      "intended",
      `${side.kind}: a malformed block makes the whole ask list unparseable`,
    );
  });
}

if (picked("cancel-nested-credential")) {
  await scenario("cancel-nested-credential", async (side) => {
    const runId = await seedActiveRun(side, "nested-credential");
    const message = await system.message.findFirstOrThrow({
      where: { runId },
      orderBy: { seq: "desc" },
    });
    await system.message.update({
      where: { id: message.id },
      data: {
        blocks: [
          ...(message.blocks as any[]),
          {
            kind: "ask",
            text: "Sign in",
            credential: {
              name: "site_login",
              origin: "https://www.example.test",
              auth: { type: "login" },
            },
          },
        ],
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
    const effect = await system.externalEffect.findFirstOrThrow({
      where: { runId, kind: "web_fetch" },
    });
    assert.equal(
      effect.status,
      "denied",
      `${side.kind}: a valid credential ask must not abort the cancel`,
    );
  });
}

if (picked("cancel-nested-onetimecode")) {
  await scenario("cancel-nested-onetimecode", async (side) => {
    const runId = await seedActiveRun(side, "nested-onetimecode");
    const message = await system.message.findFirstOrThrow({
      where: { runId },
      orderBy: { seq: "desc" },
    });
    await system.message.update({
      where: { id: message.id },
      data: {
        blocks: [
          ...(message.blocks as any[]),
          {
            kind: "ask",
            text: "Enter the code",
            oneTimeCode: { origin: "https://www.example.test" },
          },
        ],
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
    const effect = await system.externalEffect.findFirstOrThrow({
      where: { runId, kind: "web_fetch" },
    });
    assert.equal(
      effect.status,
      "denied",
      `${side.kind}: a valid oneTimeCode ask must not abort the cancel`,
    );
  });
}

if (picked("cancel-run-import-setup")) {
  await scenario("cancel-run-import-setup", async (side) => {
    const runId = await seedActiveRun(side, "run-import-setup");
    const message = await system.message.findFirstOrThrow({
      where: { runId },
      orderBy: { seq: "desc" },
    });
    await system.message.update({
      where: { id: message.id },
      data: {
        blocks: [
          ...(message.blocks as any[]),
          {
            kind: "import_setup",
            items: [{ kind: "model", title: "M", provider: "p", providerName: "P" }],
          },
        ],
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
    const effect = await system.externalEffect.findFirstOrThrow({
      where: { runId, kind: "web_fetch" },
    });
    assert.equal(
      effect.status,
      "denied",
      `${side.kind}: a run-linked import_setup must not abort the cancel`,
    );
  });
}

if (picked("cancel-malformed-nested-credential")) {
  await scenario("cancel-malformed-nested-credential", async (side) => {
    const runId = await seedActiveRun(side, "malformed-nested-credential");
    const message = await system.message.findFirstOrThrow({
      where: { runId },
      orderBy: { seq: "desc" },
    });
    await system.message.update({
      where: { id: message.id },
      data: {
        blocks: [
          ...(message.blocks as any[]),
          {
            kind: "ask",
            text: "Sign in",
            credential: {
              name: "k",
              origin: "https://www.example.test",
              auth: { type: "header", name: "Host" },
            },
          },
        ],
      },
    });
    await cancelActive(side, [runId], new Date("2026-11-22T08:10:00.000Z"));
    const effect = await system.externalEffect.findFirstOrThrow({
      where: { runId, kind: "web_fetch" },
    });
    assert.equal(
      effect.status,
      "intended",
      `${side.kind}: a malformed nested credential drops the whole list`,
    );
  });
}

if (picked("cancel-origin-empty-userinfo")) {
  await scenario("cancel-origin-empty-userinfo", (side) =>
    cancelWithCredentialOrigin(side, "origin-empty-userinfo", "https://@example.com", "denied"),
  );
}

if (picked("cancel-origin-percent-host")) {
  await scenario("cancel-origin-percent-host", (side) =>
    cancelWithCredentialOrigin(side, "origin-percent-host", "https://exa%6dple.com", "denied"),
  );
}

if (picked("cancel-origin-unicode-space")) {
  await scenario("cancel-origin-unicode-space", (side) =>
    cancelWithCredentialOrigin(
      side,
      "origin-unicode-space",
      "https://example.com\u00a0",
      "intended",
    ),
  );
}

if (picked("cancel-origin-fullwidth-dot")) {
  await scenario("cancel-origin-fullwidth-dot", (side) =>
    cancelWithCredentialOrigin(
      side,
      "origin-fullwidth-dot",
      "https://metadata.google.internal\u3002",
      "intended",
    ),
  );
}

if (picked("cancel-origin-alabel-control")) {
  await scenario("cancel-origin-alabel-control", (side) =>
    cancelWithCredentialOrigin(
      side,
      "origin-alabel-control",
      "https://xn--bcher-kva.example/",
      "denied",
    ),
  );
}

// A mixed A-label label: Node/ICU throws on the non-ASCII `xn--` label, so the
// ask list is unparseable and the open effect is never denied. Before the
// UTS #46 A-label gate, Go punycode-decoded the non-ASCII bytes and accepted
// the origin, flipping this effect to denied.
if (picked("cancel-origin-mixed-alabel")) {
  await scenario("cancel-origin-mixed-alabel", (side) =>
    cancelWithCredentialOrigin(
      side,
      "origin-mixed-alabel",
      "https://xn--bcüer-kva.example/",
      "intended",
    ),
  );
}

// A valid A-label whose decoded label contains a code point ICU's UTS #46
// tables accept but an older UCD-derived ContextJ/Bidi table rejected. Node
// accepts the origin, so the open effect must be denied on both sides.
if (picked("cancel-origin-icu-alabel")) {
  await scenario("cancel-origin-icu-alabel", (side) =>
    cancelWithCredentialOrigin(side, "origin-icu-alabel", "https://xn--csfe.ü/", "denied"),
  );
}

// The reverse direction: Node/ICU rejects this A-label once the domain becomes
// non-ASCII, so the ask list is unparseable and the effect stays intended.
if (picked("cancel-origin-alabel-reverse")) {
  await scenario("cancel-origin-alabel-reverse", (side) =>
    cancelWithCredentialOrigin(
      side,
      "origin-alabel-reverse",
      "https://xn--nybvznylx.i.ü/",
      "intended",
    ),
  );
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
      data: {
        id: otherSpace,
        organizationId: fixture.orgId,
        name: "Other Space",
        isDefault: false,
      },
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
      data: {
        id: id("steering"),
        messageId: steeringMessage.id,
        botId: fixture.botId,
        userId: fixture.userId,
      },
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
    const result = await cancelConversation(side);
    // cancelThreadRuns stamps its own now (thread-stop.ts:88): completedAt is not
    // a caller clock and updatedAt is statement time.
    assert.equal(result.eventSeq, 2, "the progress row is gone, the run.cancelled is seq 2");
    assert.equal(result.cancelled, 1);
    await assertStatementTime(runA, "conversation cancel", null);
    return { extra: result };
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
        id: staleTaskId,
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        userId: fixture.userId,
        prompt: "first",
        status: "queued",
        createdAt: PINNED,
        updatedAt: PINNED,
      },
    });
    await system.run.create({
      data: {
        id: staleRunId,
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        taskId: staleTask.id,
        userId: fixture.userId,
        status: "queued",
        trigger: "user",
        sourceMessageId: source.id,
        createdAt: PINNED,
        updatedAt: PINNED,
      },
    });
    const freshTaskId = id("fresh-task");
    const freshRunId = id("fresh-run");
    side.remember(freshTaskId, "<task:fresh>");
    side.remember(freshRunId, "<run:fresh>");
    const freshTask = await system.task.create({
      data: {
        id: freshTaskId,
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        userId: fixture.userId,
        prompt: "second",
        status: "queued",
        createdAt: PINNED,
        updatedAt: PINNED,
      },
    });
    await system.run.create({
      data: {
        id: freshRunId,
        spaceId: fixture.spaceId,
        botId: fixture.botId,
        threadId: fixture.threadId,
        taskId: freshTask.id,
        userId: fixture.userId,
        status: "queued",
        trigger: "user",
        sourceMessageId: source.id,
        createdAt: PINNED,
        updatedAt: PINNED,
      },
    });
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
      });
    }
    // cancelSupersededQueuedRuns stamps its own now (thread-target.ts:266-271).
    if (
      (await system.run.findUniqueOrThrow({ where: { id: staleRunId }, select: { status: true } }))
        .status !== "cancelled"
    ) {
      throw new Error("the superseded run must be cancelled");
    }
    await assertStatementTime(staleRunId, "supersede", null);
  });
}

// ---------------------------------------------------------------- review repros
if (picked("create-routine-null-thinking")) {
  await scenario("create-routine-null-thinking", async (side) => {
    // routineRunModelPin keeps a routine's NULL thinkingLevel NULL
    // (model-selection.ts:1054-1067).
    await system.routine.update({
      where: { id: side.fixture.routineId },
      data: { modelProvider: "openai", modelId: "gpt-x", thinkingLevel: null },
    });
    await create(side, {
      trigger: "routine",
      nonce: "routine-run:proof:null-thinking",
      routineRun: true,
      at: PINNED,
    });
  });
}

if (picked("create-routine-no-pin")) {
  await scenario("create-routine-no-pin", async (side) => {
    // routineRunModelPin returns {} and its spread writes no pin column, so the
    // Go caller passes no Model at all.
    await system.routine.update({
      where: { id: side.fixture.routineId },
      data: { modelProvider: null, modelId: null, thinkingLevel: null },
    });
    await create(side, {
      trigger: "routine",
      nonce: "routine-run:proof:no-pin",
      routineRun: true,
      at: PINNED,
    });
  });
}

if (picked("create-pin-presence")) {
  await scenario("create-pin-presence", async (side) => {
    // sendUserMessage writes modelPinned: true for any pin object; the model
    // columns stay NULL when it names none (events.ts:559-566).
    await create(side, { trigger: "webhook", modelPinPresent: true, at: PINNED });
  });
}

if (picked("create-wake-at")) {
  await scenario("create-wake-at", async (side) => {
    // A ticket wake stores its due time in the creating transaction.
    await create(side, {
      trigger: "tickets",
      wakeAt: new Date("2026-11-22T08:15:00.000Z"),
      at: PINNED,
    });
  });
}

if (picked("create-group-reply")) {
  await scenario("create-group-reply", async (side) => {
    const messageId = await seedMessage(side, 1, "hello group");
    await create(side, {
      trigger: "user",
      nonce: "send:group-1",
      groupReplyOptional: true,
      sourceMessageId: messageId,
      at: PINNED,
    });
  });
}

if (picked("create-delegated")) {
  await scenario("create-delegated", async (side) => {
    const parent = await create(side, { trigger: "user", at: PINNED, label: "<run:parent>" });
    await create(side, {
      trigger: "helper",
      delegatedFromRunId: parent.runId,
      at: new Date(PINNED.getTime() + 1_000),
      label: "<run:helper>",
    });
  });
}

if (picked("create-retry")) {
  await scenario("create-retry", async (side) => {
    const first = await create(side, {
      trigger: "routine",
      routineId: side.fixture.routineId,
      at: PINNED,
      label: "<run:first>",
    });
    await create(side, {
      trigger: "routine",
      routineId: side.fixture.routineId,
      retryOfRunId: first.runId,
      at: new Date(PINNED.getTime() + 1_000),
      label: "<run:retry>",
    });
  });
}

if (picked("wake-running")) {
  await scenario("wake-running", async (side) => {
    const runId = await seedActiveRun(side, "a");
    await wake(side, runId, {});
    // TS's enqueue calls starter.start without reading the update count, so a due
    // wake is announced even when the row is not resumable; nothing is written.
    await expectFrames(1, "a due wake is announced even for a running run");
  });
}

if (picked("wake-finished")) {
  await scenario("wake-finished", async (side) => {
    const runId = await seedActiveRun(side, "a");
    await system.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date("2026-11-22T08:09:00.000Z") },
    });
    await wake(side, runId, {});
    await expectFrames(1, "a due wake is announced even for a finished run");
  });
}

if (picked("wake-keep-existing-fill")) {
  await scenario("wake-keep-existing-fill", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED });
    await wake(side, created.runId, { keepExisting: true });
    const row = await system.run.findUniqueOrThrow({
      where: { id: created.runId },
      select: { wakeAt: true },
    });
    assert.ok(row.wakeAt, "keepExisting must fill an empty wake time");
    // The written instant is each side's wall clock: pin it for the comparison.
    await system.run.update({ where: { id: created.runId }, data: { wakeAt: PINNED } });
  });
}

if (picked("wake-clock")) {
  await scenario("wake-clock", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED });
    // A caller-supplied Now 50 ms behind the wall clock must not suppress the
    // frame: the due decision is Date.now(), Now only stamps updatedAt
    // (run-wakeup.ts:88-93).
    await wake(side, created.runId, { now: new Date(Date.now() - 50) });
    await expectFrames(1, "the caller's older clock must not suppress the frame");
    const row = await system.run.findUniqueOrThrow({
      where: { id: created.runId },
      select: { wakeAt: true },
    });
    assert.ok(row.wakeAt, "the wake must be written");
    await system.run.update({ where: { id: created.runId }, data: { wakeAt: PINNED } });
  });
}

if (picked("by-thread-user-nonce")) {
  await check(
    "by-thread-user-nonce: the replay predicate is {threadId, userId, clientNonce}",
    async () => {
      const results: Record<string, any> = {};
      const nonce = "routine-run:proof:lookup";
      for (const kind of ["ts", "go"] as const) {
        const fixture = await makeFixture(`lookup-${kind}`);
        const side: Side = {
          kind,
          fixture,
          labels: baseLabels(fixture),
          remember(actual, label) {
            this.labels.set(actual, label);
          },
        };
        try {
          const created = await create(side, { trigger: "routine", nonce, at: PINNED });
          const otherThread = id(`other-thread-${kind}`);
          // A thread needs exactly one owner (threads_owner_chk): give it a bot.
          const otherBot = id(`other-bot-${kind}`);
          await system.bot.create({
            data: {
              id: otherBot,
              spaceId: fixture.spaceId,
              userId: fixture.userId,
              name: "Other bot",
              color: "green",
            },
          });
          await system.thread.create({
            data: {
              id: otherThread,
              spaceId: fixture.spaceId,
              userId: fixture.userId,
              botId: otherBot,
              nextMessageSeq: 1,
              nextEventSeq: 1,
            },
          });
          const otherUser = id(`other-user-${kind}`);
          await system.user.create({
            data: {
              id: otherUser,
              name: "Other User",
              email: `${otherUser}@example.test`,
              emailVerified: true,
            },
          });
          if (kind === "ts") {
            // routes/routines.ts:369-380: the outer precheck names the person too.
            const same = await system.run.findFirst({
              where: { threadId: fixture.threadId, userId: fixture.userId, clientNonce: nonce },
              select: { id: true },
            });
            const elsewhere = await system.run.findFirst({
              where: { threadId: otherThread, userId: fixture.userId, clientNonce: nonce },
              select: { id: true },
            });
            const another = await system.run.findFirst({
              where: { threadId: fixture.threadId, userId: otherUser, clientNonce: nonce },
              select: { id: true },
            });
            results[kind] = {
              same: same?.id === created.runId,
              elsewhere: Boolean(elsewhere),
              another: Boolean(another),
            };
          } else {
            const actor = { spaceId: fixture.spaceId, userId: fixture.userId };
            const same = await go({
              op: "byThreadUserNonce",
              actor,
              threadId: fixture.threadId,
              userId: fixture.userId,
              clientNonce: nonce,
            });
            const elsewhere = await go({
              op: "byThreadUserNonce",
              actor,
              threadId: otherThread,
              userId: fixture.userId,
              clientNonce: nonce,
            });
            const another = await go({
              op: "byThreadUserNonce",
              actor,
              threadId: fixture.threadId,
              userId: otherUser,
              clientNonce: nonce,
            });
            results[kind] = {
              same: same.found && same.runId === created.runId,
              elsewhere: Boolean(elsewhere.found),
              another: Boolean(another.found),
            };
          }
        } finally {
          await dropFixture(fixture);
        }
      }
      assert.deepEqual(results.go, results.ts, "lookups");
      assert.equal(results.ts.same, true, "the same chat and person must replay");
      assert.equal(results.ts.elsewhere, false, "another chat's run is not a replay");
      assert.equal(results.ts.another, false, "another person's run is not a replay");
    },
  );
}

if (picked("concurrent-create")) {
  await check("concurrent-create: one submission wins the unique key", async () => {
    const results: Record<string, any> = {};
    const nonce = "send:concurrent";
    for (const kind of ["ts", "go"] as const) {
      const fixture = await makeFixture(`concurrent-${kind}`);
      try {
        let created = 0;
        let conflicts = 0;
        if (kind === "ts") {
          const attempt = () =>
            system.$transaction(async (tx) => {
              const task = await tx.task.create({
                data: {
                  spaceId: fixture.spaceId,
                  botId: fixture.botId,
                  threadId: fixture.threadId,
                  userId: fixture.userId,
                  prompt: "race",
                  status: "queued",
                  createdAt: PINNED,
                  updatedAt: PINNED,
                },
              });
              return tx.run.create({
                data: {
                  spaceId: fixture.spaceId,
                  botId: fixture.botId,
                  threadId: fixture.threadId,
                  taskId: task.id,
                  userId: fixture.userId,
                  status: "queued",
                  trigger: "user",
                  clientNonce: nonce,
                  createdAt: PINNED,
                  updatedAt: PINNED,
                },
              });
            });
          const settled = await Promise.allSettled([attempt(), attempt()]);
          for (const outcome of settled) {
            if (outcome.status === "fulfilled") created += 1;
            else if ((outcome.reason as any)?.code === "P2002") conflicts += 1;
            else throw outcome.reason;
          }
        } else {
          const response = await go({
            op: "raceCreate",
            actor: { spaceId: fixture.spaceId, userId: fixture.userId },
            spaceId: fixture.spaceId,
            botId: fixture.botId,
            threadId: fixture.threadId,
            userId: fixture.userId,
            clientNonce: nonce,
          });
          created = response.created ?? 0;
          conflicts = response.conflicts ?? 0;
        }
        const runs = await system.run.findMany({ where: { spaceId: fixture.spaceId } });
        const tasks = await system.task.findMany({ where: { spaceId: fixture.spaceId } });
        results[kind] = { created, conflicts, runs: runs.length, tasks: tasks.length };
      } finally {
        await dropFixture(fixture);
      }
    }
    assert.deepEqual(results.go, results.ts, "race outcome");
    assert.deepEqual(results.ts, { created: 1, conflicts: 1, runs: 1, tasks: 1 });
  });
}

if (picked("cancel-conversation-note")) {
  await scenario("cancel-conversation-note", async (side) => {
    const created = await create(side, { trigger: "user", at: PINNED, label: "<run:stopped>" });
    await claimRun(side, created.runId);
    const result = await cancelConversation(side, {
      note: { botId: side.fixture.botId },
      writeNotes: true,
    });
    // run.cancelled (1), then the stop note's thread.message.created (2): the
    // returned cursor is the note, not the run event (thread-stop.ts:145-205).
    assert.equal(result.eventSeq, 2, "the cursor must be the last note event");
    assert.equal(result.cancelled, 1);
    await assertStatementTime(created.runId, "conversation cancel", null);
    return { extra: result };
  });
}

if (picked("cancel-conversation-routine-note")) {
  await scenario("cancel-conversation-routine-note", async (side) => {
    // A fixed name: the note text carries it, and fixtures are side-specific.
    await system.routine.update({
      where: { id: side.fixture.routineId },
      data: { name: "Release bot" },
    });
    const created = await create(side, {
      trigger: "routine",
      routineId: side.fixture.routineId,
      at: PINNED,
      label: "<run:routine>",
    });
    await claimRun(side, created.runId);
    const result = await cancelConversation(side, { writeNotes: true });
    assert.equal(result.eventSeq, 2, "the routine note's event is the cursor");
    assert.equal(result.cancelled, 1);
    const note = await system.message.findFirstOrThrow({
      where: { threadId: side.fixture.threadId, role: "system" },
    });
    assert.deepEqual(note.blocks, [{ kind: "meta", text: stoppedRoutineNote("Release bot") }]);
    await assertStatementTime(created.runId, "routine cancel", null);
    return { extra: result };
  });
}

if (picked("cancel-conversation-teardown")) {
  await scenario("cancel-conversation-teardown", async (side) => {
    const fixture = side.fixture;
    const runId = await seedActiveRun(side, "a");
    // The stop must snapshot the run's lease and the computer it names before
    // commit (thread-stop.ts:100-112).
    const computer = await system.computer.findFirstOrThrow({
      where: { spaceId: fixture.spaceId },
    });
    await system.computerExecutionLease.create({
      data: {
        id: id("lease"),
        computerId: computer.id,
        botId: fixture.botId,
        runId,
        fence: 1,
        expiresAt: new Date("2026-11-22T09:00:00.000Z"),
      },
    });
    const result = await cancelConversation(side);
    assert.equal(result.leases, 1, "the run's lease must be snapshotted");
    assert.equal(result.computers, 1, "the lease's computer must be resolved");
    assert.equal(result.stoppedHelpers, 0);
    assert.equal(result.eventSeq, 1, "one run.cancelled event");
    return { extra: result };
  });
}

if (picked("cancel-helper-scoped")) {
  await scenario("cancel-helper-scoped", async (side) => {
    const fixture = side.fixture;
    const cardId = await seedMessage(side, 1, "delegate this");
    // A helper works in a thread of its own; its card is the chat's message.
    const helperThreadId = id(`helper-thread-${side.kind}`);
    side.remember(helperThreadId, "<helper-thread>");
    await system.thread.create({
      data: {
        id: helperThreadId,
        spaceId: fixture.spaceId,
        userId: fixture.userId,
        helperBotId: fixture.botId,
        nextMessageSeq: 1,
        nextEventSeq: 1,
      },
    });
    const helper = await create(side, {
      trigger: "helper",
      sourceMessageId: cardId,
      threadId: helperThreadId,
      at: PINNED,
      label: "<run:helper>",
    });
    await claimRun(side, helper.runId);
    const unrelated = await create(side, {
      trigger: "user",
      at: new Date(PINNED.getTime() + 1),
      label: "<run:unrelated>",
    });
    const result = await cancelConversation(side, { helperMessageId: cardId });
    assert.equal(result.cancelled, 1, "only the helper behind the card is stopped");
    assert.deepEqual(
      (
        await system.run.findUniqueOrThrow({
          where: { id: unrelated.runId },
          select: { status: true },
        })
      ).status,
      "queued",
      "the chat's own run survives a card-scoped stop",
    );
    // A helper in a thread of its own gets no run.cancelled event in the chat.
    assert.equal(result.eventSeq, null, "a helper's own thread gets no chat event");
    assert.equal(result.stoppedHelpers, 1);
    return { extra: result };
  });
}

if (picked("cancel-two-notes")) {
  await check(
    "cancel-two-notes: notes come in TS order and the cursor ends at the last",
    async () => {
      const observations: Record<string, any> = {};
      for (const kind of ["ts", "go"] as const) {
        const fixture = await makeFixture(`two-notes-${kind}`);
        const side: Side = {
          kind,
          fixture,
          labels: baseLabels(fixture),
          remember(actual, label) {
            this.labels.set(actual, label);
          },
        };
        try {
          await system.routine.update({
            where: { id: fixture.routineId },
            data: { name: "Release bot" },
          });
          const routine = await create(side, {
            trigger: "routine",
            routineId: fixture.routineId,
            at: PINNED,
            label: "<run:routine>",
          });
          const user = await create(side, {
            trigger: "user",
            at: new Date(PINNED.getTime() + 1),
            label: "<run:user>",
          });
          await claimRun(side, routine.runId);
          await claimRun(side, user.runId);
          const result = await cancelConversation(side, {
            note: { botId: fixture.botId },
            writeNotes: true,
          });
          const messages = await system.message.findMany({
            where: { threadId: fixture.threadId, role: "system" },
            orderBy: { seq: "asc" },
          });
          observations[kind] = {
            eventSeq: result.eventSeq,
            cancelled: result.cancelled,
            texts: messages.map((message) =>
              (message.blocks as Array<{ text?: string; kind?: string }>)
                .map((block) => block.text ?? block.kind)
                .join("|"),
            ),
          };
        } finally {
          await dropFixture(fixture);
        }
      }
      assert.deepEqual(observations.go, observations.ts, "notes and cursor");
      assert.equal(observations.ts.cancelled, 2);
      // Two run.cancelled events (DB order is either run's) then the two notes.
      assert.equal(observations.ts.eventSeq, 4);
      assert.deepEqual(observations.ts.texts, [
        stoppedRoutineNote("Release bot"),
        STOPPED_BY_MESSAGE_NOTE,
      ]);
    },
  );
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
          const publisher = new RunJobPublisher(
            system as any,
            new GraphileJobPublisher(pool),
            starter,
          );
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
            routineId: replaceIds(
              row.payload.routineId,
              new Map([[fixture.routineId, "<routine>"]]),
            ),
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
  await check(
    "worker: a real TypeScript RunWorkerHost completes a run Go created and woke",
    async () => {
      const { createApp } = await import("../../api/src/app.js");
      const { RunWorkerHost } = await import(
        "../../../packages/adapters/src/runs/wakeups/run-wakeup.js"
      );
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
        let run: any;
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
    },
  );
}

// ---------------------------------------------------------------- run1 procedures
if (picked("run1")) {
  await check("run1: the real worker completes routine, skill and approved-chat runs", async () => {
    const { createApp } = await import("../../api/src/app.js");
    const { RunWorkerHost } = await import(
      "../../../packages/adapters/src/runs/wakeups/run-wakeup.js"
    );
    const { EncryptedSecretStore } = await import(
      "../../../packages/adapters/src/secrets/secrets.js"
    );
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    // The worker case's app.stop() closed the shared fanout; this case owns one.
    const run1Fanout = new PostgresRealtimeFanout({
      connectionString: DATABASE_URL,
      publisher: pool,
    });
    const fixture = await makeFixture("run1");
    const dataDir = mkdtempSync(path.join(tmpdir(), "infra-b-run1-"));
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
      realtime: run1Fanout,
      prisma,
    } as any);
    await run1Fanout.subscribe("proof-warmup-run1", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const starter = new RunStarter(run1Fanout);
    let handlerRuns = 0;
    const host = new RunWorkerHost(prisma, run1Fanout, starter, {});
    const handlers = {
      "run.continue": async (payload: { runId: string }, execution?: any) => {
        handlerRuns += 1;
        await app.executor.continueRun(payload.runId, "proof-run1", execution?.onRunStarted);
      },
    } as any;
    const waitForRun = async (runId: string, label: string) => {
      const deadline = Date.now() + 60_000;
      let run: any;
      while (Date.now() < deadline) {
        run = await system.run.findUnique({ where: { id: runId } });
        if (run?.status === "completed" || run?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        run?.status,
        "completed",
        `${label} must complete (${run?.status}: ${run?.error ?? ""})`,
      );
      return run;
    };
    try {
      await host.start(handlers);

      // A pinned routine model must also be a connected one, or the worker fails
      // the run before the model (PINNED_PROVIDER_NOT_CONNECTED). The API reads
      // this key through EncryptedSecretStore, so seal it the same way.
      const secretId = id("run1-model-secret");
      const secrets = new EncryptedSecretStore(process.env.ENCRYPTION_KEY!);
      const sealed = await secrets.put(
        "sk-infra-b-run1-proof",
        {
          signal: new AbortController().signal,
        } as any,
        { recordId: secretId },
      );
      await system.secret.create({
        data: {
          id: secretId,
          userId: fixture.userId,
          spaceId: null,
          kind: "model",
          ciphertext: sealed.ciphertext,
        },
      });
      const credentialId = id("run1-credential");
      await system.userModelCredential.create({
        data: {
          id: credentialId,
          userId: fixture.userId,
          provider: "openrouter",
          label: "Run1 OpenRouter",
          secretId,
        },
      });
      // The pin is a free-form id ("x/y"), so the connection must name it as its
      // default model or the run path refuses it as UNKNOWN_PROVIDER_MODEL.
      await system.userModelPreference.create({
        data: { userId: fixture.userId, credentialId, modelId: "x/y", thinkingLevel: "high" },
      });
      await system.routine.update({
        where: { id: fixture.routineId },
        data: {
          modelProvider: "openrouter",
          modelId: "x/y",
          thinkingLevel: "high",
          // The test run ignores the schedule; inactive keeps a due occurrence from
          // adding a fourth run while this case runs.
          active: false,
        },
      });

      const skillId = id("run1-skill");
      await system.taughtSkill.create({
        data: {
          id: skillId,
          spaceId: fixture.spaceId,
          botId: fixture.botId,
          userId: fixture.userId,
          name: "Run1 taught skill",
          goal: "prove the taught-skill trial run",
          status: "saved",
          playbook: {
            whenToUse: "when the run1 proof runs",
            inputs: [],
            steps: ["one"],
            howToCheck: "the run completes",
            whatToReturn: "one sentence",
            approvalBoundaries: "ask before sending anything",
            failureHandling: "report the failure",
          },
        },
      });

      const serverId = id("run1-server");
      await system.mcpServer.create({
        data: {
          id: serverId,
          spaceId: fixture.spaceId,
          userId: fixture.userId,
          slug: `run1-${tag}`,
          name: "Run1 MCP server",
          transport: "http",
          endpoint: "https://run1.example.test/mcp",
          enabled: true,
          allSpaces: true,
        },
      });

      const actor = { spaceId: fixture.spaceId, userId: fixture.userId };

      // 1. routines.testRun: the pin follows the routine.
      const routine = await go({
        op: "routineTestRun",
        actor,
        input: { routineId: fixture.routineId, clientNonce: "run1-routine" },
      });
      const routineRunId: string = routine.body.runId;
      const routineRun = await waitForRun(routineRunId, "the routine test run");
      assert.equal(routineRun.trigger, "routine", "the test run's trigger");
      assert.equal(routineRun.routineId, fixture.routineId, "the test run's routine");
      assert.equal(routineRun.modelPinned, true, "the routine model must stay pinned");
      assert.equal(routineRun.modelProvider, "openrouter", "the pinned provider");
      assert.equal(routineRun.modelId, "x/y", "the pinned model");
      assert.equal(routineRun.thinkingLevel, "high", "the pinned thinking level");

      // 2. skills.testRun with no prompt: the playbook is the task prompt.
      const skill = await go({ op: "skillTestRun", actor, input: { skillId } });
      const skillRunId: string = skill.body.runId;
      const skillRun = await waitForRun(skillRunId, "the skill test run");
      assert.equal(skillRun.trigger, "skill", "the trial run's trigger");
      const skillTask = await system.task.findUniqueOrThrow({ where: { id: skillRun.taskId } });
      assert.ok(
        skillTask.prompt.startsWith("Run taught skill: "),
        `the trial task renders the playbook (${skillTask.prompt.slice(0, 40)})`,
      );

      // Neither earlier run may hold the chat, or the approval queues nothing.
      const thread = await system.thread.findUniqueOrThrow({
        where: { id: fixture.threadId },
        select: { nextMessageSeq: true },
      });
      const cardSeq = thread.nextMessageSeq;
      await system.message.create({
        data: {
          id: id("run1-card"),
          threadId: fixture.threadId,
          seq: cardSeq,
          role: "bot",
          botId: fixture.botId,
          blocks: [
            {
              kind: "mcp_approval",
              name: "Run1 MCP server",
              serverId,
              transport: "http",
              endpoint: "https://run1.example.test/mcp",
              needsOAuth: false,
              status: "pending",
            },
          ],
        },
      });
      await system.thread.update({
        where: { id: fixture.threadId },
        data: { nextMessageSeq: cardSeq + 1 },
      });

      // 3. mcp.assignments.approve: the card is repainted connected, the bot is
      // assigned, and the hidden follow-on turn is queued and woken.
      frames = [];
      const approve = await go({
        op: "approveAssignment",
        actor,
        input: { botId: fixture.botId, serverId, threadId: fixture.threadId },
      });
      assert.equal(approve.body.serverId, serverId, "the approval returns the assignment");
      const assignment = await system.botMcpServer.findUnique({
        where: { botId_serverId: { botId: fixture.botId, serverId } },
      });
      assert.ok(assignment, "the approval must assign the server to the bot");
      assert.equal(assignment.allowAllTools, true, "the new assignment allows every tool");
      // The repaint's event is appended in the approval transaction; read it now so
      // nothing the follow-on turn writes later can be mistaken for it.
      const updated = await system.event.findFirst({
        where: { threadId: fixture.threadId, type: "thread.message.updated" },
        orderBy: { seq: "desc" },
      });
      assert.ok(updated, "the approve must append thread.message.updated");
      const approvedRun = await system.run.findFirst({
        where: {
          threadId: fixture.threadId,
          id: { notIn: [routineRunId, skillRunId] },
        },
        orderBy: { createdAt: "desc" },
        include: { task: { select: { prompt: true } } },
      });
      assert.ok(approvedRun, "the approval must queue exactly one follow-on run");
      assert.equal(approvedRun.trigger, "user", "the approved-chat run's trigger");
      assert.ok(
        approvedRun.task.prompt.includes("connected the MCP server"),
        "the approved-chat run is the hidden follow-on turn",
      );
      await waitForRun(approvedRun.id, "the approved-chat run");

      // The approve repaint announces its thread.message.updated cursor.
      await settleFrames();
      const repaint = frames.find((frame) => {
        if (frame.topic !== `thread:${fixture.threadId}`) return false;
        try {
          return JSON.parse(frame.payload).cursor === updated!.seq;
        } catch {
          return false;
        }
      });
      assert.ok(repaint, "the approve repaint must be announced on the thread topic");

      // Each run's own reply is in the chat, and the host handled all three.
      const replies = await system.message.count({
        where: {
          threadId: fixture.threadId,
          role: "bot",
          runId: { in: [routineRunId, skillRunId, approvedRun.id] },
        },
      });
      assert.equal(replies, 3, "each run must write one bot reply");
      assert.equal(handlerRuns, 3, "the RunWorkerHost must handle all three runs");
    } finally {
      await host.stop();
      await app.stop();
      await dropFixture(fixture);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

if (picked("run1-signals")) {
  await check(
    "run1-signals: a Go-created test run publishes the same frames as TypeScript",
    async () => {
      const { createApp } = await import("../../api/src/app.js");
      const { RunWorkerHost } = await import(
        "../../../packages/adapters/src/runs/wakeups/run-wakeup.js"
      );
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const run1Fanout = new PostgresRealtimeFanout({
        connectionString: DATABASE_URL,
        publisher: pool,
      });
      // Two independent fixtures: each run's space, thread and bot are its own, so every frame is
      // attributable and the same normalizer sees the same shape.
      const fixtureGo = await makeFixture("sig-go");
      const fixtureTs = await makeFixture("sig-ts");
      const dataDir = mkdtempSync(path.join(tmpdir(), "infra-b-run1-signals-"));
      process.env.BETTER_AUTH_SECRET ??= "infra-b-proof-secret-0123456789abcdef";
      process.env.NODE_ENV ??= "test";
      process.env.AGENT_RUNTIME = "scripted";
      process.env.SANDBOX_PROVIDER = "fake";
      process.env.WAKEUP_DRIVER = "postgres";
      const app = await createApp({
        databaseUrl: DATABASE_URL,
        dataDir,
        webOrigin: "http://127.0.0.1:5173",
        authUrl: "http://127.0.0.1:5173",
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "postgres",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        realtime: run1Fanout,
        prisma,
      } as any);
      await run1Fanout.subscribe("proof-warmup-signals", () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const starter = new RunStarter(run1Fanout);
      let handlerRuns = 0;
      let goGateway: any;
      let upstreamServer: any;
      const host = new RunWorkerHost(prisma, run1Fanout, starter, {});
      const handlers = {
        "run.continue": async (payload: { runId: string }, execution?: any) => {
          handlerRuns += 1;
          await app.executor.continueRun(
            payload.runId,
            "proof-run1-signals",
            execution?.onRunStarted,
          );
        },
      } as any;
      const waitForRun = async (runId: string, label: string) => {
        const deadline = Date.now() + 60_000;
        let run: any;
        while (Date.now() < deadline) {
          run = await system.run.findUnique({ where: { id: runId } });
          if (run?.status === "completed" || run?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(
          run?.status,
          "completed",
          `${label} must complete (${run?.status}: ${run?.error ?? ""})`,
        );
        return run;
      };
      try {
        await host.start(handlers);

        // The TypeScript twin runs on the worker path too: a TS API without spare capacity hands
        // the run off with runs:ready instead of starting it locally. The app's RunJobPublisher
        // calls its starter's start(); replacing that one method with the handoff is exactly the
        // frame a full TS API process publishes, and the real worker host executes the run.
        (app as any).jobs.starter = {
          start: (runId: string) => {
            void run1Fanout.publish("runs:ready", runId).catch(() => undefined);
          },
        };

        // A real session for the TypeScript fixture's user, so the route runs as that member.
        const sessionToken = `sigtok-${tag}-${randomBytes(12).toString("hex")}`;
        await system.session.create({
          data: {
            id: `sigsess-${tag}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            token: sessionToken,
            userId: fixtureTs.userId,
          },
        });
        const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
          .update(sessionToken)
          .digest("base64");
        const cookie = `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`;
        const headers = {
          "content-type": "application/json",
          origin: "http://127.0.0.1:5173",
          cookie,
          "x-rakazo-space-id": fixtureTs.spaceId,
        };

        await settleFrames();
        frames = [];
        const beforeTs = frames.length;
        const response = await app.app.request(
          "/rpc/routines/testRun",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ json: { routineId: fixtureTs.routineId } }),
          },
          { incoming: { socket: { remoteAddress: "127.0.0.1" } } } as any,
        );
        assert.equal(response.status, 200, "the TypeScript route must create the run");
        const responseBody = (await response.json()) as any;
        const tsRunId: string = responseBody?.json?.runId ?? responseBody?.runId;
        assert.ok(tsRunId, `TypeScript route body = ${JSON.stringify(responseBody)}`);
        const tsRun = await waitForRun(tsRunId, "the TypeScript-created run");

        await settleFrames();
        const tsFrames = frames
          .slice(beforeTs)
          .filter((frame) =>
            frame.topic === "runs:ready"
              ? frame.payload === tsRunId
              : frame.topic === `space-changes:${fixtureTs.spaceId}` ||
                frame.topic === `thread:${fixtureTs.threadId}`,
          );

        // The Go side must run through the real gateway, not the proof driver: the gateway is what
        // runs the procedure's effects (security events, roster/space-change signals) outside the
        // procedure body, exactly as the TypeScript route's authed middleware does.
        const GO_GATEWAY_PORT = 3270;
        const UPSTREAM_PORT = 3996;
        const routesFile = path.join(dataDir, "routes-signals.json");
        const buildIdFile = path.join(dataDir, "build-id-signals");
        writeFileSync(
          routesFile,
          JSON.stringify({ routes: { "routines.testRun": { mode: "go" } } }),
        );
        writeFileSync(buildIdFile, "proof-signals");
        upstreamServer = createServer(async (req: any, res: any) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const upstreamResponse = await app.app.request(
              `http://127.0.0.1${req.url ?? "/"}`,
              {
                method: req.method,
                headers: req.headers,
                body: chunks.length ? Buffer.concat(chunks) : undefined,
              },
              { incoming: { socket: { remoteAddress: "127.0.0.1" } } } as any,
            );
            res.statusCode = upstreamResponse.status;
            upstreamResponse.headers.forEach((value: string, key: string) => {
              res.setHeader(key, value);
            });
            res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
          }
        });
        await new Promise<void>((resolve) =>
          upstreamServer.listen(UPSTREAM_PORT, "127.0.0.1", resolve),
        );
        goGateway = spawn(
          process.env.GO_GATEWAY_BIN ?? "/tmp/infra-b/gateway-run1",
          [
            "-listen",
            `127.0.0.1:${GO_GATEWAY_PORT}`,
            "-upstream",
            `http://127.0.0.1:${UPSTREAM_PORT}`,
            "-routes",
            routesFile,
            "-build-id-file",
            buildIdFile,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL,
              BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
              BETTER_AUTH_URL: "http://127.0.0.1:5173",
              WEB_ORIGIN: "http://127.0.0.1:5173",
              ENCRYPTION_KEY: process.env.ENCRYPTION_KEY!,
              CONTENT_ENCRYPTION: "on",
              MAX_UPLOAD_SIZE_MB: "10",
              SMTP_URL: "",
              EMAIL_PROVIDER: "",
              EMAIL_EMULATOR: "",
              INBOUND_EMAIL_DOMAIN: "inbound.contract.test",
              INBOUND_EMAIL_SECRET: "inbound-email-secret-0123456789abcdef",
              SANDBOX_MAX_COMPUTERS_PER_USER: "5",
              PHONE_CALLS_ENABLED: "true",
              PHONE_CALL_RING_SECONDS: "45",
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        const gatewayStderr: Buffer[] = [];
        goGateway.stderr?.on("data", (chunk: Buffer) => gatewayStderr.push(chunk));
        let gatewayReady = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            const health = await fetch(`http://127.0.0.1:${GO_GATEWAY_PORT}/healthz`);
            if (health.ok) {
              gatewayReady = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!gatewayReady) {
          throw new Error(
            `the Go gateway did not become ready: ${Buffer.concat(gatewayStderr).toString()}`,
          );
        }

        const goSessionToken = `sigtokgo-${tag}-${randomBytes(12).toString("hex")}`;
        await system.session.create({
          data: {
            id: `sigsessgo-${tag}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            token: goSessionToken,
            userId: fixtureGo.userId,
          },
        });
        const goSignature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
          .update(goSessionToken)
          .digest("base64");
        const goCookie = `better-auth.session_token=${encodeURIComponent(`${goSessionToken}.${goSignature}`)}`;

        await settleFrames();
        const beforeGo = frames.length;
        const goResponse = await fetch(`http://127.0.0.1:${GO_GATEWAY_PORT}/rpc/routines/testRun`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
            cookie: goCookie,
            "x-rakazo-space-id": fixtureGo.spaceId,
          },
          body: JSON.stringify({ json: { routineId: fixtureGo.routineId } }),
        });
        if (goResponse.status !== 200) {
          throw new Error(
            `the Go gateway route must create the run (${goResponse.status}: ${await goResponse.text()})`,
          );
        }
        const goBody = (await goResponse.json()) as any;
        const goRunId: string = goBody?.json?.runId ?? goBody?.runId;
        assert.ok(goRunId, `Go gateway body = ${JSON.stringify(goBody)}`);
        const goRun = await waitForRun(goRunId, "the Go-created run");
        await settleFrames();
        const goFrames = frames
          .slice(beforeGo)
          .filter((frame) =>
            frame.topic === "runs:ready"
              ? frame.payload === goRunId
              : frame.topic === `space-changes:${fixtureGo.spaceId}` ||
                frame.topic === `thread:${fixtureGo.threadId}`,
          );

        const normalizeFrames = (
          list: Array<{ topic: string; payload: string }>,
          fixture: Fixture,
          runId: string,
        ) => {
          const labels = new Map<string, string>([
            [fixture.orgId, "<org>"],
            [fixture.userId, "<user>"],
            [fixture.spaceId, "<space>"],
            [fixture.botId, "<bot>"],
            [fixture.threadId, "<thread>"],
            [fixture.routineId, "<routine>"],
            [fixture.computerId, "<computer>"],
            [runId, "<run>"],
          ]);
          const replace = (text: string) => {
            let out = replaceIds(text, labels);
            out = out.replace(/c[a-z0-9]{24}/g, "<cuid>");
            out = out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>");
            return out;
          };
          return list.map((frame) => ({
            topic: replace(frame.topic),
            payload: replace(frame.payload),
          }));
        };
        const tsNormalized = normalizeFrames(tsFrames, fixtureTs, tsRunId);
        const goNormalized = normalizeFrames(goFrames, fixtureGo, goRunId);
        console.log("run1-signals typescript:", JSON.stringify(tsNormalized, null, 2));
        console.log("run1-signals go:        ", JSON.stringify(goNormalized, null, 2));
        // The two processes announce the same facts on independent channels (the
        // gateway's effects and the procedure's wake), so delivery order between
        // topics is not a contract; the set of frames is.
        const sorted = (list: Array<{ topic: string; payload: string }>) =>
          [...list].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          );
        assert.deepEqual(sorted(goNormalized), sorted(tsNormalized), "worker-path realtime frames");

        const tsTask = await system.task.findUniqueOrThrow({ where: { id: tsRun.taskId } });
        const goTask = await system.task.findUniqueOrThrow({ where: { id: goRun.taskId } });
        assert.equal(goTask.prompt, tsTask.prompt, "the test-run task prompt");
        assert.equal(goRun.trigger, tsRun.trigger, "the test-run trigger");
        assert.equal(goRun.routineId, fixtureGo.routineId, "the Go run's routine");
        assert.equal(tsRun.routineId, fixtureTs.routineId, "the TypeScript run's routine");
        assert.equal(handlerRuns, 2, "the real worker host must claim both runs");
      } finally {
        if (goGateway) {
          goGateway.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            if (goGateway.exitCode !== null) resolve();
            else goGateway.once("exit", () => resolve());
          });
        }
        if (upstreamServer)
          await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
        await host.stop();
        await app.stop();
        await dropFixture(fixtureGo);
        await dropFixture(fixtureTs);
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
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
