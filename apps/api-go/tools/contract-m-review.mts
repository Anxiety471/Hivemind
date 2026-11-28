/**
 * Lane M review: adversarial cases written by the independent reviewer. They are not part of the
 * lane; each one probes a parity or security edge the lane's own 151 cases do not cover.
 */
import assert from "node:assert/strict";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { contentEncryptionOf, encryptText } from "../../../packages/db/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 3, 2));
const legacyStore = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
const sealContext = {
  operationId: "seed",
  traceId: "seed",
  userId: "seed",
  spaceId: "seed",
  signal: new AbortController().signal,
} as never;
const v2 = async (recordId: string, plaintext: string) =>
  (await legacyStore.put(plaintext, sealContext, { recordId })).ciphertext;

// Identity confirmation has one nominal answer: deny. Assert it per side, not only through the
// Go/TS comparison, because TypeScript's own race can answer 200 on the same attempt a Go-200
// regression does; the two would then compare equal and pass with no retry. A check failure is
// an AssertionError, so the declared ts 200 / go 403 retry still covers TypeScript's race while
// Go 200 fails on the first attempt whatever TypeScript answers.
const denyIdentityConfirmation: NonNullable<Case["check"]> = ({ result, side }) =>
  assert.equal(result.status, 403, `${side}: identity confirmation must deny`);

export function laneMReviewCases(system: System): Case[] {
  const put = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.put",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const remove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.remove",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const reveal = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.reveal",
    input,
    ...extra,
  });
  const agentRemove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "agentSecrets.remove",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const addBot = (seeded: Seeded, id: string, extra: Record<string, unknown> = {}) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });
  const addOverride = (seeded: Seeded, space: 0 | 1 | 2 = 0) =>
    system.spaceSettingOverride.create({
      data: {
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        setting: "credentials",
        createdAt: OLD,
      },
    });
  const addVault = async (
    seeded: Seeded,
    seed: {
      name: string;
      origin?: string;
      auth?: Record<string, unknown>;
      plaintext: string;
      space?: 0 | 1 | 2 | null;
      title?: string;
      alsoOn?: string[];
      rowId?: string;
      legacy?: boolean;
    },
  ) => {
    const id = seed.rowId ?? `${seeded.userId}-rv-${seed.name}`;
    const spaceId = seed.space === null || seed.space === undefined ? null : seeded.spaces[seed.space];
    const scope = seed.space === null || seed.space === undefined ? `user:${seeded.userId}` : `vault:${seeded.spaces[seed.space]}`;
    let ciphertext: string;
    if (seed.legacy) {
      ciphertext = await v2(id, seed.plaintext);
    } else {
      const ring = contentEncryptionOf(system)!.ring;
      ring.forget(scope);
      const key = await ring.current(scope);
      ciphertext = encryptText(
        key,
        { table: "vault_credentials", column: "ciphertext", rowId: id, owner: seeded.userId },
        seed.plaintext,
      );
    }
    return system.vaultCredential.create({
      data: {
        id,
        userId: seeded.userId,
        spaceId,
        name: seed.name,
        origin: seed.origin ?? "https://example.test",
        auth: seed.auth ?? { type: "bearer" },
        title: seed.title ?? "",
        note: "",
        policy: "allow",
        alsoOn: seed.alsoOn ?? [],
        ciphertext,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
  };
  const login = (fields: unknown[], otp?: unknown) =>
    JSON.stringify(otp === undefined ? { fields } : { fields, otp });
  const destination = (extra: Record<string, unknown> = {}) => ({
    name: "mrev-item",
    origin: "https://example.test",
    auth: { type: "bearer" },
    ...extra,
  });
  const confirm = (seeded: Seeded) =>
    system.verification.create({
      data: {
        id: `${seeded.userId}-confirmation`,
        identifier: `identity-confirmed-${seeded.userId}-session`,
        value: seeded.userId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

  return [
    // A login's other sites: TypeScript normalizes each to an origin, dedupes, and drops its own
    // site. Go validates them but stores the raw request strings.
    put("mrev-alsoOn-normalize", {
      destination: destination({
        name: "mrev-login",
        origin: "https://login.example.test",
        auth: { type: "login" },
      }),
      value: login([{ label: "User", value: "u", hidden: false }]),
      alsoOn: [
        "https://other.example.test",
        "https://other.example.test",
        " HTTPS://Third.Example.Test ",
        "https://login.example.test",
      ],
      after: [{ procedure: "vault.list", input: {} }],
    }),
    put(
      "mrev-alsoOn-relabel-own-site",
      {
        destination: destination({
          name: "mrev-login",
          origin: "https://login.example.test",
          auth: { type: "login" },
        }),
        alsoOn: ["https://login.example.test"],
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "mrev-login",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }]),
            alsoOn: ["https://other.example.test"],
          }),
      },
    ),

    // Card values: billing is not trimmed and is BotSecretName or absent; a card number drops all
    // whitespace, not only spaces and hyphens.
    put("mrev-card-billing-empty", {
      destination: destination({ name: "mrev-card", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({
        number: "4242 4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
        billing: "",
      }),
    }),
    put("mrev-card-billing-spaces", {
      destination: destination({ name: "mrev-card", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({
        number: "4242 4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
        billing: " home ",
      }),
    }),
    put("mrev-card-number-tab", {
      destination: destination({ name: "mrev-card", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({
        number: "4242\t4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
      }),
    }),

    // `otp: null` is an invalid authenticator key in TypeScript, not an absent one.
    put("mrev-login-otp-null", {
      destination: destination({
        name: "mrev-login",
        origin: "https://login.example.test",
        auth: { type: "login" },
      }),
      value: JSON.stringify({
        fields: [{ label: "User", value: "u", hidden: false }],
        otp: null,
      }),
    }),

    // A basic username's two checks both report.
    put("mrev-basic-empty-username", {
      destination: destination({ name: "mrev-basic", auth: { type: "basic", username: "" } }),
      value: "x",
    }),

    // Every top-level field is validated, whatever an earlier one did.
    put("mrev-multi-field-invalid", {
      destination: null,
      value: "",
      title: "t".repeat(81),
    }),

    // Relabelling a row whose stored destination no longer parses: only the labels change.
    put(
      "mrev-relabel-invalid-auth",
      {
        destination: {
          name: "mrev-legacy",
          origin: "https://example.test",
          auth: { type: "bearer" },
        },
        title: "New title",
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "mrev-legacy",
            origin: "https://example.test",
            auth: { type: "header" },
            plaintext: "value",
          }),
      },
    ),

    // A Space that keeps its own vault: limiting an account-vault item to this Space's bots is
    // refused by TypeScript, because those bots do not read that vault.
    put(
      "mrev-account-botIds-override",
      {
        scope: "account",
        destination: destination({ name: "mrev-acct" }),
        value: "value",
        botIds: ["__bot__"],
      },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addOverride(seeded);
        },
      },
    ),
    put(
      "mrev-account-botIds-no-override",
      {
        scope: "account",
        destination: destination({ name: "mrev-acct" }),
        value: "value",
        botIds: ["__bot__"],
      },
      { seed: (seeded) => addBot(seeded, "bot") },
    ),
    put(
      "mrev-space-relabel-not-in-use",
      { scope: "space", destination: destination({ name: "mrev-acct" }), title: "New" },
      { seed: (seeded) => addVault(seeded, { name: "mrev-acct", plaintext: "value" }) },
    ),

    // The limit: 100 items is full, 99 is not.
    put(
      "mrev-limit-99",
      { destination: destination({ name: "mrev-99" }), value: "value" },
      {
        seed: async (seeded) => {
          for (let index = 0; index < 99; index += 1)
            await addVault(seeded, {
              name: `mrev-${String(index).padStart(3, "0")}`,
              plaintext: "value",
              rowId: `${seeded.userId}-rv-limit-${index}`,
            });
        },
      },
    ),
    put(
      "mrev-limit-full",
      { destination: destination({ name: "mrev-100" }), value: "value" },
      {
        seed: async (seeded) => {
          for (let index = 0; index < 100; index += 1)
            await addVault(seeded, {
              name: `mrev-${String(index).padStart(3, "0")}`,
              plaintext: "value",
              rowId: `${seeded.userId}-rv-full-${index}`,
            });
        },
      },
    ),

    // zod validates every property of a nested object, not only the first bad one.
    put("mrev-nested-dest-aggregation", {
      destination: { name: null, origin: 5, auth: null },
      value: "value",
    }),
    put("mrev-dest-auth-aggregation", {
      destination: { name: "mrev-nested", origin: 5, auth: null },
      value: "value",
    }),

    // Optional card/contact fields: null is an invalid_type, not "absent".
    put("mrev-card-billing-null", {
      destination: destination({ name: "mrev-card", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({
        number: "4242 4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
        billing: null,
      }),
    }),
    put("mrev-contact-null", {
      destination: destination({ name: "mrev-contact", origin: "", auth: { type: "contact" } }),
      value: JSON.stringify({ name: null, city: "Paris" }),
    }),
    put("mrev-card-number-nbsp", {
      destination: destination({ name: "mrev-card", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({
        number: "4242\u00a04242 4242 4242",
        expMonth: 4,
        expYear: 2031,
      }),
    }),

    // A login saved with an explicitly empty key keeps the empty key in TypeScript.
    put(
      "mrev-login-otp-empty-reveal",
      {
        destination: destination({
          name: "mrev-empty-otp",
          origin: "https://login.example.test",
          auth: { type: "login" },
        }),
        value: JSON.stringify({
          fields: [{ label: "User", value: "u", hidden: false }],
          otp: "",
        }),
      },
      {
        seed: confirm,
        after: [{ procedure: "vault.reveal", input: { name: "mrev-empty-otp" } }],
      },
    ),

    // A damaged stored auth still answers policy "ask" and non-empty alsoOn as TypeScript does.
    put(
      "mrev-relabel-unreadable-policy",
      {
        destination: destination({ name: "mrev-legacy", origin: "https://example.test" }),
        policy: "ask",
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "mrev-legacy",
            origin: "https://example.test",
            auth: { type: "header" },
            plaintext: "value",
          }),
      },
    ),

    // Another person's account-vault item is not this caller's.
    reveal(
      "mrev-reveal-foreign",
      { name: "mrev-foreign" },
      {
        seed: async (seeded) => {
          const other = `${seeded.userId}-other`;
          await system.user.create({
            data: {
              id: other,
              name: "Other",
              email: `${other}@example.test`,
              emailVerified: true,
              createdAt: OLD,
              updatedAt: OLD,
            },
          });
          const id = `${other}-rv-foreign`;
          const ring = contentEncryptionOf(system)!.ring;
          ring.forget(`user:${other}`);
          const key = await ring.current(`user:${other}`);
          const ciphertext = encryptText(
            key,
            { table: "vault_credentials", column: "ciphertext", rowId: id, owner: other },
            "not-yours",
          );
          await system.vaultCredential.create({
            data: {
              id,
              userId: other,
              spaceId: null,
              name: "mrev-foreign",
              origin: "https://example.test",
              auth: { type: "bearer" },
              title: "",
              note: "",
              policy: "allow",
              alsoOn: [],
              ciphertext,
              createdAt: OLD,
              updatedAt: OLD,
            },
          });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-review-confirmation`,
              identifier: `identity-confirmed-${seeded.userId}-session`,
              value: seeded.userId,
              expiresAt: new Date(Date.now() + 5 * 60_000),
            },
          });
        },
      },
    ),
    agentRemove(
      "mrev-remove-other-space",
      { id: "mrev-deploy" },
      {
        space: 2,
        seed: (seeded) =>
          addVault(seeded, {
            name: "mrev-deploy",
            origin: "",
            auth: { type: "command" },
            plaintext: "value",
            space: 0,
          }),
      },
    ),

    // Unicode, NUL and lone surrogates in names and values.
    put("mrev-login-unicode", {
      destination: destination({
        name: "mrev-unicode",
        origin: "https://login.example.test",
        auth: { type: "login" },
      }),
      value: JSON.stringify({
        fields: [
          { label: "Ünïcode 🙂", value: "  Åsa  Öberg  ", hidden: false },
          { label: "Password", value: "p\u0000w\ud800d", hidden: true },
        ],
        otp: "",
      }),
    }),
    // The gate declines these (NUL and a lone surrogate are outside its alphabet), so the
    // gateway answers them from TypeScript; `declines` asserts the hand-off.
    remove("mrev-remove-name-nul", { name: "a\u0000b" }, { declines: true }),
    agentRemove("mrev-remove-id-surrogate", { id: "a\ud800b" }, { declines: true }),
    // A surrogate in a name fails the name pattern on both sides, so the answer is the same 400
    // and no audited value is written; the gate is not reached and the case must not decline.
    put("mrev-name-surrogate", {
      destination: destination({ name: "mrev\ud800name" }),
      value: "value",
    }),

    // Crypto interop: each side opens the other's sealed value, in both envelope forms.
    reveal(
      "mrev-v2-go-reveals-ts",
      { name: "mrev-v2" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "mrev-v2", plaintext: "v2-value", legacy: true });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "mrev-rkz1-go-reveals-ts",
      { name: "mrev-rkz1" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "mrev-rkz1", plaintext: "rkz1-value" });
          await confirm(seeded);
        },
      },
    ),
    put(
      "mrev-v2-ts-reveals-go",
      {
        destination: destination({
          name: "mrev-v2-new",
          origin: "https://login.example.test",
          auth: { type: "login" },
        }),
        value: login([{ label: "User", value: "u", hidden: false }]),
      },
      {
        seed: confirm,
        after: [{ procedure: "vault.reveal", input: { name: "mrev-v2-new" } }],
      },
    ),
    put(
      "mrev-rkz1-ts-reveals-go",
      {
        destination: destination({
          name: "mrev-rkz1-new",
          origin: "https://login.example.test",
          auth: { type: "login" },
        }),
        value: login([{ label: "User", value: "u", hidden: false }]),
      },
      {
        seed: async (seeded) => {
          // A key for the account vault makes the new item seal under it (rkz1).
          await addVault(seeded, { name: "mrev-rkz1-key", plaintext: "key-holder" });
          await confirm(seeded);
        },
        after: [{ procedure: "vault.reveal", input: { name: "mrev-rkz1-new" } }],
      },
    ),

    // findVerificationValue reads the newest verification row and then deletes expired ones
    // (better-auth internal-adapter.mjs:789-804), so a newer expired row hides an older valid
    // one and an older expired row never hides a newer valid one.
    reveal(
      "mrev-confirm-newest-valid",
      { name: "mrev-newest" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "mrev-newest", plaintext: "newest-value" });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-confirmation-old`,
              identifier: `identity-confirmed-${seeded.userId}-session`,
              value: seeded.userId,
              createdAt: new Date("2021-01-01T00:00:00.000Z"),
              expiresAt: new Date("2021-01-01T01:00:00.000Z"),
            },
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "mrev-confirm-newest-expired",
      { name: "mrev-newest" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "mrev-newest", plaintext: "newest-value" });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-confirmation-valid`,
              identifier: `identity-confirmed-${seeded.userId}-session`,
              value: seeded.userId,
              createdAt: new Date("2021-01-01T00:00:00.000Z"),
              expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            },
          });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-confirmation-expired`,
              identifier: `identity-confirmed-${seeded.userId}-session`,
              value: seeded.userId,
              createdAt: new Date("2022-01-01T00:00:00.000Z"),
              expiresAt: new Date("2022-01-01T01:00:00.000Z"),
            },
          });
        },
        // TypeScript's gate races itself on this state (identity-confirmation.ts:55-67): its two
        // findVerificationValue calls run under Promise.all, and each one deletes every expired
        // verification row, so one lookup's cleanup can hide the other's newest expired row
        // between the seed and the read. Go reads both proofs before its single cleanup, so a
        // serialized Go request answers 403. Only TypeScript's 200 against Go's 403 is retried;
        // a Go 200 here is the regression the fix removes and fails on the first attempt.
        retries: 2,
        retryReason:
          "TypeScript's two findVerificationValue calls run under Promise.all (identity-confirmation.ts:55-67) and each deletes every expired verification row, so one lookup's cleanup can hide the other's newest expired row before it is read; a serialized Go request reads both proofs first and answers 403.",
        retryWhen: (_error, ts, go) => ts.status === 200 && go.status === 403,
        check: denyIdentityConfirmation,
      },
    ),

    // The fixed ordering itself: the newest oidc-reauth proof is expired and an older one is
    // still valid, with no identity-confirmed row at all. The old Go read and cleaned one
    // identifier at a time, so the absent first identifier's global cleanup deleted the newer
    // expired oidc row before the oidc read, exposing the older valid proof (200). Go now reads
    // both proofs before the single cleanup, so the newest oidc proof is the expired one (403).
    reveal(
      "mrev-confirm-oidc-older-valid",
      { name: "mrev-oidc" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "mrev-oidc", plaintext: "oidc-value" });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-oidc-valid`,
              identifier: `oidc-reauth-${seeded.userId}-session`,
              value: seeded.userId,
              createdAt: new Date("2021-01-01T00:00:00.000Z"),
              expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            },
          });
          await system.verification.create({
            data: {
              id: `${seeded.userId}-oidc-expired`,
              identifier: `oidc-reauth-${seeded.userId}-session`,
              value: seeded.userId,
              createdAt: new Date("2022-01-01T00:00:00.000Z"),
              expiresAt: new Date("2022-01-01T01:00:00.000Z"),
            },
          });
        },
        retries: 2,
        retryReason:
          "TypeScript's two findVerificationValue calls run under Promise.all (identity-confirmation.ts:55-67) and each deletes every expired verification row, so the identity-confirmed lookup's cleanup can delete the newer expired oidc-reauth row before the oidc lookup reads it and expose the older valid row; a serialized Go request reads both proofs first and answers 403.",
        retryWhen: (_error, ts, go) => ts.status === 200 && go.status === 403,
        check: denyIdentityConfirmation,
      },
    ),
    {
      // The same state on the other guarded entry point: the webhook reveal applies the identity
      // confirmation before reading the secret, so the fixed ordering must deny there too.
      name: "mrev-confirm-oidc-older-valid-webhook",
      procedure: "bots.revealWebhookSecret",
      input: { botId: "__s-mrevwh__" },
      seed: async (seeded) => {
        const secretId = `${seeded.userId}-mrev-wh-secret`;
        await system.secret.create({
          data: {
            id: secretId,
            userId: seeded.userId,
            spaceId: seeded.spaces[0],
            kind: "webhook",
            ciphertext: await v2(secretId, "oidc-webhook-value"),
          },
        });
        await addBot(seeded, "mrevwh", { webhookSecretId: secretId });
        await system.verification.create({
          data: {
            id: `${seeded.userId}-wh-oidc-valid`,
            identifier: `oidc-reauth-${seeded.userId}-session`,
            value: seeded.userId,
            createdAt: new Date("2021-01-01T00:00:00.000Z"),
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          },
        });
        await system.verification.create({
          data: {
            id: `${seeded.userId}-wh-oidc-expired`,
            identifier: `oidc-reauth-${seeded.userId}-session`,
            value: seeded.userId,
            createdAt: new Date("2022-01-01T00:00:00.000Z"),
            expiresAt: new Date("2022-01-01T01:00:00.000Z"),
          },
        });
      },
      retries: 2,
      retryReason:
        "TypeScript's two findVerificationValue calls run under Promise.all (identity-confirmation.ts:55-67) and each deletes every expired verification row, so the identity-confirmed lookup's cleanup can delete the newer expired oidc-reauth row before the oidc lookup reads it and expose the older valid row; a serialized Go request reads both proofs first and answers 403.",
      retryWhen: (_error, ts, go) => ts.status === 200 && go.status === 403,
      check: denyIdentityConfirmation,
    },

    // Concurrent identical saves: one row, every call answers, no lost lock or retry loop.
    put(
      "mrev-concurrent-put-same-name",
      { destination: destination({ name: "mrev-race" }), value: "same-value" },
      { concurrent: 6, declines: false },
    ),
    put(
      "mrev-concurrent-create-unnamed",
      { destination: destination({ name: undefined, origin: "https://race.example.test" }), value: "same-value", title: "Race" },
      { concurrent: 3, declines: false },
    ),
  ];
}
