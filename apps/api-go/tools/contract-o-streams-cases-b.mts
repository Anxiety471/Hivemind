/**
 * Lane O cases: the rest of the stream cases.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { system } from "./contract-o-streams-env.mts";
import {
  addMessage,
  callNonce,
  callRequest,
  case_,
  closeWithin,
  expectGroupOrder,
  expectSame,
  normalized,
  openGo,
  openTS,
  payloadOf,
  publish,
  publishOnceAndWait,
  publishUntil,
  rawFrames,
  seed,
  typeOf,
  waitFor,
} from "./contract-o-streams-helpers.mts";
import type { Frame, Stream } from "./contract-o-streams-helpers.mts";
import { THREAD } from "./contract-o-streams-cases-a.mts";

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
