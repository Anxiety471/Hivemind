/**
 * Lane M review: adversarial cases written by the independent reviewer. They are not part of the
 * lane; each one probes a parity or security edge the lane's own 151 cases do not cover.
 */
import { contentEncryptionOf, encryptText } from "../../../packages/db/src/index.js";
import type { Case, Seeded } from "./contract.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 3, 2));

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
  const addBot = (seeded: Seeded, id: string) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: OLD,
        updatedAt: OLD,
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
    },
  ) => {
    const id = seed.rowId ?? `${seeded.userId}-rv-${seed.name}`;
    const spaceId = seed.space === null || seed.space === undefined ? null : seeded.spaces[seed.space];
    const scope = seed.space === null || seed.space === undefined ? `user:${seeded.userId}` : `vault:${seeded.spaces[seed.space]}`;
    const ring = contentEncryptionOf(system)!.ring;
    ring.forget(scope);
    const key = await ring.current(scope);
    const ciphertext = encryptText(
      key,
      { table: "vault_credentials", column: "ciphertext", rowId: id, owner: seeded.userId },
      seed.plaintext,
    );
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

  return [
    // A login's other sites: TypeScript normalizes each to an origin, dedupes, and drops its own
    // site. Go validates them but stores the raw request strings.
    put("mrev-alsoOn-normalize", {
      destination: destination({
        name: "mrev-login",
        origin: "https://login.example.test",
        auth: { type: "login" },
      }),
      value: login([{ label: "User", value: "u" }]),
      alsoOn: [
        "https://other.example.test",
        "https://other.example.test",
        " HTTPS://Third.Example.Test ",
        "https://login.example.test",
      ],
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
