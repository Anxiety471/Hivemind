/**
 * Lane O helpers: seeding, stream readers, the frame comparison, and the case registry.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  GO_URL,
  RUN_TAG,
  callHeaders,
  cookieFor,
  handles,
  signals,
  system,
} from "./contract-o-streams-env.mts";
import type { Seeded } from "./contract-o-streams-env.mts";

export let caseCounter = 0;

export async function seed(name: string): Promise<Seeded> {
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

export async function addEvent(
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

export async function addMessage(
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
export function callRequest(seeded: Seeded, callID: string, expiresAt: string) {
  return {
    kind: "call_request",
    status: "ringing",
    callId: callID,
    reason: "checking in",
    opening: "Hello?",
    expiresAt,
  };
}

export function callNonce(callID: string) {
  return `call:${callID}:request`;
}

/** The raw `data:` text of every message frame, for a byte-exact comparison. */
export function rawFrames(stream: Stream) {
  return stream.frames
    .filter((frame) => frame.event === "message")
    .map((frame) => frame.raw ?? "");
}

/** A run of the given trigger, with the task row runs.taskId requires. */
export async function addRun(seeded: Seeded, threadId: string, runId: string, trigger: string) {
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
export async function publish(topic: string, payload: string) {
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
export async function publishUntil(
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

export type Frame = { event: string; data: unknown; raw?: string };

export type Stream = {
  status: number;
  contentType: string | null;
  frames: Frame[];
  comments: string[];
  closed: Promise<void>;
  failure: () => unknown;
  close: () => Promise<void>;
};

export function parseBlock(block: string, frames: Frame[], comments: string[]) {
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

export const endedStreams = new WeakSet<Stream>();

export function ended(stream: Stream) {
  return endedStreams.has(stream);
}

export function track(response: Response, close: () => Promise<void>): Stream {
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

export async function openTS(procedure: string, input: unknown, seeded: Seeded): Promise<Stream> {
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: callHeaders(seeded), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  return track(response, async () => {
    await response.body?.cancel().catch(() => {});
  });
}

export async function openGo(procedure: string, input: unknown, seeded: Seeded): Promise<Stream> {
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

export async function waitFor(
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
export function normalized(stream: Stream) {
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

export function expectSame(ts: Stream, go: Stream, label: string, mode: "exact" | "multiset" = "exact") {
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
export async function publishOnceAndWait(
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
export async function closeWithin(stream: Stream) {
  await Promise.race([stream.close().catch(() => {}), sleep(2000)]);
  await Promise.race([stream.closed, sleep(2000)]);
}

/** A frame's payload when it is an object, without trusting its shape. */
export function payloadOf(frame: Frame): Record<string, unknown> | undefined {
  const data = frame.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

export function typeOf(frame: Frame): string | undefined {
  const payload = payloadOf(frame);
  const type = payload?.type ?? payload?.kind;
  return typeof type === "string" ? type : undefined;
}

export function expectGroupOrder(stream: Stream, key: (frame: Frame) => string) {
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

export type Case = { name: string; run: () => Promise<void> };

export const cases: Case[] = [];
export const case_ = (name: string, run: () => Promise<void>) => cases.push({ name, run });
