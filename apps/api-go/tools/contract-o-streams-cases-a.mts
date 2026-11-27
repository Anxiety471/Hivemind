/**
 * Lane O cases: thread subscription and related streams.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { DATABASE_URL, RUN_TAG, ownerClient, system } from "./contract-o-streams-env.mts";
import {
  addEvent,
  addMessage,
  addRun,
  callNonce,
  callRequest,
  case_,
  cases,
  closeWithin,
  ended,
  expectSame,
  openGo,
  openTS,
  payloadOf,
  publishUntil,
  rawFrames,
  seed,
  typeOf,
  waitFor,
} from "./contract-o-streams-helpers.mts";
import type { Frame, Stream } from "./contract-o-streams-helpers.mts";

export const THREAD = "threads.subscribe";

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
export async function expectEndsTogether(
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
