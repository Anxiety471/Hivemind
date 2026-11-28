/**
 * Lane M vault cases: vault.put, vault.reveal and vault.remove, with the seed rows and the
 * database and audit evidence each one must leave behind.
 */
import { contentEncryptionOf } from "../../../packages/db/src/index.js";
import type { System } from "./contract-m-secrets-helpers.mts";
import type { Case } from "./contract.mts";
import { laneMHelpers } from "./contract-m-secrets-helpers.mts";

export function laneMVaultCases(system: System): Case[] {
  const {
    addVault,
    addBot,
    addOverride,
    makeGuest,
    confirm,
    login,
    command,
    validKey,
    put,
    remove,
    reveal,
    destination,
  } = laneMHelpers(system);
  return [
    // ---- vault.put: the six auth kinds ---------------------------------------------------
    put(
      "vput-bearer-create",
      { destination: destination({ name: undefined }), value: "token-value" },
      { declines: false, after: [{ procedure: "vault.list", input: {} }] },
    ),
    put("vput-bearer-named", { destination: destination(), value: "token-value" }),
    put("vput-header", {
      destination: destination({ auth: { type: "header", name: "X-Api-Key" } }),
      value: "header-value",
    }),
    put("vput-basic", {
      destination: destination({ auth: { type: "basic", username: "alice" } }),
      value: "basic-value",
    }),
    put(
      "vput-login",
      {
        destination: destination({
          name: "login-example",
          origin: "https://login.example.test/signin?next=%2Fapp",
          auth: { type: "login" },
        }),
        value: login(
          [
            { label: "  User  ", value: "  alice  ", hidden: false },
            { label: "Password", value: "p@ss word", hidden: true },
            { label: "Account", value: "42", hidden: false },
          ],
          validKey,
        ),
        title: "  My login  ",
        note: "For travel",
        policy: "ask",
        allBots: true,
        alsoOn: ["https://other.example.test", "https://third.example.test"],
      },
      { after: [{ procedure: "vault.list", input: { scope: "account" } }] },
    ),
    put("vput-login-legacy", {
      destination: destination({ name: "legacy-login", origin: "https://legacy.example.test", auth: { type: "login" } }),
      value: JSON.stringify({ username: "  old user  ", password: "old-password" }),
    }),
    put("vput-login-otp-empty", {
      destination: destination({ name: "otp-empty", origin: "https://otp.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u", hidden: false }], ""),
    }),
    put("vput-login-otp-invalid", {
      destination: destination({ name: "otp-bad", origin: "https://otp.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u", hidden: false }], "123456"),
    }),
    put("vput-login-duplicate-label", {
      destination: destination({ name: "dup-label", origin: "https://dup.example.test", auth: { type: "login" } }),
      value: login([
        { label: "User", value: "a", hidden: false },
        { label: " user ", value: "b", hidden: false },
      ]),
    }),
    put("vput-login-hidden-empty", {
      destination: destination({ name: "hidden-empty", origin: "https://hidden.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "", hidden: false }]),
    }),
    put("vput-login-not-json", {
      destination: destination({ name: "not-json", origin: "https://json.example.test", auth: { type: "login" } }),
      value: "plain",
    }),
    put("vput-card", {
      destination: destination({
        name: "card",
        origin: "",
        auth: { type: "card" },
      }),
      value: JSON.stringify({
        number: "4242 4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
        cvc: "123",
        name: "  Alice  ",
        billing: "berlin-card",
      }),
      title: "Travel card",
      botIds: [],
    }),
    put("vput-card-luhn", {
      destination: destination({ name: "card-bad", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242 4242 4242 4241", expMonth: 4, expYear: 2031 }),
    }),
    put("vput-card-extra-key", {
      destination: destination({ name: "card-extra", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242424242424242", expMonth: 4, expYear: 2031, cvv: "123" }),
    }),
    put("vput-card-month", {
      destination: destination({ name: "card-month", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242424242424242", expMonth: 13, expYear: 2031 }),
    }),
    put("vput-contact", {
      destination: destination({ name: "contact", origin: "", auth: { type: "contact" } }),
      value: JSON.stringify({
        name: "  Alice Example  ",
        line1: " Main 1 ",
        line2: "",
        city: "Berlin",
        region: "BE",
        postalCode: "10115",
        country: "DE",
        phone: " +1 555 0100 ",
        email: "alice@example.test",
      }),
      title: "My contact",
    }),
    put("vput-contact-empty", {
      destination: destination({ name: "contact-empty", origin: "", auth: { type: "contact" } }),
      value: JSON.stringify({ name: "", email: "  ", city: "" }),
    }),
    put("vput-command", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "s3cret-value",
    }),
    put("vput-command-with-origin", {
      destination: destination({ name: "deploy-key", origin: "https://example.test", auth: { type: "command" } }),
      value: "s3cret-value",
    }),
    put("vput-command-nul", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "bad\u0000value",
    }),
    put("vput-command-surrogate", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "bad\ud800value",
    }),
    put("vput-page-url", {
      destination: destination({ name: "page", origin: "https://www.example.test:8443/path?a=1#x" }),
      value: "token-value",
    }),
    put("vput-page-url-userinfo", {
      destination: destination({ name: "page", origin: "https://user:pass@example.test/path" }),
      value: "token-value",
    }),
    put("vput-bearer-trimmed-header", {
      destination: destination({ name: "trimmed", origin: "https://example.test", auth: { type: "header", name: "Authorization" } }),
      value: " value",
    }),

    // ---- vault.put: the vault it lands in ------------------------------------------------
    put(
      "vput-space-no-override",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      { declines: false },
    ),
    put(
      "vput-space-override",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded), after: [{ procedure: "vault.list", input: {} }] },
    ),
    put(
      "vput-space-key",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          // A Space vault's own content key: the write must seal under it, naming the Space.
          contentEncryptionOf(system)!.ring.forget(`vault:${seeded.spaces[0]}`);
          await contentEncryptionOf(system)!.ring.current(`vault:${seeded.spaces[0]}`);
        },
      },
    ),
    put(
      "vput-account-with-override",
      { scope: "account", destination: destination({ name: "account-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded) },
    ),
    put(
      "vput-default-with-override",
      { destination: destination({ name: "default-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded) },
    ),
    put("vput-user-key", { destination: destination({ name: "user-key" }), value: "token-value" }, {
      seed: async (seeded) => {
        contentEncryptionOf(system)!.ring.forget(`user:${seeded.userId}`);
        await contentEncryptionOf(system)!.ring.current(`user:${seeded.userId}`);
      },
    }),

    // ---- vault.put: labels, overwrite and relabel ---------------------------------------
    put(
      "vput-relabel-title-note",
      { destination: destination({ name: "saved" }), title: "  New title ", note: "New note" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "token-value" }) },
    ),
    put(
      "vput-relabel-policy",
      { destination: destination({ name: "saved" }), policy: "off" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "token-value" }) },
    ),
    put(
      "vput-relabel-alsoOn",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        alsoOn: ["https://one.example.test", "https://two.example.test"],
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }]),
            title: "Kept",
            policy: "ask",
            alsoOn: ["https://old.example.test"],
          }),
      },
    ),
    put(
      "vput-relabel-missing",
      { destination: destination({ name: "absent" }), title: "New title" },
      { declines: false },
    ),
    put("vput-relabel-no-name", { destination: destination({ name: undefined }), title: "New title" }),
    put(
      "vput-relabel-guest",
      { destination: destination({ name: "saved" }), title: "New title" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "token-value" });
          await makeGuest(seeded);
        },
      },
    ),
    put(
      "vput-overwrite-keeps-otp",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        value: login([{ label: "User", value: "u" }, { label: "Password", value: "p", hidden: true }]),
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }], validKey),
          }),
      },
    ),
    put(
      "vput-overwrite-clears-otp",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        value: login([{ label: "User", value: "u", hidden: false }], ""),
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }], validKey),
          }),
      },
    ),
    put(
      "vput-overwrite-same-destination",
      { destination: destination({ name: "saved" }), value: "new-value" },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            plaintext: "old-value",
            title: "Kept",
            note: "Kept note",
            policy: "ask",
            allBots: true,
            botIds: ["unused"],
          }),
      },
    ),
    put(
      "vput-overwrite-title-kept",
      { destination: destination({ name: "saved" }), value: "new-value" },
      {
        seed: (seeded) =>
          addVault(seeded, { name: "saved", plaintext: "old-value", title: "Kept", note: "Kept note" }),
      },
    ),
    put(
      "vput-destination-change",
      { destination: destination({ name: "saved", origin: "https://elsewhere.example.test" }), value: "new-value" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "old-value" }) },
    ),
    put(
      "vput-bot-ids",
      {
        destination: destination({ name: "saved" }),
        value: "new-value",
        botIds: ["__bot__", "__ba__", "__ba__"],
      },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addBot(seeded, "ba");
          await addVault(seeded, { name: "saved", plaintext: "old-value" });
        },
      },
    ),
    put(
      "vput-all-bots",
      { destination: destination({ name: "saved" }), value: "new-value", allBots: true },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addVault(seeded, {
            name: "saved",
            plaintext: "old-value",
            botIds: ["__bot__"],
            allBots: false,
          });
        },
      },
    ),
    put(
      "vput-bot-ids-unknown",
      { destination: destination({ name: "saved" }), value: "new-value", botIds: ["missing"] },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "old-value" }) },
    ),
    put(
      "vput-limit",
      { destination: destination({ name: "new-item" }), value: "token-value" },
      {
        seed: async (seeded) => {
          for (let index = 0; index < 100; index += 1)
            await addVault(seeded, {
              name: `item-${String(index).padStart(3, "0")}`,
              plaintext: "value",
              rowId: `${seeded.userId}-limit-${index}`,
            });
        },
      },
    ),
    put(
      "vput-new-item-name-taken",
      { destination: destination({ name: undefined }), value: "token-value", title: "Example" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "example", plaintext: "value" });
          await addVault(seeded, { name: "example-2", plaintext: "value" });
        },
      },
    ),
    put(
      "vput-new-item-untitled",
      { destination: destination({ name: undefined, origin: "https://www.untitled.example.test" }), value: "token-value" },
    ),
    put("vput-new-item-title-slug", {
      destination: destination({ name: undefined, origin: "" , auth: { type: "card" } }),
      value: JSON.stringify({
        number: "5555 5555 5555 4444",
        expMonth: 1,
        expYear: 2032,
        name: "",
      }),
      title: "  Café  Card!!  ",
    }),

    // ---- vault.put: validation shapes ---------------------------------------------------
    put("vput-invalid-missing-destination", { value: "x" }),
    put("vput-invalid-destination-null", { destination: null, value: "x" }),
    put("vput-invalid-destination-string", { destination: "https://example.test", value: "x" }),
    put("vput-invalid-auth-discriminator", { destination: destination({ auth: { type: "bogus" } }), value: "x" }),
    put("vput-invalid-auth-missing", { destination: destination({ auth: {} }), value: "x" }),
    put("vput-invalid-name-regex", { destination: destination({ name: "Bad Name" }), value: "x" }),
    put("vput-invalid-name-long", { destination: destination({ name: `a${"b".repeat(64)}` }), value: "x" }),
    put("vput-invalid-origin-missing", { destination: { name: "x", auth: { type: "bearer" } }, value: "x" }),
    put("vput-invalid-origin-http", { destination: destination({ origin: "http://example.test" }), value: "x" }),
    put("vput-invalid-origin-path", { destination: destination({ origin: "https://example.test/path" }), value: "x" }),
    put("vput-invalid-origin-query", { destination: destination({ origin: "https://example.test/?a=1" }), value: "x" }),
    put("vput-invalid-origin-fragment", { destination: destination({ origin: "https://example.test/#a" }), value: "x" }),
    put("vput-invalid-origin-private", { destination: destination({ origin: "http://192.168.0.4" }), value: "x" }),
    put("vput-invalid-login-http", {
      destination: destination({ origin: "http://login.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u" }]),
    }),
    put("vput-invalid-header-no-name", { destination: destination({ auth: { type: "header" } }), value: "x" }),
    put("vput-invalid-header-forbidden", {
      destination: destination({ auth: { type: "header", name: "Host" } }),
      value: "x",
    }),
    put("vput-invalid-basic-no-username", { destination: destination({ auth: { type: "basic" } }), value: "x" }),
    put("vput-invalid-basic-colon", {
      destination: destination({ auth: { type: "basic", username: "a:b" } }),
      value: "x",
    }),
    put("vput-invalid-value-empty", { destination: destination(), value: "" }),
    put("vput-invalid-value-long", { destination: destination(), value: "a".repeat(16385) }),
    put("vput-invalid-value-number", { destination: destination(), value: 5 }),
    put("vput-invalid-title-long", { destination: destination(), value: "x", title: "t".repeat(81) }),
    put("vput-invalid-note-long", { destination: destination(), value: "x", note: "n".repeat(201) }),
    put("vput-invalid-policy", { destination: destination(), value: "x", policy: "never" }),
    put("vput-invalid-botIds-too-many", {
      destination: destination(),
      value: "x",
      botIds: Array.from({ length: 101 }, () => "__bot__"),
    }),
    put("vput-invalid-botIds-type", { destination: destination(), value: "x", botIds: "x" }),
    put("vput-invalid-botIds-empty-id", { destination: destination(), value: "x", botIds: [""] }),
    put("vput-invalid-allBots", { destination: destination(), value: "x", allBots: "yes" }),
    put("vput-invalid-alsoOn-too-many", {
      destination: destination(),
      value: "x",
      alsoOn: Array.from({ length: 11 }, () => "https://a.example.test"),
    }),
    put("vput-invalid-alsoOn-element", {
      destination: destination(),
      value: "x",
      alsoOn: ["https://a.example.test", "a".repeat(2049)],
    }),
    put("vput-invalid-alsoOn-type", { destination: destination(), value: "x", alsoOn: {} }),
    put("vput-invalid-scope", { scope: "org", destination: destination(), value: "x" }),
    put("vput-invalid-scope-null", { scope: null, destination: destination(), value: "x" }),
    put("vput-invalid-input-null", null),
    put("vput-invalid-input-array", []),
    put("vput-invalid-input-undefined", undefined),
    put("vput-extra-keys-ok", { destination: destination(), value: "x", more: 1 }, { declines: false }),

    // ---- vault.put: the redaction gate (differential corpus) ----------------------------
    // Accepted names must reach the audit row byte-identical; every accepted name here is
    // compared there. (Go's gate is conservative, so `ck_` and `sk_` names are refused even when
    // the TypeScript redactor would leave them alone: refusal is always safe, a rewrite is not.)
    ...["abcd", "sken", "api-key", "my_keyv2", "credentials"].map((name) =>
      put(`vput-gate-accept-${name.replace(/[^a-z0-9]/g, "")}`, {
        destination: destination({ name }),
        value: "token-value",
      }, { declines: false }),
    ),
    ...["sk-abc", "sk_9", "my-sk-key", "ak_x", "ck_x"].map((name) =>
      put(`vput-gate-decline-${name.replace(/[^a-z0-9]/gi, "")}`, {
        destination: destination({ name }),
        value: "token-value",
      }, { declines: true }),
    ),

    // ---- vault.reveal -------------------------------------------------------------------
    reveal(
      "vreveal-value",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "opened-value", legacy: true });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-rkz1",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "opened-value" });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-no-confirmation", { name: "saved" }, {
      seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "opened-value" }),
    }),
    reveal(
      "vreveal-login",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login(
              [
                { label: "User", value: "alice" },
                { label: "Password", value: "secret", hidden: true },
              ],
              validKey,
            ),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-login-otp-empty",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "alice" }], ""),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-login-legacy",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: JSON.stringify({ username: "U", password: "P" }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-card",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "",
            auth: { type: "card" },
            plaintext: JSON.stringify({
              number: "4242424242424242",
              expMonth: 4,
              expYear: 2031,
              cvc: "123",
              name: "Alice",
            }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-contact",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "",
            auth: { type: "contact" },
            plaintext: JSON.stringify({ name: "Alice" }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-missing", { name: "absent" }, { seed: (seeded) => confirm(seeded) }),
    reveal(
      "vreveal-space-override",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-space-default",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-space-no-override",
      { scope: "space", name: "saved" },
      { seed: (seeded) => confirm(seeded) },
    ),
    reveal(
      "vreveal-space-key",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-corrupt-login",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: "not a login",
          });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-invalid-name", { name: "" }, { seed: (seeded) => confirm(seeded) }),
    reveal("vreveal-invalid-scope", { scope: "org", name: "saved" }),
    reveal("vreveal-anonymous", { name: "saved" }, { anonymous: true }),

    // ---- vault.remove -------------------------------------------------------------------
    remove(
      "vremove-existing",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "value" });
          await addVault(seeded, { name: "kept", plaintext: "value" });
          await confirm(seeded);
        },
        after: [{ procedure: "vault.list", input: {} }],
      },
    ),
    remove("vremove-absent", { name: "absent" }),
    remove(
      "vremove-space-override",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "value", space: 0 });
          await addVault(seeded, { name: "saved", plaintext: "value" });
        },
      },
    ),
    remove("vremove-space-no-override", { scope: "space", name: "saved" }),
    remove("vremove-gate-sk", { name: "sk-abc" }, { declines: true }),
    remove("vremove-invalid-name", { name: "" }),
    remove("vremove-anonymous", { name: "saved" }, { anonymous: true }),
  ];
}
