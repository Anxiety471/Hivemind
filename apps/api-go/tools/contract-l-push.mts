/**
 * Lane L cases: the notification-registration writes — notifications.registerPush,
 * notifications.registerCallPush and notifications.unregisterPush
 * (apps/api/src/routes/account.ts:494-533 over
 * packages/adapters/src/notifications/push-token-store.ts:48-341).
 *
 * Both tables are sealed with the plain EncryptedSecretStore envelope, bound to a
 * record id (`push-token:<userId>` / `call-push:<deviceDigest>`). Seeds seal with
 * the run's test key through the shipped store, and laneLPushState opens every row
 * on both sides, so a token Go writes must open in TypeScript (and the reverse) and
 * the compared state is the plaintext, never the ciphertext.
 *
 * memory.update and memory.exportMarkdown are NOT here: they already ship on
 * origin (`internal/procedures/memory`) with their own contract cases (`mem-update-*`,
 * `mem-export-*`, including `huge-content`, `unicode-content`,
 * `lone-surrogate-content`, `empty-content` and `mem-export-empty`).
 */
import { createHash } from "node:crypto";
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
const OTHER_DEVICE = "c9f0f895-fb98-4b3a-8a1c-6d7e8f901234";
const VOIP = (seed: string) => createHash("sha256").update(`voip-${seed}`).digest("hex");
const EXPO = (seed: string) => `ExponentPushToken[${seed}]`;

export function laneLPushCases(system: System): Case[] {
  /** The other account a takeover case needs: a second person with a live session. */
  async function seedOtherUser(seeded: Seeded) {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    await system.session.create({
      data: { id: `${other}-session`, expiresAt: later(), token: `${other}-token`, userId: other },
    });
  }

  /** A second signed-in session of the case's own account (a second device). */
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

  /** Every push case starts from empty token tables for its own people. */
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

  async function addCallDevice(userId: string, sessionId: string, registration: CallRegistration) {
    const id = digest(registration.deviceId);
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

  const register = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lpush-${name}`,
    procedure: "notifications.registerPush",
    input,
    seed: clearPush,
    ...extra,
  });
  const call = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lpush-${name}`,
    procedure: "notifications.registerCallPush",
    input,
    seed: clearPush,
    ...extra,
  });
  const unregister = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `lpush-${name}`,
    procedure: "notifications.unregisterPush",
    input,
    seed: clearPush,
    ...extra,
  });
  /** Removes the membership that makes Space 3 foreign to the caller. */
  const foreignSpace = async (seeded: Seeded) => {
    await clearPush(seeded);
    await system.spaceMember.deleteMany({
      where: { spaceId: seeded.spaces[2], userId: seeded.userId },
    });
  };
  const tokenA = (seeded: Seeded) => `a-${seeded.userId}`;
  const tokenB = (seeded: Seeded) => `b-${seeded.userId}`;
  const tokenC = (seeded: Seeded) => `c-${seeded.userId}`;

  return [
    // ---- registerPush: the token store's own state machine -------------------
    register("register-basic", { token: "a-__user__" }),
    register("register-presentation", { token: "a-__user__", presentation: "android_sender" }),
    register("register-space-1", { token: "a-__user__" }, { space: 1 }),
    register(
      "register-same-token-again",
      { token: "a-__user__" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`, "android_sender");
        },
      },
    ),
    register(
      "register-rotates-session-token",
      { token: "b-__user__" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        },
      },
    ),
    register(
      "register-keeps-other-session-rows",
      { token: "c-__user__" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedSecondSession(seeded);
          await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
          await addPushToken(seeded.userId, tokenB(seeded), `${seeded.userId}-session2`);
        },
      },
    ),
    register(
      "register-moves-token-to-calling-session",
      { token: "a-__user__" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedSecondSession(seeded);
          await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session2`);
        },
      },
    ),
    register(
      "register-takes-over-other-users-token",
      { token: "a-__user__" },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedOtherUser(seeded);
          await addPushToken(`${seeded.userId}-other`, tokenA(seeded), `${seeded.userId}-other-session`);
        },
      },
    ),
    register("register-session-expired", { token: "a-__user__" }, {
      // The session row is gone before the request authenticates: both sides answer
      // from the auth layer, the same 401 the store's own check produces.
      seed: async (seeded) => {
        await clearPush(seeded);
        await system.session.deleteMany({ where: { id: `${seeded.userId}-session` } });
      },
    }),
    register("register-session-of-another-account", { token: "a-__user__" }, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedOtherUser(seeded);
        // A session id that belongs to someone else: the store's own user check.
        await system.session.update({
          where: { id: `${seeded.userId}-session` },
          data: { userId: `${seeded.userId}-other` },
        });
      },
    }),
    register("register-anonymous", { token: "a-__user__" }, { anonymous: true }),
    register("register-foreign-space", { token: "a-__user__" }, { space: 2, seed: foreignSpace }),
    register("register-concurrent", { token: "a-__user__" }, { concurrent: 3 }),
    register("register-token-512", { token: "Z".repeat(512) }),
    register("register-token-unicode", { token: "😀😀😀😀😀😀😀😀" }),
    register("register-token-lone-surrogate", { token: "a\ud800bcdefgh" }),
    register("register-token-astral-too-short", { token: "😀😀😀😀" }),
    register("register-token-too-short", { token: "abcdefg" }),
    register("register-token-space", { token: "has space" }),
    register("register-token-trailing-newline", { token: "abcdefgh\n" }),
    register("register-token-nbsp", { token: "abcdefg\u00a0" }),
    register("register-token-too-long", { token: "Z".repeat(513) }),
    register("register-token-number", { token: 42 }),
    register("register-token-null", { token: null }),
    register("register-token-array", { token: ["aaaaaaaa"] }),
    register("register-token-missing", {}),
    register("register-presentation-invalid", { token: "a-__user__", presentation: "nope" }),
    register("register-presentation-null", { token: "a-__user__", presentation: null }),
    register("register-no-input", undefined),
    register("register-array-input", []),
    register("register-null-input", null),

    // ---- registerCallPush: merge, takeover, locks and tokens ----------------
    call("call-ios-voip", { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("a") }),
    call("call-android-expo", {
      deviceId: ANDROID_DEVICE,
      platform: "android",
      expoToken: EXPO("android"),
    }),
    call("call-both-tokens", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      expoToken: EXPO("both"),
      voipToken: VOIP("b"),
    }),
    call("call-nil-uuid", {
      deviceId: "00000000-0000-0000-0000-000000000000",
      platform: "android",
      expoToken: EXPO("nil"),
    }),
    call("call-uppercase-uuid", {
      deviceId: "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF",
      platform: "android",
      expoToken: EXPO("upper"),
    }),
    call(
      "call-merge-keeps-voip",
      { deviceId: IOS_DEVICE, platform: "ios", expoToken: EXPO("merged") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
            deviceId: IOS_DEVICE,
            platform: "ios",
            voipToken: VOIP("c"),
          });
        },
      },
    ),
    call(
      "call-merge-replaces-expo",
      { deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("new") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
            deviceId: ANDROID_DEVICE,
            platform: "android",
            expoToken: EXPO("old"),
          });
        },
      },
    ),
    call(
      "call-takes-over-other-users-device",
      { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("d") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedOtherUser(seeded);
          await addCallDevice(`${seeded.userId}-other`, `${seeded.userId}-other-session`, {
            deviceId: IOS_DEVICE,
            platform: "ios",
            voipToken: VOIP("d"),
          });
        },
      },
    ),
    call(
      "call-device-handover-by-token",
      { deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("handover") },
      {
        seed: async (seeded) => {
          await clearPush(seeded);
          await seedOtherUser(seeded);
          await addCallDevice(`${seeded.userId}-other`, `${seeded.userId}-other-session`, {
            deviceId: OTHER_DEVICE,
            platform: "android",
            expoToken: EXPO("handover"),
          });
        },
      },
    ),
    call("call-concurrent", { deviceId: ANDROID_DEVICE, platform: "android", expoToken: EXPO("race") }, {
      concurrent: 3,
    }),
    call("call-anonymous", { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("e") }, {
      anonymous: true,
    }),
    call("call-foreign-space", { deviceId: IOS_DEVICE, platform: "ios", voipToken: VOIP("f") }, {
      space: 2,
      seed: foreignSpace,
    }),
    call("call-no-tokens", { deviceId: IOS_DEVICE, platform: "android" }),
    call("call-android-voip-only", {
      deviceId: IOS_DEVICE,
      platform: "android",
      voipToken: VOIP("g"),
    }),
    call("call-uuid-invalid", { deviceId: "x", platform: "android" }),
    call("call-uuid-v9", {
      deviceId: "123e4567-e89b-92d3-a456-426614174000",
      platform: "android",
      expoToken: EXPO("v9"),
    }),
    call("call-uuid-variant", {
      deviceId: "123e4567-e89b-12d3-c456-426614174000",
      platform: "android",
      expoToken: EXPO("variant"),
    }),
    call("call-uuid-and-voip-and-refine", {
      deviceId: "x",
      platform: "android",
      voipToken: "nothex",
    }),
    call("call-platform-invalid", {
      deviceId: IOS_DEVICE,
      platform: "iOS",
      expoToken: EXPO("platform"),
    }),
    call("call-expo-short", { deviceId: IOS_DEVICE, platform: "android", expoToken: "short" }),
    call("call-expo-space", {
      deviceId: IOS_DEVICE,
      platform: "android",
      expoToken: "has space",
    }),
    call("call-expo-unicode", {
      deviceId: IOS_DEVICE,
      platform: "android",
      expoToken: "Exponent😀Push",
    }),
    call("call-voip-short", { deviceId: IOS_DEVICE, platform: "ios", voipToken: "a".repeat(63) }),
    call("call-voip-newline", {
      deviceId: IOS_DEVICE,
      platform: "ios",
      voipToken: `${"a".repeat(64)}\n`,
    }),
    call("call-voip-201", { deviceId: IOS_DEVICE, platform: "ios", voipToken: "a".repeat(201) }),
    call("call-no-input", undefined),
    call("call-number-input", 5),

    // ---- unregisterPush: the calling session only ---------------------------
    unregister("unregister-both-transports", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedSecondSession(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await addPushToken(seeded.userId, tokenB(seeded), `${seeded.userId}-session2`);
        await addCallDevice(seeded.userId, `${seeded.userId}-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("h"),
        });
        await addCallDevice(seeded.userId, `${seeded.userId}-session2`, {
          deviceId: ANDROID_DEVICE,
          platform: "android",
          expoToken: EXPO("other-session"),
        });
      },
    }),
    unregister("unregister-leaves-other-accounts", undefined, {
      seed: async (seeded) => {
        await clearPush(seeded);
        await seedOtherUser(seeded);
        await addPushToken(seeded.userId, tokenA(seeded), `${seeded.userId}-session`);
        await addPushToken(`${seeded.userId}-other`, tokenB(seeded), `${seeded.userId}-other-session`);
        await addCallDevice(`${seeded.userId}-other`, `${seeded.userId}-other-session`, {
          deviceId: IOS_DEVICE,
          platform: "ios",
          voipToken: VOIP("i"),
        });
      },
    }),
    unregister("unregister-unknown", undefined),
    unregister("unregister-with-body", { token: "ignored" }),
    unregister("unregister-anonymous", undefined, { anonymous: true }),
    unregister("unregister-foreign-space", undefined, { space: 2, seed: foreignSpace }),
  ];
}

/**
 * Opens every lane row on both sides so the state comparison sees the plaintext.
 * `updatedAt` is each side's own clock, so only its presence is compared.
 */
export async function laneLPushState(system: System, seeded: Seeded) {
  const owners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const tokenRows = await system.pushRegistration.findMany({
    where: { userId: owners },
    select: {
      userId: true,
      tokenDigest: true,
      sessionId: true,
      presentation: true,
      ciphertext: true,
      updatedAt: true,
    },
    orderBy: [{ userId: "asc" }, { tokenDigest: "asc" }],
  });
  const tokens = [];
  for (const row of tokenRows) {
    const value = await store.load(row.ciphertext, `push-token:${row.userId}`).then(
      (plaintext: string) => ({ plaintext }),
      (error: Error) => ({ error: error.message }),
    );
    tokens.push({
      userId: row.userId,
      tokenDigest: row.tokenDigest,
      sessionId: row.sessionId,
      presentation: row.presentation,
      updatedAt: row.updatedAt ? "<set>" : null,
      ...value,
    });
  }
  const deviceRows = await system.callPushDevice.findMany({
    where: { userId: owners },
    select: {
      id: true,
      userId: true,
      sessionId: true,
      expoTokenDigest: true,
      voipTokenDigest: true,
      ciphertext: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const devices = [];
  for (const row of deviceRows) {
    const value = await store.load(row.ciphertext, `call-push:${row.id}`).then(
      (plaintext: string) => ({ plaintext: JSON.parse(plaintext) as unknown }),
      (error: Error) => ({ error: error.message }),
    );
    devices.push({
      id: row.id,
      userId: row.userId,
      sessionId: row.sessionId,
      expoTokenDigest: row.expoTokenDigest,
      voipTokenDigest: row.voipTokenDigest,
      updatedAt: row.updatedAt ? "<set>" : null,
      ...value,
    });
  }
  return { laneLPush: { tokens, devices } };
}
