/**
 * Lane L reviewer cases, now part of the suite: independent adversarial contracts
 * for notifications.registerPush / registerCallPush / unregisterPush.
 *
 * Every case is sent to both the TypeScript API and the Go gateway; the harness
 * compares status, headers, body, realtime signals and database state. `check`
 * additionally proves the two crypto directions on the side that just answered:
 * the row is opened with the shipped TypeScript store, and the *sender* path
 * (PrismaPushTokenStore.list / .devices) reads it back, so a Go-sealed row is
 * proven readable by the code that actually sends pushes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaPushTokenStore } from "../../../packages/adapters/src/notifications/push-token-store.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const store = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
const sealContext = {
  operationId: "seed",
  traceId: "seed",
  userId: "seed",
  spaceId: "seed",
  signal: new AbortController().signal,
} as never;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const seal = async (recordId: string, plaintext: string) =>
  (await store.put(plaintext, sealContext, { recordId })).ciphertext;
const later = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const IOS_DEVICE = "8f14e45f-ea4b-4f3c-8f2c-0b6a1d9e7c10";
const ANDROID_DEVICE = "3c59dc04-8e88-4f2a-9a7b-2d5e6f708192";
const VOIP = (seed: string) => createHash("sha256").update(`rvoip-${seed}`).digest("hex");
const EXPO = (seed: string) => `ExponentPushToken[r-${seed}]`;

const CORRUPT_CIPHERTEXT = "v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function laneLReviewCases(system: System): Case[] {
  async function seedOtherUser(seeded: Seeded) {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: {
        id: other,
        name: "Other",
        email: `${other}@example.test`,
        emailVerified: true,
      },
    });
    await system.session.create({
      data: { id: `${other}-session`, expiresAt: later(), token: `${other}-token`, userId: other },
    });
  }

  async function seedSecondSession(seeded: Seeded) {
    await system.session.create({
      data: {
        id: `${seeded.userId}-session2`,
        expiresAt: later(),
        token: `${seeded.sessionToken}2`,
        userId: seeded.userId,
      },
    });
  }

  async function clearPush(seeded: Seeded) {
    const owners = [seeded.userId, `${seeded.userId}-other`];
    await system.pushRegistration.deleteMany({ where: { userId: { in: owners } } });
    await system.callPushDevice.deleteMany({ where: { userId: { in: owners } } });
  }

  async function addPushToken(
    userId: string,
    token: string,
    sessionId: string,
    presentation: "android_sender" | null = null,
  ) {
    await system.pushRegistration.deleteMany({ where: { tokenDigest: digest(token) } });
    await system.pushRegistration.create({
      data: {
        userId,
        tokenDigest: digest(token),
        sessionId,
        ciphertext: await seal(`push-token:${userId}`, token),
        presentation,
        updatedAt: new Date(),
      },
    });
  }

  type CallRegistration = {
    deviceId: string;
    platform: "ios" | "android";
    expoToken?: string;
    voipToken?: string;
  };

  /** Seeds a call device whose plaintext may be hand-written (out-of-schema probes). */
  async function addCallDeviceRaw(
    userId: string,
    sessionId: string,
    id: string,
    plaintext: string,
    expoTokenDigest: string | null,
    voipTokenDigest: string | null,
  ) {
    await system.callPushDevice.deleteMany({ where: { id } });
    await system.callPushDevice.create({
      data: {
        id,
        userId,
        sessionId,
        ciphertext: await seal(`call-push:${id}`, plaintext),
        expoTokenDigest,
        voipTokenDigest,
        updatedAt: new Date(),
      },
    });
  }

  async function addCallDevice(userId: string, sessionId: string, registration: CallRegistration) {
    const id = digest(registration.deviceId);
    await system.callPushDevice.deleteMany({
      where: {
        OR: [
          { id },
          ...(registration.expoToken ? [{ expoTokenDigest: digest(registration.expoToken) }] : []),
          ...(registration.voipToken ? [{ voipTokenDigest: digest(registration.voipToken) }] : []),
        ],
      },
    });
    await system.callPushDevice.create({
      data: {
        id,
        userId,
        sessionId,
        ciphertext: await seal(`call-push:${id}`, JSON.stringify(registration)),
        expoTokenDigest: registration.expoToken ? digest(registration.expoToken) : null,
        voipTokenDigest: registration.voipToken ? digest(registration.voipToken) : null,
        updatedAt: new Date(),
      },
    });
  }

  /** The row's plaintext via the shipped TypeScript store (both crypto directions). */
  async function plaintextOf(kind: "push" | "call", userId: string, id: string) {
    if (kind === "push") {
      const row = await system.pushRegistration.findUnique({
        where: { userId_tokenDigest: { userId, tokenDigest: id } },
      });
      assert.ok(row, "push row exists");
      return (await store.load(row.ciphertext, `push-token:${userId}`)) as string;
    }
    const row = await system.callPushDevice.findUnique({ where: { id } });
    assert.ok(row, "call row exists");
    return (await store.load(row.ciphertext, `call-push:${id}`)) as string;
  }

  /** The code path the push sender uses: PrismaPushTokenStore.list / .devices. */
  async function sender(userId: string) {
    const tokens = new PrismaPushTokenStore(system, CONTRACT_ENCRYPTION_KEY);
    return { tokens: await tokens.list(userId), devices: await tokens.devices?.(userId) };
  }

  /** A Go-written push token is readable by the sender and bound to the account record id. */
  async function checkPushSender(seeded: Seeded, token: string) {
    const list = await sender(seeded.userId);
    const row = list.tokens.find((item) => item.token === token);
    assert.ok(row, `sender list sees ${JSON.stringify(token)}`);
    assert.equal(row.sessionId, `${seeded.userId}-session`);
    const saved = await system.pushRegistration.findUnique({
      where: { userId_tokenDigest: { userId: seeded.userId, tokenDigest: digest(token) } },
    });
    await assert.rejects(
      store.load(saved.ciphertext, `push-token:${seeded.userId}-other`),
      /authenticate/,
      "the ciphertext must reject another record id",
    );
  }

  const register = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lrev-${name}`,
    procedure: "notifications.registerPush",
    input,
    seed: clearPush,
    ...extra,
  });
  const call = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lrev-${name}`,
    procedure: "notifications.registerCallPush",
    input,
    seed: clearPush,
    ...extra,
  });
  const unregister = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lrev-${name}`,
    procedure: "notifications.unregisterPush",
    input,
    seed: clearPush,
    ...extra,
  });
  const tokenA = (seeded: Seeded) => `ra-${seeded.userId}`;
  const tokenB = (seeded: Seeded) => `rb-${seeded.userId}`;

  // A fixed key order plus an unknown field and characters JSON.stringify leaves
  // as-is (U+2028, <, >, &, quotes, a number, a boolean).
  const previousBytes = {
    voipToken: VOIP("bytes"),
    platform: "ios" as const,
    deviceId: IOS_DEVICE,
    note: "x<&\u2028\"\\y",
    count: 7,
    live: true,
  };
  const previousPlaintext = JSON.stringify(previousBytes);

  const protoInput = JSON.parse(
    '{"__proto__":{"polluted":true},"token":"abcdefgh","extra":{"deep":[1,2]}}',
  ) as unknown;

  return [
    // ---- registerPush: length and character-class boundaries ----------------
    register("register-token-8-exact", { token: "abcdefgh" }, {
      check: async ({ seeded }) => checkPushSender(seeded, "abcdefgh"),
    }),
    register("register-token-7", { token: "abcdefg" }),
    register("register-token-512-exact", { token: "Z".repeat(512) }),
    register("register-token-513", { token: "Z".repeat(513) }),
    register("register-token-astral-8", { token: "😀".repeat(8) }),
    register("register-token-astral-7", { token: "😀".repeat(7) }),
    // ECMAScript \s: NEL/ZWSP/MVS are not whitespace, BOM/LS/ideographic space are.
    register("register-token-nel", { token: "abcdefg\u0085" }),
    register("register-token-zwsp", { token: "abcdefg\u200b" }),
    register("register-token-mvs", { token: "abcdefg\u180e" }),
    register("register-token-del", { token: "abcdefg\u007f" }),
    register("register-token-nul", { token: "abcdefg\u0000" }, {
      check: async ({ seeded }) => checkPushSender(seeded, "abcdefg\u0000"),
    }),
    register("register-token-bom", { token: "abcdefg\ufeff" }),
    register("register-token-line-separator", { token: "abcdefg\u2028" }),
    register("register-token-ideographic-space", { token: "abcdefg\u3000" }),
    register("register-token-tab-suffix", { token: "abcdefg\t" }),
    register("register-token-bool", { token: true }),
    // object extras and the __proto__ own key are ignored, as z.object strips them.
    register("register-extra-keys", {
      token: "abcdefgh",
      presentation: "android_sender",
      extra: { nested: [1, { two: 2 }] },
    }, {
      check: async ({ seeded }) => {
        const row = await system.pushRegistration.findUnique({
          where: { userId_tokenDigest: { userId: seeded.userId, tokenDigest: digest("abcdefgh") } },
        });
        assert.equal(row.presentation, "android_sender");
        await checkPushSender(seeded, "abcdefgh");
      },
    }),
    register("register-proto-key", protoInput),
    register(
      "register-presentation-takeover",
      { token: "ra-__user__", presentation: "android_sender" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedOtherUser(seeded);
          await addPushToken(
            `${seeded.userId}-other`,
            tokenA(seeded),
            `${seeded.userId}-other-session`,
          );
        },
      },
    ),

    // ---- registerCallPush: exact limits, uuid pattern, refinement -----------
    call("call-voip-64-exact", { deviceId: IOS_DEVICE, platform: "ios", voipToken: "a".repeat(64) }),
    call("call-voip-63", { deviceId: IOS_DEVICE, platform: "ios", voipToken: "a".repeat(63) }),
    call("call-voip-200-exact", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      voipToken: "A".repeat(200),
    }),
    call("call-voip-201", { deviceId: IOS_DEVICE, platform: "ios", voipToken: "a".repeat(201) }),
    call("call-expo-8-exact", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "abcdefgh",
    }),
    call("call-expo-7", { deviceId: ANDROID_DEVICE, platform: "android", expoToken: "abcdefg" }),
    call("call-expo-512-exact", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "E".repeat(512),
    }),
    call("call-expo-513", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "E".repeat(513),
    }),
    call("call-expo-astral-8", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "😀".repeat(8),
    }),
    call("call-expo-astral-7", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "😀".repeat(7),
    }),
    call("call-uuid-v8", {
      deviceId: "123e4567-e89b-82d3-a456-426614174000",
      platform: "android",
      expoToken: EXPO("v8"),
    }),
    call("call-uuid-v0", {
      deviceId: "123e4567-e89b-02d3-a456-426614174000",
      platform: "android",
      expoToken: EXPO("v0"),
    }),
    call("call-uuid-variant-7", {
      deviceId: "123e4567-e89b-12d3-7456-426614174000",
      platform: "android",
      expoToken: EXPO("variant7"),
    }),
    // zod's uuid accepts the lowercase literal all-ones form only, not its uppercase spelling.
    call("call-uuid-upper-ones", {
      deviceId: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      platform: "android",
      expoToken: EXPO("upperones"),
    }),
    call("call-refine-ios-empty-voip", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      voipToken: "",
    }),
    call("call-refine-ios-short-voip", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      voipToken: "ab",
    }),
    call("call-refine-abort-mixed", { deviceId: 5, platform: "x", expoToken: 5 }),
    call("call-extra-keys", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: EXPO("extra"),
      extra: { note: "ignored" },
      __proto__: { polluted: true },
    }),

    // ---- registerCallPush: merges, byte exactness, forged rows --------------
    call(
      "call-merge-byte-exact",
      { deviceId: IOS_DEVICE, platform: "ios", expoToken: EXPO("bytes") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDeviceRaw(
            seeded.userId,
            `${seeded.userId}-session`,
            digest(IOS_DEVICE),
            previousPlaintext,
            null,
            digest(VOIP("bytes")),
          );
        },
        check: async ({ seeded }) => {
          const expected = JSON.stringify({
            ...previousBytes,
            deviceId: IOS_DEVICE,
            platform: "ios",
            expoToken: EXPO("bytes"),
          });
          assert.equal(
            await plaintextOf("call", seeded.userId, digest(IOS_DEVICE)),
            expected,
            "stored plaintext is JSON.stringify of the JavaScript spread",
          );
          const read = await sender(seeded.userId);
          assert.deepEqual(read.devices?.[0]?.expoToken, EXPO("bytes"));
          assert.equal(read.devices?.[0]?.voipToken, VOIP("bytes"));
        },
      },
    ),
    call(
      "call-merge-null-previous",
      { deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("nullprev") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDeviceRaw(
            seeded.userId,
            `${seeded.userId}-session`,
            digest(ANDROID_DEVICE),
            "null",
            null,
            null,
          );
        },
        check: async ({ seeded }) => {
          assert.equal(
            await plaintextOf("call", seeded.userId, digest(ANDROID_DEVICE)),
            JSON.stringify({ deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("nullprev") }),
          );
        },
      },
    ),
    call(
      "call-previous-zero-token",
      { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("zero") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDeviceRaw(
            seeded.userId,
            `${seeded.userId}-session`,
            digest(IOS_DEVICE),
            `{"deviceId":"${IOS_DEVICE}","platform":"android","expoToken":0}`,
            null,
            null,
          );
        },
        check: async ({ seeded }) => {
          assert.equal(
            await plaintextOf("call", seeded.userId, digest(IOS_DEVICE)),
            JSON.stringify({
              deviceId: IOS_DEVICE,
              platform: "ios",
              expoToken: 0,
              voipToken: VOIP("zero"),
            }),
          );
        },
      },
    ),
    // 1e-999 is 0 in JavaScript (falsy); Go must not treat the range error as truthy.
    call(
      "call-previous-underflow-token",
      { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("underflow") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDeviceRaw(
            seeded.userId,
            `${seeded.userId}-session`,
            digest(IOS_DEVICE),
            `{"deviceId":"${IOS_DEVICE}","platform":"android","expoToken":1e-999}`,
            null,
            null,
          );
        },
        check: async ({ seeded }) => {
          assert.equal(
            await plaintextOf("call", seeded.userId, digest(IOS_DEVICE)),
            JSON.stringify({
              deviceId: IOS_DEVICE,
              platform: "ios",
              expoToken: 0,
              voipToken: VOIP("underflow"),
            }),
          );
        },
      },
    ),
    // A lone surrogate in an Expo token: Node stores the escaped code unit, Go's JSON
    // decoder replaces it. Expected to differ (recorded as a finding).
    call("call-lone-surrogate-expo", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "a\ud800bcdefgh",
    }),
    call("call-nul-expo", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: "abcdefg\u0000",
    }, {
      check: async ({ seeded }) => {
        assert.equal(
          await plaintextOf("call", seeded.userId, digest(ANDROID_DEVICE)),
          JSON.stringify({
            deviceId: ANDROID_DEVICE,
            platform: "android",
            expoToken: "abcdefg\u0000",
          }),
        );
      },
    }),
    call(
      "call-foreign-corrupt-row",
      { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("foreign") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedOtherUser(seeded);
          await addCallDeviceRaw(
            `${seeded.userId}-other`,
            `${seeded.userId}-other-session`,
            digest(IOS_DEVICE),
            "unused",
            null,
            null,
          );
          await system.callPushDevice.update({
            where: { id: digest(IOS_DEVICE) },
            data: { ciphertext: CORRUPT_CIPHERTEXT },
          });
        },
        check: async ({ seeded }) => {
          const read = await sender(seeded.userId);
          assert.equal(read.devices?.[0]?.userId, seeded.userId);
          assert.equal(read.devices?.[0]?.voipToken, VOIP("foreign"));
        },
      },
    ),
    call(
      "call-same-user-corrupt-row",
      { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("corrupt") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDeviceRaw(
            seeded.userId,
            `${seeded.userId}-session`,
            digest(IOS_DEVICE),
            "unused",
            null,
            null,
          );
          await system.callPushDevice.update({
            where: { id: digest(IOS_DEVICE) },
            data: { ciphertext: CORRUPT_CIPHERTEXT },
          });
        },
      },
    ),
    // Same device from another live session: the row moves, nothing is duplicated.
    call(
      "call-same-device-other-session",
      { deviceId: IOS_DEVICE, platform: "ios", expoToken: EXPO("session") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedSecondSession(seeded);
          await addCallDevice(seeded.userId, `${seeded.userId}-session2`, {
            deviceId: IOS_DEVICE,
            platform: "ios",
            voipToken: VOIP("second"),
          });
        },
        check: async ({ seeded }) => {
          const rows = await system.callPushDevice.findMany({
            where: { userId: seeded.userId },
          });
          assert.equal(rows.length, 1);
          assert.equal(rows[0].sessionId, `${seeded.userId}-session`);
          const read = await sender(seeded.userId);
          assert.equal(read.devices?.[0]?.voipToken, VOIP("second"));
          assert.equal(read.devices?.[0]?.expoToken, EXPO("session"));
        },
      },
    ),

    // ---- expired sessions ---------------------------------------------------
    register("register-expired-session-row", { token: "abcdefgh" }, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      },
    }),
    call("call-expired-session-row", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      voipToken: VOIP("expired"),
    }, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      },
    }),
    // The session row expires between authentication and the store's lock only if
    // it is deleted mid-request; the row-expired path here is the reachable one.
    unregister("unregister-expired-session-row", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      },
    }),
    unregister("unregister-session-of-another-account", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedOtherUser(seeded);
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { userId: `${seeded.userId}-other` },
        });
      },
    }),

    // ---- unregister: input shapes, both transports, sessions ----------------
    unregister("unregister-input-number", 5),
    unregister("unregister-input-array", []),
    unregister("unregister-input-null-after-seed", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("gone"),
        });
      },
      check: async ({ seeded }) => {
        const rows = await system.pushRegistration.findMany({ where: { userId: seeded.userId } });
        assert.equal(rows.length, 0);
        const devices = await system.callPushDevice.findMany({ where: { userId: seeded.userId } });
        assert.equal(devices.length, 0);
      },
    }),
    unregister("unregister-both-transports-two-sessions", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedSecondSession(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await addPushToken(seeded.userId, tokenB(seeded), `${seeded.userId}-session2`);
        await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("first"),
        });
        await addCallDevice(seeded.userId, `${seeded.userId}-session2`, {
          deviceId: ANDROID_DEVICE,
          platform: "android",
          expoToken: EXPO("second"),
        });
      },
      check: async ({ seeded }) => {
        const rows = await system.pushRegistration.findMany({ where: { userId: seeded.userId } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sessionId, `${seeded.userId}-session2`);
        const devices = await system.callPushDevice.findMany({ where: { userId: seeded.userId } });
        assert.equal(devices.length, 1);
        assert.equal(devices[0].sessionId, `${seeded.userId}-session2`);
      },
    }),

    // Shared validate.lengthOf coercion: JS compares a non-numeric length via
    // ToPrimitive/ToNumber; Go makes it NaN and then reports both bounds.
    register("register-token-length-string-8", { token: { length: "8" } }),
    register("register-token-length-string-7", { token: { length: "7" } }),
    register("register-token-length-string-600", { token: { length: "600" } }),
    register("register-token-length-array-8", { token: { length: [8] } }),
    call("call-expo-length-string-8", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: { length: "8" },
    }),

    // A call device bound to the expired session: TS's afterDeleteSession removes it,
    // Go's auth leaves it (P2-1, both tables).
    unregister("unregister-expired-session-call-device", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("expired-device"),
        });
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      },
    }),

    // ---- concurrency --------------------------------------------------------
    register("register-concurrent-5", { token: "race-abcdefgh" }, { concurrent: 5 }),
    call(
      "call-concurrent-5",
      { deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("race") },
      { concurrent: 5 },
    ),
    unregister("unregister-concurrent-3", undefined, {
      concurrent: 3,
      seed: async (seeded) => {
        await clearPush(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("race"),
        });
      },
    }),
    // The same token arriving for two accounts at once: exactly one row survives.
    register("register-two-accounts-same-token", { token: "shared-review-token" }, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedOtherUser(seeded);
        await addPushToken(
          `${seeded.userId}-other`,
          "shared-review-token",
          `${seeded.userId}-other-session`,
        );
      },
    }),
  ];
}
