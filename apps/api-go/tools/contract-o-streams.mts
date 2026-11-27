/**
 * Contract test for the four live streams: the same fixture is opened as a server-sent event
 * stream on the TypeScript API (in-process, against the fixture database) and through the Go
 * gateway, and the frames each side sends are compared.
 *
 * A stream is never shadowed (a shadow would have to buffer it), so the Go route table must serve
 * all four locally; the harness asserts the gateway log says so.
 *
 * Run from a checkout with node_modules, against a fixture database neither side is serving:
 *   set -a; . /home/hitori/go-port/fixture-db/.env.o-streams; set +a
 *   GO_BINARY=/tmp/rakazo-gateway node_modules/.bin/tsx apps/api-go/tools/contract-o-streams.mts
 *
 * Timing corners: the TypeScript side's heartbeat (20 s), keepalive (5 s) and session re-check
 * (10 s) are module constants, so those cases take real time and both sides are opened at once.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { asSystem } from "../../../packages/db/src/index.js";
import { createApp } from "../../api/src/app.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const GO_BINARY = process.env.GO_BINARY;
if (!GO_BINARY) throw new Error("GO_BINARY is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const BUILD_ID_FILE = process.env.BUILD_ID_FILE ?? join(process.cwd(), "apps/web/dist/build-id");
const SECRET = "contract-test-secret-0123456789abcdef";
const WEB_ORIGIN = "http://127.0.0.1:5173";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const RUN_TAG = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : "";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const GO_PORT = process.env.GO_PORT ?? "3284";
const GO_URL = `http://127.0.0.1:${GO_PORT}`;
// The gateway's upstream bridge: the in-process app, so a proxied stream would still answer.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const UPSTREAM_PORT = process.env.UPSTREAM_PORT ?? "3996";

process.env.PHONE_CALLS_ENABLED = "true";
process.env.PHONE_CALL_RING_SECONDS = "45";
// The app reads these through loadEnv at createApp time; the fixture env file need not carry them.
process.env.NODE_ENV = "test";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.SIGNUPS_ENABLED = "true";
process.env.BETTER_AUTH_SECRET = SECRET;
process.env.ENCRYPTION_KEY = CONTRACT_ENCRYPTION_KEY;
process.env.CONTENT_ENCRYPTION = "on";

// A raw listener: proves a signal was published, independent of either side's fanout.
const databaseRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
type PgClientLike = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: { payload?: string }) => void): void;
};
const { Client: PgClient } = databaseRequire("pg") as {
  Client: new (options: { connectionString: string }) => PgClientLike;
};
const signals: string[] = [];
const signalClient = new PgClient({ connectionString: DATABASE_URL });
// The owner connection: RLS lets the app role update no row it did not scope, and content writes
// must bypass the system client's sealing to plant a ciphertext no key can open.
const ownerClient = new PgClient({ connectionString: process.env.DATABASE_MIGRATION_URL ?? DATABASE_URL });
await signalClient.connect();
await ownerClient.connect();
await signalClient.query("LISTEN rakazo_events");
signalClient.on("notification", (notification) => {
  if (notification.payload) signals.push(notification.payload);
});

const dataDir = await mkdtemp(join(tmpdir(), "rakazo-contract-o-"));
const handles = await createApp({
  databaseUrl: DATABASE_URL,
  dataDir,
  authSecret: SECRET,
  encryptionKey: CONTRACT_ENCRYPTION_KEY,
  screenProxySecret: "contract-test-screen-secret-0123456789abcdef",
  webOrigin: WEB_ORIGIN,
  authUrl: WEB_ORIGIN,
  nodeEnv: "test",
  signupsEnabled: "true",
  agentRuntime: "scripted",
  adminEmails: [],
  inboundEmail: { domain: "bots.contract.test", secret: "contract-inbound-email-secret-0123456789" },
  sandboxProvider: "fake",
  wakeupDriver: "memory",
} as never);
const system = asSystem(handles.prisma);

const upstreamServer = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && name !== "host" && name !== "content-length")
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = Buffer.concat(chunks);
  const response = await handles.app.request(
    incoming.url ?? "/",
    { method: incoming.method, headers, body: body.length > 0 ? body : undefined },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const answer: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    answer[name] = value;
  });
  outgoing.writeHead(response.status, answer);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) =>
  upstreamServer.listen(Number(UPSTREAM_PORT), "127.0.0.1", resolve),
);

const routesFile = join(dataDir, "routes.json");
await writeFile(
  routesFile,
  JSON.stringify({
    default: "proxy",
    routes: {
      "threads.subscribe": { mode: "go" },
      "threads.helperSubscribe": { mode: "go" },
      "notifications.subscribe": { mode: "go" },
      "notifications.subscribeCalls": { mode: "go" },
    },
  }),
);

let go: ChildProcess | undefined;
let gatewayLog = "";
const gatewayEnv = {
  ...process.env,
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: WEB_ORIGIN,
  WEB_ORIGIN,
  ENCRYPTION_KEY: CONTRACT_ENCRYPTION_KEY,
  CONTENT_ENCRYPTION: "on",
  PHONE_CALLS_ENABLED: "true",
  PHONE_CALL_RING_SECONDS: "45",
};
go = spawn(
  GO_BINARY,
  [
    "-listen",
    `127.0.0.1:${GO_PORT}`,
    "-upstream",
    `http://127.0.0.1:${UPSTREAM_PORT}`,
    "-routes",
    routesFile,
    "-build-id-file",
    BUILD_ID_FILE,
  ],
  { env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] },
);
const capture = (chunk: Buffer) => {
  gatewayLog += chunk.toString();
  process.stderr.write(chunk);
};
go.stdout?.on("data", capture);
go.stderr?.on("data", capture);
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(`${GO_URL}/healthz`)).ok) break;
  } catch {
    // still starting
  }
  if (attempt === 99) throw new Error("go gateway did not start");
  await sleep(50);
}

function cookieFor(token: string) {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function callHeaders(seeded: Seeded) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    origin: WEB_ORIGIN,
    cookie: seeded.cookie,
    "x-rakazo-space-id": seeded.spaceId,
  };
}

// ---- fixture ---------------------------------------------------------------------------------

type Seeded = {
  userId: string;
  orgId: string;
  spaceId: string;
  otherSpaceId: string;
  sessionToken: string;
  cookie: string;
  botId: string;
  otherBotId: string;
  groupId: string;
  threadId: string;
  otherThreadId: string;
  helperBotId: string;
  helperThreadId: string;
  callBotId: string;
  callThreadId: string;
};

let caseCounter = 0;

async function seed(name: string): Promise<Seeded> {
  caseCounter += 1;
  const slug = `${name.replace(/[^a-z0-9]/g, "")}${caseCounter}`;
  const userId = `co${RUN_TAG}-${slug}-u`;
  const orgId = `co${RUN_TAG}-${slug}-o`;
  const spaceId = `co${RUN_TAG}-${slug}-s1`;
  const otherSpaceId = `co${RUN_TAG}-${slug}-s2`;
  const sessionToken = `token${RUN_TAG}-${slug}-${"0".repeat(24)}`;
  await system.user.create({
    data: { id: userId, name: "Stream User", email: `${userId}@example.test`, emailVerified: true },
  });
  await system.organization.create({
    data: { id: orgId, name: "Stream Org", slug: `stream-${slug}-${process.pid}`, createdAt: new Date() },
  });
  await system.member.create({
    data: {
      id: `${orgId}-m`,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  for (const [index, id] of [spaceId, otherSpaceId].entries()) {
    await system.space.create({
      data: { id, organizationId: orgId, name: `Space ${index + 1}`, isDefault: index === 0 },
    });
    await system.spaceMember.create({
      data: {
        id: `${id}-m`,
        spaceId: id,
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  await system.session.create({
    data: {
      id: `${userId}-session`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      token: sessionToken,
      userId,
    },
  });
  const bot = (id: string, space: string, botName: string) =>
    system.bot.create({
      data: { id, spaceId: space, userId, name: botName, color: "blue" },
    });
  const botId = `${userId}-b`;
  const otherBotId = `${userId}-b2`;
  const helperBotId = `${userId}-hb`;
  const callBotId = `${userId}-cb`;
  await bot(botId, spaceId, "Bot");
  await bot(otherBotId, otherSpaceId, "Other bot");
  await bot(helperBotId, spaceId, "Helper");
  await bot(callBotId, spaceId, "Caller");
  const groupId = `${userId}-g`;
  await system.chatGroup.create({
    data: { id: groupId, spaceId, userId, name: "Group" },
  });
  const thread = (
    id: string,
    data: Record<string, unknown>,
  ) => system.thread.create({ data: { id, spaceId, userId, ...data } as never });
  return {
    userId,
    orgId,
    spaceId,
    otherSpaceId,
    sessionToken,
    cookie: cookieFor(sessionToken),
    botId,
    otherBotId,
    groupId,
    threadId: await (async () => {
      const id = `${userId}-t`;
      await thread(id, { botId });
      return id;
    })(),
    otherThreadId: await (async () => {
      const id = `${userId}-t2`;
      await thread(id, { botId: otherBotId });
      return id;
    })(),
    helperBotId,
    helperThreadId: await (async () => {
      const id = `${userId}-th`;
      await thread(id, { helperBotId });
      return id;
    })(),
    callBotId,
    callThreadId: await (async () => {
      const id = `${userId}-tc`;
      await thread(id, { botId: callBotId });
      return id;
    })(),
  };
}

async function addEvent(
  seeded: Seeded,
  threadId: string,
  botId: string,
  seq: number,
  type: string,
  payload: unknown,
  runId?: string,
) {
  await system.event.create({
    data: {
      id: `${threadId}-e${seq}`,
      spaceId: seeded.spaceId,
      threadId,
      botId,
      seq,
      type,
      payload: payload as never,
      runId: runId ?? null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    },
  });
}

async function addMessage(
  seeded: Seeded,
  threadId: string,
  seq: number,
  blocks: unknown[],
  options: { createdAt?: Date; clientNonce?: string } = {},
) {
  await system.message.create({
    data: {
      id: `${threadId}-m${seq}`,
      threadId,
      seq,
      role: "bot",
      blocks: blocks as never,
      clientNonce: options.clientNonce ?? null,
      createdAt: options.createdAt ?? new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    },
  });
}

/**
 * The ringing request loadUserIncomingCalls looks for: a bot's message whose clientNonce is
 * `<call:><something>:request` (CALL_CLIENT_NONCE_PREFIX, call-nonce.ts:9) and whose first block
 * is a live call_request (call-request.ts:296-336).
 */
function callRequest(seeded: Seeded, callID: string, expiresAt: string) {
  return {
    kind: "call_request",
    status: "ringing",
    callId: callID,
    reason: "checking in",
    opening: "Hello?",
    expiresAt,
  };
}

function callNonce(callID: string) {
  return `call:${callID}:request`;
}

/** The raw `data:` text of every message frame, for a byte-exact comparison. */
function rawFrames(stream: Stream) {
  return stream.frames
    .filter((frame) => frame.event === "message")
    .map((frame) => frame.raw ?? "");
}

/** A run of the given trigger, with the task row runs.taskId requires. */
async function addRun(seeded: Seeded, threadId: string, runId: string, trigger: string) {
  await system.task.create({
    data: {
      id: `${runId}-task`,
      spaceId: seeded.spaceId,
      botId: seeded.botId,
      threadId,
      userId: seeded.userId,
      prompt: "Task",
      status: "queued",
    },
  });
  await system.run.create({
    data: {
      id: runId,
      spaceId: seeded.spaceId,
      threadId,
      botId: seeded.botId,
      taskId: `${runId}-task`,
      userId: seeded.userId,
      trigger,
      status: "running",
    },
  });
}

/**
 * Publishes one realtime signal. `payload` is the text the subscriber receives: publishers send
 * whatever their topic defines — a JSON object for alerts and thread cursors, the bare kind for a
 * Space change — and a fanout ignores an envelope whose payload is not a string
 * (realtime.ts:146-149).
 */
async function publish(topic: string, payload: string) {
  await system.$executeRawUnsafe(
    "SELECT pg_notify('rakazo_events', $1)",
    JSON.stringify({ topic, payload }),
  );
}

/**
 * Publishes a signal until every stream passes the predicate. A notification sent before a
 * subscriber's LISTEN is in place is lost (the thread stream would then poll 30 s later), so the
 * publisher repeats the wake; the receivers re-read by cursor, so a repeat sends no extra frame.
 */
async function publishUntil(
  topic: string,
  payload: string,
  streams: Stream[],
  predicate: (frames: Frame[]) => boolean,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await publish(topic, payload);
    const deadlineWait = Date.now() + 700;
    while (Date.now() < deadlineWait) {
      if (streams.every((stream) => predicate(stream.frames))) return;
      if (Date.now() > deadline) break;
      await sleep(50);
    }
    if (Date.now() > deadline) break;
  }
  throw new Error(
    `${label}: no matching frame within ${timeoutMs} ms; got ${JSON.stringify(streams.map((s) => s.frames))};` +
      ` signals ${JSON.stringify(signals.slice(-4))}`,
  );
}

// ---- stream reader ---------------------------------------------------------------------------

type Frame = { event: string; data: unknown; raw?: string };

type Stream = {
  status: number;
  contentType: string | null;
  frames: Frame[];
  comments: string[];
  closed: Promise<void>;
  failure: () => unknown;
  close: () => Promise<void>;
};

function parseBlock(block: string, frames: Frame[], comments: string[]) {
  const lines = block.split("\n");
  if (lines.every((line) => line === "" || line.startsWith(":"))) {
    comments.push(block);
    return;
  }
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  const text = data.join("\n");
  if (text === "") {
    frames.push({ event, data: undefined });
    return;
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  const envelope = parsed as { json?: unknown };
  frames.push({
    event,
    raw: text,
    data:
      typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 1 && "json" in envelope
        ? envelope.json
        : parsed,
  });
}

const endedStreams = new WeakSet<Stream>();

function ended(stream: Stream) {
  return endedStreams.has(stream);
}

function track(response: Response, close: () => Promise<void>): Stream {
  const frames: Frame[] = [];
  const comments: string[] = [];
  let failure: unknown;
  const closed = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          parseBlock(buffer.slice(0, index), frames, comments);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
      }
    } catch (cause) {
      failure = cause;
    }
  })();
  const stream: Stream = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    frames,
    comments,
    closed,
    failure: () => failure,
    close,
  };
  void closed.then(() => endedStreams.add(stream));
  return stream;
}

async function openTS(procedure: string, input: unknown, seeded: Seeded): Promise<Stream> {
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: callHeaders(seeded), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  return track(response, async () => {
    await response.body?.cancel().catch(() => {});
  });
}

async function openGo(procedure: string, input: unknown, seeded: Seeded): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${GO_URL}/rpc/${procedure.replaceAll(".", "/")}`, {
    method: "POST",
    headers: callHeaders(seeded),
    body: JSON.stringify({ json: input }),
    signal: controller.signal,
  });
  return track(response, async () => {
    controller.abort();
  });
}

async function waitFor(
  stream: Stream,
  predicate: (frames: Frame[]) => boolean,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(stream.frames)) return;
    await sleep(25);
  }
  throw new Error(
    `${label}: no matching frame within ${timeoutMs} ms; got ${JSON.stringify(stream.frames)}` +
      ` (ended ${ended(stream) ? "yes" : "no"}, failure ${String(stream.failure())})`,
  );
}

/** Every frame, with a heartbeat's timestamp keys normalized (both sides read the clock). */
function normalized(stream: Stream) {
  return stream.frames
    .filter((frame) => frame.event !== "comment")
    .map((frame) => {
      const data = frame.data as Record<string, unknown> | undefined;
      if (frame.event === "message" && (data?.type === "heartbeat" || data?.kind === "heartbeat")) {
        return { event: frame.event, data: { ...data, at: "<at>", createdAt: "<at>" } };
      }
      return { event: frame.event, data: frame.data };
    });
}

function expectSame(ts: Stream, go: Stream, label: string, mode: "exact" | "multiset" = "exact") {
  const left = normalized(ts);
  const right = normalized(go);
  const text = (frames: unknown[]) => JSON.stringify(frames, null, 1);
  if (mode === "multiset") {
    const key = (frame: unknown) => JSON.stringify(frame);
    assert.deepEqual(
      [...left].map(key).sort(),
      [...right].map(key).sort(),
      `${label}: initial frames differ as a multiset\nTS ${text(left)}\nGo ${text(right)}`,
    );
    return;
  }
  assert.deepEqual(right, left, `${label}: frames differ\nTS ${text(left)}\nGo ${text(right)}`);
}

/** Asserts each source kept its own order: every frame of one `kind` appears in the same order. */
/**
 * Publishes one signal and waits. A source that spaces its wakes (the roster debounces to one
 * frame per 10 s) would have the spacing reset by every repeat, so its signal is sent once.
 */
async function publishOnceAndWait(
  topic: string,
  payload: string,
  streams: Stream[],
  predicate: (frames: Frame[]) => boolean,
  timeoutMs: number,
  label: string,
) {
  await publish(topic, payload);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (streams.every((stream) => predicate(stream.frames))) return;
    await sleep(50);
  }
  throw new Error(
    `${label}: no matching frame within ${timeoutMs} ms; got ${JSON.stringify(streams.map((s) => s.frames))}`,
  );
}

/**
 * Ends a stream without waiting on its teardown: cancelling an in-process response queues behind
 * whatever read the source is in the middle of, which is not what a case is testing.
 */
async function closeWithin(stream: Stream) {
  await Promise.race([stream.close().catch(() => {}), sleep(2000)]);
  await Promise.race([stream.closed, sleep(2000)]);
}

/** A frame's payload when it is an object, without trusting its shape. */
function payloadOf(frame: Frame): Record<string, unknown> | undefined {
  const data = frame.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

function typeOf(frame: Frame): string | undefined {
  const payload = payloadOf(frame);
  const type = payload?.type ?? payload?.kind;
  return typeof type === "string" ? type : undefined;
}

function expectGroupOrder(stream: Stream, key: (frame: Frame) => string) {
  const seen = new Map<string, string[]>();
  for (const frame of normalized(stream)) {
    const group = key(frame);
    const list = seen.get(group) ?? [];
    list.push(JSON.stringify(frame));
    seen.set(group, list);
  }
  return seen;
}

// ---- cases -----------------------------------------------------------------------------------

type Case = { name: string; run: () => Promise<void> };

const cases: Case[] = [];
const case_ = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const THREAD = "threads.subscribe";

case_("thread-initial-replay", async () => {
  const seeded = await seed("thread-initial-replay");
  await addEvent(seeded, seeded.threadId, seeded.botId, 1, "thread.progress", { step: 1 });
  await addEvent(seeded, seeded.threadId, seeded.botId, 2, "thread.message.created", { messageId: "m1" });
  await addEvent(seeded, seeded.threadId, seeded.botId, 3, "thread.cleared", {});
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await waitFor(ts, (frames) => frames.length >= 3, 5000, "ts");
  await waitFor(goStream, (frames) => frames.length >= 3, 5000, "go");
  assert.equal(ts.status, 200);
  assert.equal(goStream.status, 200);
  assert.match(ts.contentType ?? "", /text\/event-stream/);
  assert.equal(goStream.contentType, ts.contentType);
  expectSame(ts, goStream, "initial replay");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-cursor-resume", async () => {
  const seeded = await seed("thread-cursor-resume");
  for (const seq of [1, 2, 3, 4]) {
    await addEvent(seeded, seeded.threadId, seeded.botId, seq, "thread.progress", { seq });
  }
  const input = { botId: seeded.botId, cursor: 2 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await waitFor(ts, (frames) => frames.length >= 2, 5000, "ts");
  await waitFor(goStream, (frames) => frames.length >= 2, 5000, "go");
  expectSame(ts, goStream, "cursor resume");
  assert.deepEqual(
    goStream.frames.map((frame) => payloadOf(frame)?.["seq"]),
    [3, 4],
  );
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-peer-and-background-filter", async () => {
  const seeded = await seed("thread-peer-filter");
  await addRun(seeded, seeded.threadId, `${seeded.userId}-peer-run`, "bot_message");
  await addRun(seeded, seeded.threadId, `${seeded.userId}-bg-run`, "tickets");
  await addRun(seeded, seeded.threadId, `${seeded.userId}-own-run`, "user_message");
  const peerRun = `${seeded.userId}-peer-run`;
  const bgRun = `${seeded.userId}-bg-run`;
  const ownRun = `${seeded.userId}-own-run`;
  await addEvent(seeded, seeded.threadId, seeded.botId, 1, "thread.progress", { run: "own" }, ownRun);
  await addEvent(seeded, seeded.threadId, seeded.botId, 2, "thread.progress", { run: "peer" }, peerRun);
  await addEvent(seeded, seeded.threadId, seeded.botId, 3, "run.started", { run: "bg" }, bgRun);
  await addEvent(seeded, seeded.threadId, seeded.botId, 4, "thread.progress", { run: "bg" }, bgRun);
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await waitFor(ts, (frames) => frames.length >= 1, 5000, "ts");
  await waitFor(goStream, (frames) => frames.length >= 1, 5000, "go");
  await sleep(250);
  expectSame(ts, goStream, "peer and background filter");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-live-and-disconnect", async () => {
  const seeded = await seed("thread-live");
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await sleep(100);
  await addEvent(seeded, seeded.threadId, seeded.botId, 9, "thread.progress", { live: true });
  await publishUntil(
    `thread:${seeded.threadId}`,
    JSON.stringify({ cursor: 9 }),
    [ts, goStream],
    (frames) => frames.length >= 1,
    12_000,
    "live frame",
  );
  expectSame(ts, goStream, "live frame");
  // A disconnect must not leave anything behind: both sides end the stream and the gateway
  // answers a later call on a fresh connection.
  await closeWithin(ts);
  await closeWithin(goStream);
  const after = await openGo("notifications.subscribeCalls", {}, seeded);
  assert.equal(after.status, 200);
  await closeWithin(after);
});

case_("helper-subscribe", async () => {
  const seeded = await seed("helper");
  await addEvent(seeded, seeded.helperThreadId, seeded.helperBotId, 1, "thread.progress", { n: 1 });
  await addEvent(seeded, seeded.helperThreadId, seeded.helperBotId, 2, "thread.cleared", {});
  const input = { threadId: seeded.helperThreadId, cursor: -1 };
  const ts = await openTS("threads.helperSubscribe", input, seeded);
  const goStream = await openGo("threads.helperSubscribe", input, seeded);
  await waitFor(ts, (frames) => frames.length >= 2, 5000, "ts");
  await waitFor(goStream, (frames) => frames.length >= 2, 5000, "go");
  expectSame(ts, goStream, "helper replay");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("helper-subscribe-heartbeat", async () => {
  const seeded = await seed("helper-heartbeat");
  const input = { threadId: seeded.helperThreadId, cursor: -1 };
  const ts = await openTS("threads.helperSubscribe", input, seeded);
  const goStream = await openGo("threads.helperSubscribe", input, seeded);
  const heartbeat = (frames: Frame[]) => frames.some((frame) => typeOf(frame) === "heartbeat");
  await waitFor(ts, heartbeat, 25_000, "ts heartbeat");
  await waitFor(goStream, heartbeat, 25_000, "go heartbeat");
  const onlyHeartbeats = (stream: Stream): Stream => ({
    ...stream,
    frames: stream.frames.filter((frame) => typeOf(frame) === "heartbeat"),
  });
  expectSame(onlyHeartbeats(ts), onlyHeartbeats(goStream), "heartbeat");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-jsonb-key-order", async () => {
  const seeded = await seed("jsonb-keys");
  // jsonb returns an object's keys byte-ordered by length first, and JSON.parse keeps that order
  // apart from hoisting integer-like keys to the front. Both objects' bytes must match TypeScript.
  const rows: Array<[string, string, string]> = [
    ["keys", `{"b":1,"aa":2}`, `{"b":1,"aa":2}`],
    ["ints", `{"10":1,"9":2,"a":3}`, `{"9":2,"10":1,"a":3}`],
  ];
  for (const [name, text, want] of rows) {
    await system.$executeRawUnsafe(
      `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
       VALUES ($1, $2, $3, $4, $5, 'thread.progress', $6::jsonb, now())`,
      `${seeded.userId}-${name}`,
      seeded.spaceId,
      seeded.threadId,
      seeded.botId,
      rows.findIndex((row) => row[0] === name) + 1,
      text,
    );
    // The expectation is JSON.stringify's output for what Postgres returns, not the stored text.
    assert.equal(JSON.stringify(JSON.parse(text)), want, `${name}: want is not JSON.stringify's`);
  }
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await waitFor(ts, (frames) => frames.length >= 2, 5000, "ts");
  await waitFor(goStream, (frames) => frames.length >= 2, 5000, "go");
  const payloadOfFrame = (frame: Frame) => {
    const match = /"payload":(\{[^{}]*\})/.exec(frame.raw ?? "");
    return match?.[1];
  };
  const tsPayloads = ts.frames.map(payloadOfFrame);
  const goPayloads = goStream.frames.map(payloadOfFrame);
  assert.deepEqual(goPayloads, tsPayloads, "payload bytes differ");
  assert.deepEqual(tsPayloads, rows.map((row) => row[2]), "payload bytes are not JSON.stringify's");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-subscribe-rejections", async () => {
  const seeded = await seed("thread-reject");
  const cases: Array<{ label: string; input: unknown }> = [
    { label: "both targets", input: { botId: seeded.botId, groupId: seeded.groupId } },
    { label: "no target", input: {} },
    { label: "two spaces apart", input: { botId: seeded.botId, cursor: -1 } },
    { label: "cursor below -1", input: { botId: seeded.botId, cursor: -2 } },
    { label: "cursor fraction", input: { botId: seeded.botId, cursor: 1.5 } },
  ];
  for (const item of cases) {
    const ts = await openTS(THREAD, item.input, seeded);
    const goStream = await openGo(THREAD, item.input, seeded);
    assert.equal(goStream.status, ts.status, `${item.label}: status`);
    assert.deepEqual(goStream.frames, ts.frames, `${item.label}: body`);
    await closeWithin(ts);
    await closeWithin(goStream);
  }
  // A bot that is nobody's: the lookup runs inside the generator on both sides, so the client
  // gets 200 and a stream that ends with no frames.
  const unknown = `co${RUN_TAG}-nobody`;
  const missingTS = await openTS(THREAD, { botId: unknown, cursor: -1 }, seeded);
  const missingGo = await openGo(THREAD, { botId: unknown, cursor: -1 }, seeded);
  await sleep(500);
  const errors = (stream: Stream) =>
    stream.frames
      .filter((frame) => frame.event === "error")
      .map((frame) => ({ event: frame.event, data: frame.data }));
  assert.equal(missingGo.status, missingTS.status, "unknown bot: status");
  assert.deepEqual(errors(missingGo), errors(missingTS), "unknown bot: frames");
  assert.equal(missingGo.status, 200, "unknown bot: the stream must have started");
  assert.ok(errors(missingGo).length === 1, "an unknown bot must end with one error event");
  await closeWithin(missingTS);
  await closeWithin(missingGo);
  // The same target from another Space the caller belongs to is also an empty 200.
  const other = { ...seeded, spaceId: seeded.otherSpaceId };
  const elsewhere = await openGo(THREAD, { botId: seeded.botId, cursor: -1 }, other);
  const tsElsewhere = await openTS(THREAD, { botId: seeded.botId, cursor: -1 }, other);
  await sleep(300);
  assert.equal(elsewhere.status, tsElsewhere.status, "another Space: status");
  assert.deepEqual(
    elsewhere.frames.map((frame) => ({ event: frame.event, data: frame.data })),
    tsElsewhere.frames.map((frame) => ({ event: frame.event, data: frame.data })),
    "another Space: frames",
  );
  await closeWithin(elsewhere);
  await closeWithin(tsElsewhere);
});

/**
 * Both sides' bytes up to the end of a stream that must end: the frames as sent, the error frame
 * included, and the body closed within a second of it.
 */
async function expectEndsTogether(
  label: string,
  ts: Stream,
  goStream: Stream,
  waitMs = 2000,
) {
  const deadline = Date.now() + waitMs;
  while ((!ended(ts) || !ended(goStream)) && Date.now() < deadline) await sleep(25);
  assert.ok(ended(ts), `${label}: typescript did not end (${JSON.stringify(rawFrames(ts))})`);
  assert.ok(ended(goStream), `${label}: go did not end (${JSON.stringify(rawFrames(goStream))})`);
  assert.deepEqual(rawFrames(goStream), rawFrames(ts), `${label}: the frames differ`);
  const last = (stream: Stream) => stream.frames.at(-1);
  assert.equal(last(ts)?.event, "error", `${label}: the last frame is not an error`);
  assert.deepEqual(
    { event: last(goStream)?.event, data: last(goStream)?.data },
    { event: last(ts)?.event, data: last(ts)?.data },
    `${label}: the error frame differs`,
  );
}

case_("thread-schema-rejected-ends", async () => {
  const seeded = await seed("ends-schema");
  await addEvent(seeded, seeded.threadId, seeded.botId, 1, "thread.progress", { step: 1 });
  // thread.thinking needs its run: ProductEventSchema's superRefine refuses the frame, so oRPC
  // answers one EVENT_ITERATOR_VALIDATION_FAILED event and closes the body.
  await addEvent(seeded, seeded.threadId, seeded.botId, 2, "thread.thinking", {
    segment: 0,
    durationMs: 5,
    lines: ["x"],
  });
  await addEvent(seeded, seeded.threadId, seeded.botId, 3, "thread.progress", { step: 3 });
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await expectEndsTogether("schema-rejected", ts, goStream);
  assert.equal(ts.frames.length, 2, "the frame after the rejected one must not arrive");
  assert.match(ts.frames[1]?.raw ?? "", /EVENT_ITERATOR_VALIDATION_FAILED/);
});

case_("thread-read-failure-ends", async () => {
  const seeded = await seed("ends-read");
  await addEvent(seeded, seeded.threadId, seeded.botId, 1, "thread.progress", { step: 1 });
  await addEvent(seeded, seeded.threadId, seeded.botId, 2, "thread.progress", { step: 2 });
  // Raw SQL: the system client seals on write, so only this plants a ciphertext no key opens.
  // The whole batch read fails, so neither side sends a frame from it.
  await ownerClient.query(
    `UPDATE events SET payload = '{"$sealed":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'::jsonb WHERE id = $1`,
    [`${seeded.threadId}-e2`],
  );
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await expectEndsTogether("read-failure", ts, goStream);
  assert.equal(ts.frames.length, 1, "a failing batch must send no message");
  assert.match(ts.frames[0]?.raw ?? "", /INTERNAL_SERVER_ERROR/);
});

case_("thread-nested-ciphertext-passes", async () => {
  const seeded = await seed("ends-nested");
  // openJson opens a sealed top-level value and nothing else, so a nested ciphertext-shaped
  // string is data on both sides.
  await addEvent(seeded, seeded.threadId, seeded.botId, 1, "thread.progress", {
    note: "rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await waitFor(ts, (frames) => frames.length >= 1, 5000, "ts nested");
  await waitFor(goStream, (frames) => frames.length >= 1, 5000, "go nested");
  assert.deepEqual(rawFrames(goStream), rawFrames(ts), "nested ciphertext frames differ");
  assert.match(rawFrames(ts)[0] ?? "", /\"note\":\"rkz1:nokey:/);
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("subscribe-calls-read-fails", async () => {
  const seeded = await seed("ends-calls");
  const callID = `${seeded.userId}-broken`;
  await addMessage(seeded, seeded.callThreadId, 1, [callRequest(seeded, callID, new Date(Date.now() + 45_000).toISOString())], {
    clientNonce: callNonce(callID),
  });
  const ringing = await openTS("notifications.subscribeCalls", {}, seeded);
  await waitFor(ringing, (frames) => frames.length >= 1, 5000, "ts call");
  await closeWithin(ringing);
  // The plain scalar the query filters on stays, so the row is still a ringing request; only the
  // ciphertext is one no key can open.
  await ownerClient.query(`UPDATE messages SET blocks = $2::jsonb WHERE id = $1`, [
    `${seeded.callThreadId}-m1`,
    '[{"status":"ringing","$sealed":"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]',
  ]);
  const ts = await openTS("notifications.subscribeCalls", {}, seeded);
  const goStream = await openGo("notifications.subscribeCalls", {}, seeded);
  await expectEndsTogether("calls-read", ts, goStream);
  assert.match(ts.frames[0]?.raw ?? "", /INTERNAL_SERVER_ERROR/);
});

case_("notifications-roster-failure-ends", async () => {
  const seeded = await seed("ends-roster");
  // The runtime role cannot read the table loadRosterScope's second query needs; the first watch
  // fails on both sides and account.ts holds SIGNAL_FAILURE_HOLD_MS before the stream ends.
  const role = decodeURIComponent(new URL(DATABASE_URL).username);
  await ownerClient.query(`REVOKE SELECT ON threads FROM "${role}"`);
  const restore = () => ownerClient.query(`GRANT SELECT ON threads TO "${role}"`);
  const ts = await openTS("notifications.subscribe", {}, seeded);
  const goStream = await openGo("notifications.subscribe", {}, seeded);
  try {
    await waitFor(ts, (frames) => frames.length >= 4, 8000, "ts burst");
    await waitFor(goStream, (frames) => frames.length >= 4, 8000, "go burst");
    assert.ok(
      !rawFrames(ts).some((raw) => raw.includes('"roster"')),
      "a roster frame arrived although its scope could not be read",
    );
    const deadline = Date.now() + 40_000;
    while ((!ended(ts) || !ended(goStream)) && Date.now() < deadline) await sleep(50);
    assert.ok(ended(ts), "typescript did not end after the hold");
    assert.ok(ended(goStream), "go did not end after the hold");
    // The opening burst may repeat: a fanout that has just connected delivers one empty catch-up
    // signal, and both sides re-frame what the first burst already covered. What is exact is each
    // kind's own order, the set of kinds, and the frames from the first heartbeat on — the
    // hold, then the one error event.
    const kindsOf = (stream: Stream) =>
      rawFrames(stream)
        .map((raw) => /"type":"([^"]+)"/.exec(raw)?.[1] ?? "")
        .filter((kind) => kind !== "");
    const spaceKindsOf = (stream: Stream) =>
      kindsOf(stream).filter((kind) =>
        ["computerUpdates", "runs", "routines", "files"].includes(kind),
      );
    const firstBurst = (stream: Stream) => {
      const kinds = spaceKindsOf(stream);
      const seen = new Set<string>();
      return kinds.filter((kind) => (seen.has(kind) ? false : (seen.add(kind), true)));
    };
    assert.deepEqual(firstBurst(goStream), firstBurst(ts), "the space kinds differ");
    for (const kind of ["computerUpdates", "runs", "routines", "files", "organizations"]) {
      assert.ok(kindsOf(ts).includes(kind), `typescript never sent ${kind}`);
      assert.ok(kindsOf(goStream).includes(kind), `go never sent ${kind}`);
    }
    // The body can close a tick before its last chunk is parsed: settle before reading the tail.
    // rawFrames is message frames only, so the tail comes from every event.
    await sleep(500);
    const tail = (stream: Stream) => stream.frames.filter((frame) => frame.event).at(-1)?.raw ?? "";
    assert.equal(tail(goStream), tail(ts), "the error frames differ");
    assert.match(tail(ts), /INTERNAL_SERVER_ERROR/);
  } finally {
    await restore();
    await closeWithin(ts);
    await closeWithin(goStream);
  }
});

case_("thread-subscribe-unauthorized", async () => {
  const seeded = await seed("thread-auth");
  const anonymous = { ...seeded, cookie: "" };
  const ts = await openTS(THREAD, { botId: seeded.botId, cursor: -1 }, anonymous);
  const goStream = await openGo(THREAD, { botId: seeded.botId, cursor: -1 }, anonymous);
  assert.equal(goStream.status, ts.status);
  assert.deepEqual(goStream.frames, ts.frames);
  assert.notEqual(goStream.status, 200);
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("thread-subscribe-expired-session", async () => {
  const seeded = await seed("thread-expired");
  const input = { botId: seeded.botId, cursor: -1 };
  const ts = await openTS(THREAD, input, seeded);
  const goStream = await openGo(THREAD, input, seeded);
  await sleep(100);
  await system.session.deleteMany({ where: { token: seeded.sessionToken } });
  const errored = (frames: Frame[]) => frames.some((frame) => frame.event === "error");
  // The re-check runs when a frame is produced: the quiet spell's heartbeat is the first one.
  await waitFor(ts, errored, 25_000, "ts error frame");
  await waitFor(goStream, errored, 25_000, "go error frame");
  const only = (stream: Stream) =>
    stream.frames
      .filter((frame) => frame.event === "error")
      .map((frame) => ({ event: frame.event, data: frame.data }));
  assert.deepEqual(only(goStream), only(ts), "error frame differs");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("notifications-subscribe-initial", async () => {
  const seeded = await seed("notifications-initial");
  // A Space change and a roster wake queued before the stream opens are part of the initial burst.
  const input = {};
  const ts = await openTS("notifications.subscribe", input, seeded);
  const goStream = await openGo("notifications.subscribe", input, seeded);
  await sleep(400);
  const shape = (stream: Stream) => {
    const groups = expectGroupOrder(stream, (frame) => {
      const payload = payloadOf(frame);
      const type = payload?.type;
      return typeof type === "string" ? type : (typeOf(frame) ?? "unknown");
    });
    return groups;
  };
  const tsGroups = shape(ts);
  const goGroups = shape(goStream);
  assert.deepEqual([...goGroups.keys()].sort(), [...tsGroups.keys()].sort(), "initial frame kinds");
  for (const [kind, frames] of tsGroups) {
    // A fanout catch-up after a reconnect may repeat a kind on either side; compare the distinct
    // frames of each kind, in order.
    assert.deepEqual([...new Set(goGroups.get(kind) ?? [])], [...new Set(frames)], `${kind}: content or order differs`);
  }
  // Every source speaks once. Their relative order is a race in TypeScript itself, so only the
  // set is compared.
  assert.deepEqual(
    [...new Set(normalized(goStream).map((frame) => typeOf(frame)))].sort(),
    [...new Set(normalized(ts).map((frame) => typeOf(frame)))].sort(),
    "initial burst composition",
  );
  console.log("initial frames", JSON.stringify({ ts: normalized(ts), go: normalized(goStream) }));
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("notifications-subscribe-alert", async () => {
  const seeded = await seed("notifications-alert");
  const input = {};
  const ts = await openTS("notifications.subscribe", input, seeded);
  const goStream = await openGo("notifications.subscribe", input, seeded);
  await sleep(300);
  const alert = {
    kind: "completion",
    title: "Run finished",
    body: "All done",
    spaceId: seeded.spaceId,
    botId: seeded.botId,
    threadId: seeded.threadId,
  };
  // An alert for another Space is accepted by the publisher and dropped per connection.
  await publish(`chat-alerts:${seeded.userId}`, JSON.stringify({ ...alert, spaceId: seeded.otherSpaceId }));
  const alertTitle = (frame: Frame) => {
    const value = payloadOf(frame)?.alert;
    if (typeof value !== "object" || value === null) return undefined;
    const title = (value as Record<string, unknown>).title;
    return typeof title === "string" ? title : undefined;
  };
  const alerted = (frames: Frame[]) => frames.some((frame) => alertTitle(frame) === alert.title);
  await publishUntil(`chat-alerts:${seeded.userId}`, JSON.stringify(alert), [ts, goStream], alerted, 12_000, "alert");
  const onlyAlerts = (stream: Stream): Stream => ({
    ...stream,
    frames: stream.frames
      .filter((frame) => typeOf(frame) === "alert")
      .map((frame) => ({ event: frame.event, data: frame.data })),
  });
  expectSame(onlyAlerts(ts), onlyAlerts(goStream), "alerts");
  assert.ok(
    normalized(goStream).every((frame) => {
      const value = payloadOf(frame)?.alert;
      if (typeof value !== "object" || value === null) return true;
      return (value as Record<string, unknown>).spaceId !== seeded.otherSpaceId;
    }),
    "an alert for another Space was sent",
  );
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("notifications-subscribe-space-changes", async () => {
  const seeded = await seed("notifications-space");
  const ts = await openTS("notifications.subscribe", {}, seeded);
  const goStream = await openGo("notifications.subscribe", {}, seeded);
  await sleep(300);
  const countType = (stream: Stream, type: string) =>
    normalized(stream).filter((frame) => typeOf(frame) === type).length;
  // One signal at a time: a source coalesces same-kind signals delivered in one round, so a burst
  // would make the frame count depend on scheduling instead of on the code under test.
  for (const [kind, topic] of [
    ["routines", `space-changes:${seeded.spaceId}`],
    ["runs", `space-changes:${seeded.spaceId}`],
    ["organizations", `organization-changes:${seeded.userId}`],
  ] as Array<[string, string]>) {
    const before = Math.max(countType(ts, kind), countType(goStream, kind));
    await publishUntil(
      topic,
      kind === "organizations" ? "changed" : kind,
      [ts, goStream],
      () => countType(ts, kind) > before && countType(goStream, kind) > before,
      12_000,
      topic,
    );
  }
  for (const kind of ["routines", "runs", "organizations"]) {
    assert.ok(countType(goStream, kind) >= 2, `go never announced ${kind}: ${JSON.stringify(goStream.frames)}`);
    assert.ok(countType(ts, kind) >= 2, `ts never announced ${kind}: ${JSON.stringify(ts.frames)}`);
  }
  assert.deepEqual(
    [...new Set(normalized(goStream).map((frame) => typeOf(frame)))].sort(),
    [...new Set(normalized(ts).map((frame) => typeOf(frame)))].sort(),
    "the announced kinds differ",
  );
  console.log("space frames", JSON.stringify({ ts: normalized(ts), go: normalized(goStream) }));
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("notifications-subscribe-roster", async () => {
  const seeded = await seed("notifications-roster");
  const ts = await openTS("notifications.subscribe", {}, seeded);
  const goStream = await openGo("notifications.subscribe", {}, seeded);
  await sleep(300);
  const rosters = (stream: Stream) => normalized(stream).filter((frame) => typeOf(frame) === "roster").length;
  // A fanout catch-up after its listener connects may add one more frame to the burst on either
  // side, so the burst is counted rather than assumed.
  await sleep(500);
  const before = Math.max(rosters(ts), rosters(goStream));
  assert.ok(before >= 1, "the opening burst announces the roster");
  // The roster spaces its frames by ROSTER_SIGNAL_SPACING_MS (10 s), so the wake has to come after
  // the burst's frame. A chat's own topic is what the roster watches, not a roster-specific one.
  await sleep(10_500);
  await publishOnceAndWait(
    `thread:${seeded.threadId}`,
    JSON.stringify({ type: "thread.message.created" }),
    [ts, goStream],
    () => true,
    1_000,
    "roster publish",
  );
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && (rosters(ts) <= before || rosters(goStream) <= before)) {
    await sleep(50);
  }
  assert.equal(rosters(goStream), rosters(ts), "the roster frames differ between the sides");
  assert.ok(rosters(goStream) > before, `no roster wake: ${JSON.stringify(goStream.frames)}`);
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("subscribe-calls-rings", async () => {
  const seeded = await seed("calls-ring");
  const callID = `${seeded.userId}-call`;
  await addMessage(seeded, seeded.callThreadId, 1, [callRequest(seeded, callID, new Date(Date.now() + 45_000).toISOString())], {
    clientNonce: callNonce(callID),
  });
  const ts = await openTS("notifications.subscribeCalls", {}, seeded);
  const goStream = await openGo("notifications.subscribeCalls", {}, seeded);
  const ringing = (stream: Stream) =>
    rawFrames(stream).some((raw) => raw.includes(`"callId":"${callID}"`));
  await waitFor(ts, (frames) => frames.length >= 1, 5000, "ts call");
  await waitFor(goStream, (frames) => frames.length >= 1, 5000, "go call");
  await sleep(200);
  assert.ok(ringing(ts), `ts did not ring: ${JSON.stringify(rawFrames(ts))}`);
  assert.ok(ringing(goStream), `go did not ring: ${JSON.stringify(rawFrames(goStream))}`);
  // Exact bytes: the owner's ringing call frame must be identical on both sides.
  assert.deepEqual(rawFrames(goStream), rawFrames(ts), "the ringing frames differ");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("subscribe-calls-settles", async () => {
  const seeded = await seed("calls-settled");
  const callID = `${seeded.userId}-settle`;
  await addMessage(seeded, seeded.callThreadId, 1, [callRequest(seeded, callID, new Date(Date.now() + 45_000).toISOString())], {
    clientNonce: callNonce(callID),
  });
  const ts = await openTS("notifications.subscribeCalls", {}, seeded);
  const goStream = await openGo("notifications.subscribeCalls", {}, seeded);
  const rang = (stream: Stream) => rawFrames(stream).some((raw) => raw.includes(callID));
  await waitFor(ts, () => rang(ts), 5000, "ts ring");
  await waitFor(goStream, () => rang(goStream), 5000, "go ring");
  const before = { ts: rawFrames(ts).length, go: rawFrames(goStream).length };
  // Answering (or declining, or expiry) seals the request: the block stops ringing, and the next
  // read of the owner's calls is empty.
  await system.message.update({
    where: { id: `${seeded.callThreadId}-m1` },
    data: {
      blocks: [
        { ...callRequest(seeded, callID, new Date(Date.now() + 45_000).toISOString()), status: "ended" },
      ] as never,
    },
  });
  await publish(`incoming-calls:${seeded.userId}`, "changed");
  const settled = (stream: Stream, seen: number) =>
    rawFrames(stream).length > seen && rawFrames(stream).slice(seen).every((raw) => raw.includes('"calls":[]'));
  await waitFor(ts, () => settled(ts, before.ts), 8000, "ts settle");
  await waitFor(goStream, () => settled(goStream, before.go), 8000, "go settle");
  assert.deepEqual(rawFrames(goStream), rawFrames(ts), "the ringing/settled frames differ");
  await closeWithin(ts);
  await closeWithin(goStream);
});

case_("subscribe-calls-ignore-other-owners", async () => {
  const seeded = await seed("calls-foreign");
  const callID = `${seeded.userId}-mine`;
  await addMessage(seeded, seeded.callThreadId, 1, [callRequest(seeded, callID, new Date(Date.now() + 45_000).toISOString())], {
    clientNonce: callNonce(callID),
  });
  // A second owner, with their own bot and ringing call. The query is scoped to the thread's owner
  // (`thread.userId`) and to bots that owner owns, so this call must not reach the first user.
  const otherUser = `${seeded.userId}-other`;
  const otherBot = `${otherUser}-bot`;
  const otherThread = `${otherUser}-thread`;
  const otherCall = `${otherUser}-call`;
  await system.user.create({
    data: { id: otherUser, name: "Other", email: `${otherUser}@example.test`, emailVerified: true },
  });
  await system.bot.create({
    data: { id: otherBot, spaceId: seeded.spaceId, userId: otherUser, name: "Other bot", color: "red" },
  });
  await system.thread.create({
    data: { id: otherThread, spaceId: seeded.spaceId, userId: otherUser, botId: otherBot },
  });
  await addMessage(seeded, otherThread, 1, [callRequest(seeded, otherCall, new Date(Date.now() + 45_000).toISOString())], {
    clientNonce: callNonce(otherCall),
  });
  const ts = await openTS("notifications.subscribeCalls", {}, seeded);
  const goStream = await openGo("notifications.subscribeCalls", {}, seeded);
  await waitFor(ts, (frames) => frames.length >= 1, 5000, "ts calls");
  await waitFor(goStream, (frames) => frames.length >= 1, 5000, "go calls");
  await sleep(300);
  for (const [side, stream] of [["ts", ts], ["go", goStream]] as Array<[string, Stream]>) {
    const raw = rawFrames(stream);
    assert.ok(raw.some((frame) => frame.includes(callID)), `${side}: the owner's own call is missing`);
    assert.ok(!raw.some((frame) => frame.includes(otherCall)), `${side}: another owner's call appeared`);
    assert.ok(!raw.some((frame) => frame.includes(otherBot)), `${side}: another owner's bot appeared`);
  }
  assert.deepEqual(rawFrames(goStream), rawFrames(ts), "the call frames differ");
  await closeWithin(ts);
  await closeWithin(goStream);
});

// ---- runner ----------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const CASE_FILTER = process.env.O_CASES;
let failures = 0;
for (const testCase of cases.filter((entry) => !CASE_FILTER || entry.name.includes(CASE_FILTER))) {
  try {
    await testCase.run();
    console.log(`ok ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${testCase.name}`);
    console.log(error instanceof Error ? (error.stack ?? error.message) : error);
  }
}

// Every Go stream must have been served locally: a proxied stream would show up in the upstream
// bridge instead, and a shadowed one would not answer at all.
gatewayLog += "";
await sleep(500);
const served = gatewayLog
  .split("\n")
  .filter((line) => line.includes('"served_by":"go"'))
  .filter((line) => /threads\.(helper)?[sS]ubscribe|notifications\.subscribe(Calls)?/.test(line));
console.log(`go-served stream completions: ${served.length}`);

console.log(failures === 0 ? `\n${cases.length} cases passed` : `\n${failures} case(s) failed`);
go?.kill("SIGKILL");
await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
await handles.close?.();
process.exit(failures === 0 ? 0 : 1);
