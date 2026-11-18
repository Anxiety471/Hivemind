/**
 * Contract test: sends identical availability requests to the TypeScript API
 * (in-process, against the fixture database) and to the Go gateway, then diffs
 * status, response envelope and the database state each side leaves behind.
 *
 * Run from the deployed checkout, which has node_modules:
 *   cd /home/bocchi/apps/rakazo
 *   set -a; . /home/hitori/go-port/fixture-db/.env; set +a
 *   GO_BINARY=/tmp/rakazo-gateway node_modules/.bin/tsx apps/api-go/tools/contract.mts
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { asSystem } from "../../../packages/db/src/index.js";
import { createApp } from "../../api/src/app.js";
import { spendingPeriodStart } from "../../../packages/core/src/spending.js";
import { createRequire } from "node:module";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const GO_BINARY = process.env.GO_BINARY;
if (!GO_BINARY) throw new Error("GO_BINARY is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const BUILD_ID_FILE = process.env.BUILD_ID_FILE ?? join(process.cwd(), "apps/web/dist/build-id");
const SECRET = "contract-test-secret-0123456789abcdef";
const WEB_ORIGIN = "http://127.0.0.1:5173";
// RUN_TAG separates ids and GO_PORT the listener when another run shares the database and host.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const RUN_TAG = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : "";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const GO_PORT = process.env.GO_PORT ?? "3201";
const GO_URL = `http://127.0.0.1:${GO_PORT}`;

type Seeded = {
  userId: string;
  orgId: string;
  spaces: [string, string, string];
  skillId: string;
  skillName: string;
  serverId: string;
  serverSlug: string;
  installId: string;
  sessionToken: string;
  cookie: string;
  activeSpace?: number;
};

type Case = {
  name: string;
  procedure: string;
  input: unknown;
  /** Extra fixture state for this case. */
  seed?: (seeded: Seeded) => Promise<void>;
  /** Send the request without a session cookie. */
  anonymous?: boolean;
  /** Call repeatedly, feeding each nextCursor back in, and compare every page. */
  paginate?: boolean;
  /** Active Space for the call: an index into the case's three Spaces (default 0). */
  space?: 0 | 1 | 2;
  /** Reads TypeScript makes afterwards, as the web app does; they must read the same state either way. */
  after?: Array<{ procedure: string; input: unknown }>;
};

function cookieFor(token: string) {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

const dataDir = await mkdtemp(join(tmpdir(), "rakazo-contract-"));
const handles = await createApp({
  databaseUrl: DATABASE_URL,
  dataDir,
  authSecret: SECRET,
  encryptionKey: "contract-test-encryption-key-0123456789abcdef",
  screenProxySecret: "contract-test-screen-secret-0123456789abcdef",
  webOrigin: WEB_ORIGIN,
  authUrl: WEB_ORIGIN,
  nodeEnv: "test",
  signupsEnabled: "true",
  agentRuntime: "scripted",
  sandboxProvider: "fake",
  wakeupDriver: "memory",
} as never);
const system = asSystem(handles.prisma);

let go: ChildProcess | undefined;
const routesFile = join(dataDir, "routes.json");
await writeFile(
  routesFile,
  JSON.stringify({
    default: "proxy",
    routes: {
      "availability.items": { mode: "go", readOnly: true },
      "availability.set": { mode: "go" },
      "availability.chooseForSpace": { mode: "go" },
      "trustedLinkSites.list": { mode: "go", readOnly: true },
      "trustedLinkSites.remove": { mode: "go" },
      "spendingLimit.payments": { mode: "go", readOnly: true },
      "spendingLimit.get": { mode: "go", readOnly: true },
      "botSections.list": { mode: "go", readOnly: true },
      "pages.list": { mode: "go", readOnly: true },
      "spendingLimit.set": { mode: "go" },
      "botSections.create": { mode: "go" },
      "botSections.update": { mode: "go" },
      "botSections.remove": { mode: "go" },
      "messaging.link.start": { mode: "go" },
      "messaging.identities.setBot": { mode: "go" },
      "messaging.identities.unlink": { mode: "go" },
      "messaging.channels.list": { mode: "go", readOnly: true },
      "messaging.channels.respond": { mode: "go" },
      "messaging.channels.leave": { mode: "go" },
      "messaging.connections.list": { mode: "go", readOnly: true },
      "messaging.connections.revoke": { mode: "go" },
      "threads.head": { mode: "go", readOnly: true },
      "threads.markRead": { mode: "go" },
      "threads.markUnread": { mode: "go" },
      "threads.snooze": { mode: "go" },
      "externalConversations.updatePolicy": { mode: "go" },
      "scratchpad.list": { mode: "go", readOnly: true },
      "scratchpad.create": { mode: "go" },
      "scratchpad.update": { mode: "go" },
      "scratchpad.remove": { mode: "go" },
      "approvalRules.list": { mode: "go", readOnly: true },
      "approvalRules.set": { mode: "go" },
      "spaceSettings.overrides": { mode: "go", readOnly: true },
      "spaceSettings.setOverride": { mode: "go" },
    },
  }),
);
process.on("uncaughtException", (error) => {
  go?.kill("SIGKILL");
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  go?.kill("SIGKILL");
  console.error(error);
  process.exit(1);
});
go = spawn(
  GO_BINARY,
  [
    "-listen",
    `127.0.0.1:${GO_PORT}`,
    "-upstream",
    "http://127.0.0.1:3999",
    "-routes",
    routesFile,
    "-build-id-file",
    BUILD_ID_FILE,
  ],
  {
    env: {
      ...process.env,
      DATABASE_URL,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: WEB_ORIGIN,
      WEB_ORIGIN,
      MAX_UPLOAD_SIZE_MB: "10",
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`${GO_URL}/healthz`);
    if (response.ok) break;
  } catch {
    // still starting
  }
  if (attempt === 99) throw new Error("go gateway did not start");
  await sleep(50);
}

// A listener on the realtime channel: TypeScript and Go must publish identical signals.
const databaseRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
const { Client: PgClient } = databaseRequire("pg") as { Client: new (options: { connectionString: string }) => any };
const realtime = new PgClient({ connectionString: DATABASE_URL });
await realtime.connect();
await realtime.query("LISTEN rakazo_events");
realtime.on("notification", (notification: { payload?: string }) => {
  if (notification.payload) realtimeSignals.push(notification.payload);
});

// Fixed once per run: both sides of a case must seed identical times.
const THREAD_PAST = new Date(Date.now() - 2 * 3_600_000);
const THREAD_FUTURE = new Date(Date.now() + 30 * 86_400_000);

/** What the web app reloads right after a read-state change. */
const AFTER = [
  { procedure: "bots.list", input: {} },
  { procedure: "groups.list", input: {} },
  { procedure: "spaces.list", input: {} },
];

const SCRATCH_AFTER = [{ procedure: "scratchpad.list", input: { botId: "__s-tb1__", includeDone: true } }];

/** What the settings screens reload after a change. */
const SETTINGS_AFTER = [
  { procedure: "spaceSettings.overrides", input: undefined },
  { procedure: "approvalRules.list", input: undefined },
  { procedure: "approvalRules.list", input: { scope: "account" } },
  { procedure: "approvalRules.list", input: { scope: "space" } },
];

const cases: Case[] = [
  { name: "items", procedure: "availability.items", input: {} },
  {
    name: "set-add-space",
    procedure: "availability.set",
    input: { kind: "skill", id: "__skill__", allSpaces: false, spaceIds: ["__sp1__", "__sp2__"] },
  },
  {
    name: "set-all-spaces",
    procedure: "availability.set",
    input: { kind: "skill", id: "__skill__", allSpaces: true, spaceIds: ["__sp2__"] },
  },
  {
    name: "set-not-found",
    procedure: "availability.set",
    input: { kind: "skill", id: "missing", allSpaces: false, spaceIds: ["__sp2__"] },
  },
  {
    name: "set-invalid-empty",
    procedure: "availability.set",
    input: { kind: "skill", id: "__skill__", allSpaces: false, spaceIds: [] },
  },
  {
    name: "choose-add",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "__sp3__", items: [{ kind: "skill", id: "__skill__" }] },
  },
  {
    name: "choose-remove",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "__sp3__", items: [] },
    seed: async (seeded) => {
      await system.agentSkillSpace.create({
        data: { skillId: seeded.skillId, spaceId: seeded.spaces[2], userId: seeded.userId },
      });
    },
  },
  {
    name: "name-conflict",
    procedure: "availability.set",
    input: { kind: "skill", id: "__skill__", allSpaces: false, spaceIds: ["__sp1__", "__sp2__"] },
    seed: async (seeded) => {
      await system.agentSkill.create({
        data: {
          id: `${seeded.skillId}-dup`,
          spaceId: seeded.spaces[1],
          userId: seeded.userId,
          name: seeded.skillName,
          description: "",
          content: "body",
          source: "user",
        },
      });
    },
  },
  // Validation shapes for availability that the first slice did not compare.
  { name: "set-invalid-kind", procedure: "availability.set", input: { kind: "bogus", id: "__skill__", allSpaces: false, spaceIds: ["__sp1__"] } },
  { name: "set-invalid-missing-all", procedure: "availability.set", input: {} },
  { name: "set-invalid-types", procedure: "availability.set", input: { kind: 5, id: 7, allSpaces: "no", spaceIds: "x" } },
  { name: "set-invalid-empty-id", procedure: "availability.set", input: { kind: "skill", id: "", allSpaces: false, spaceIds: [""] } },
  { name: "choose-invalid-kind", procedure: "availability.chooseForSpace", input: { spaceId: "__sp1__", items: [{ kind: "bogus", id: "x" }] } },
  { name: "choose-invalid-types", procedure: "availability.chooseForSpace", input: { spaceId: 5, items: "x" } },
  { name: "choose-invalid-empty", procedure: "availability.chooseForSpace", input: { spaceId: "", items: [{ kind: "skill", id: "" }] } },
  { name: "set-invalid-array-input", procedure: "availability.set", input: [] },
  { name: "set-invalid-null-input", procedure: "availability.set", input: null },
  { name: "set-invalid-no-input", procedure: "availability.set", input: undefined },
  { name: "set-invalid-spaceids-mixed", procedure: "availability.set", input: { kind: "skill", id: "__skill__", allSpaces: false, spaceIds: [1, "", null, "ok"] } },
  { name: "set-invalid-spaceids-empty-and-id", procedure: "availability.set", input: { kind: "skill", id: "", allSpaces: true, spaceIds: [] } },
  { name: "set-invalid-id-array", procedure: "availability.set", input: { kind: "skill", id: [], allSpaces: true, spaceIds: ["__sp1__"] } },
  { name: "set-invalid-extra-keys-ok", procedure: "availability.set", input: { kind: "skill", id: "missing", allSpaces: true, spaceIds: ["__sp1__"], more: 1 } },
  { name: "choose-invalid-array-input", procedure: "availability.chooseForSpace", input: [] },
  { name: "choose-invalid-no-input", procedure: "availability.chooseForSpace", input: undefined },
  { name: "choose-invalid-items-mixed", procedure: "availability.chooseForSpace", input: { spaceId: "__sp1__", items: [1, null, [], {}, { kind: "skill" }, { kind: "skill", id: "x" }] } },
  { name: "choose-invalid-too-many", procedure: "availability.chooseForSpace", input: { spaceId: "__sp1__", items: Array.from({ length: 501 }, () => ({ kind: "skill", id: "x" })) } },
  { name: "choose-invalid-too-many-and-bad", procedure: "availability.chooseForSpace", input: { spaceId: "", items: Array.from({ length: 501 }, () => ({ kind: "bogus", id: "" })) } },
  { name: "choose-invalid-items-missing", procedure: "availability.chooseForSpace", input: { spaceId: "__sp1__" } },
  ...trustedLinkSiteCases(),
  ...spendingLimitCases(),
  ...botSectionCases(),
  ...pageCases(),
  ...botSectionWriteCases(),
  ...spendingSetCases(),
  ...messagingCases(),
  ...threadCases(),
  ...policyCases(),
  ...scratchpadCases(),
  ...approvalRuleCases(),
  ...spaceSettingCases(),
];

const SITES = ["zeta.example", "alpha.example", "Beta.example", "_under.example", "10.0.0.1"];

async function seedSites(seeded: Seeded) {
  const other = `${seeded.userId}-other`;
  await system.user.create({
    data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
  });
  for (const site of SITES) {
    await system.trustedLinkSite.create({ data: { userId: seeded.userId, site } });
  }
  await system.trustedLinkSite.create({ data: { userId: other, site: "alpha.example" } });
  await system.trustedLinkSite.create({ data: { userId: other, site: "other-only.example" } });
}

function trustedLinkSiteCases(): Case[] {
  const remove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "trustedLinkSites.remove",
    input,
    ...extra,
  });
  return [
    { name: "sites-list", procedure: "trustedLinkSites.list", input: {}, seed: seedSites },
    { name: "sites-list-empty", procedure: "trustedLinkSites.list", input: {} },
    { name: "sites-list-no-input", procedure: "trustedLinkSites.list", input: undefined, seed: seedSites },
    { name: "sites-list-anonymous", procedure: "trustedLinkSites.list", input: {}, anonymous: true },
    remove("sites-remove", { site: "alpha.example" }, { seed: seedSites }),
    remove("sites-remove-other-users-only", { site: "other-only.example" }, { seed: seedSites }),
    remove("sites-remove-absent", { site: "absent.example" }, { seed: seedSites }),
    remove("sites-remove-ignores-extra-keys", { site: "zeta.example", more: 1 }, { seed: seedSites }),
    remove("sites-remove-empty", { site: "" }, { seed: seedSites }),
    remove("sites-remove-too-long", { site: "a".repeat(254) }, { seed: seedSites }),
    remove("sites-remove-max-length", { site: "a".repeat(253) }, { seed: seedSites }),
    remove("sites-remove-astral-max-length", { site: "😀".repeat(253) }),
    remove("sites-remove-astral-too-long", { site: "😀".repeat(254) }),
    remove("sites-remove-missing-site", {}),
    remove("sites-remove-wrong-type", { site: 3 }),
    remove("sites-remove-null-site", { site: null }),
    remove("sites-remove-not-object", []),
    remove("sites-remove-null-input", null),
    remove("sites-remove-no-input", undefined),
    remove("sites-remove-anonymous", { site: "alpha.example" }, { seed: seedSites, anonymous: true }),
  ];
}

function ids(caseName: string) {
  const suffix = caseName.replace(/[^a-z0-9]/g, "");
  return {
    userId: `ct${RUN_TAG}-${suffix}-u`,
    orgId: `ct${RUN_TAG}-${suffix}-o`,
    spaces: [`ct${RUN_TAG}-${suffix}-s1`, `ct${RUN_TAG}-${suffix}-s2`, `ct${RUN_TAG}-${suffix}-s3`] as [string, string, string],
    skillId: `ct${RUN_TAG}-${suffix}-sk`,
    skillName: `Contract skill ${suffix}`,
    serverId: `ct${RUN_TAG}-${suffix}-sv`,
    serverSlug: `contract-server${RUN_TAG}-${suffix}`,
    installId: `ct${RUN_TAG}-${suffix}-in`,
    sessionToken: `token${RUN_TAG}-${suffix}-${"0".repeat(24)}`,
  };
}

type SpendingSeed = {
  /** The user's timezone; unset leaves the column null. */
  timezone?: string;
  limit?: { amount: number; currency: string; period: string; startsAt?: Date };
  payments?: (ctx: SpendingContext) => Array<{
    id: string;
    owner?: "user" | "other";
    botId: string;
    currency: string;
    amount: number;
    createdAt: Date;
    released?: boolean;
  }>;
  card?: "account" | "other-space" | "login";
  wallet?: "pending" | "connected";
  bots?: boolean;
};
type SpendingContext = { seeded: Seeded; now: Date; startOf: (period: "day" | "week" | "month") => Date };

function seedSpending(config: SpendingSeed = {}) {
  return async (seeded: Seeded) => {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    if (config.timezone) {
      await system.user.update({ where: { id: seeded.userId }, data: { timezone: config.timezone } });
    }
    const now = new Date();
    if (config.limit) {
      await system.spendingLimit.create({
        data: { userId: seeded.userId, ...config.limit, startsAt: config.limit.startsAt ?? now },
      });
      // A limit for the other user must never leak into this user's status.
      await system.spendingLimit.create({
        data: { userId: other, amount: 5, currency: "usd", period: "day" },
      });
    }
    if (config.bots) {
      const foreignOrg = `${seeded.orgId}-f`;
      const foreignSpace = `${seeded.spaces[0]}-f`;
      await system.organization.create({
        data: { id: foreignOrg, name: "Foreign", slug: foreignOrg, createdAt: new Date() },
      });
      await system.space.create({
        data: { id: foreignSpace, organizationId: foreignOrg, name: "Foreign", isDefault: true },
      });
      await system.bot.create({
        data: { id: `${seeded.userId}-own-bot`, spaceId: seeded.spaces[1], userId: seeded.userId, name: "Own bot", color: "blue" },
      });
      await system.bot.create({
        data: { id: `${seeded.userId}-foreign-bot`, spaceId: foreignSpace, userId: other, name: "Foreign bot", color: "red" },
      });
    }
    if (config.card) {
      await system.vaultCredential.create({
        data: {
          id: `${seeded.userId}-vault`,
          userId: seeded.userId,
          spaceId: config.card === "other-space" ? seeded.spaces[1] : null,
          name: "item",
          origin: "https://shop.example",
          auth: { type: config.card === "login" ? "login" : "card" },
          ciphertext: "sealed",
        },
      });
    }
    if (config.wallet) {
      await system.paymentWallet.create({
        data: {
          id: `${seeded.userId}-wallet`,
          userId: seeded.userId,
          provider: "test",
          status: config.wallet,
          ciphertext: "sealed",
        },
      });
    }
    if (config.payments) {
      const startOf = (period: "day" | "week" | "month") =>
        spendingPeriodStart(period, now, config.timezone, now);
      for (const payment of config.payments({ seeded, now, startOf })) {
        await system.payment.create({
          data: {
            id: payment.id,
            operationKey: payment.id,
            userId: payment.owner === "other" ? other : seeded.userId,
            spaceId: seeded.spaces[0],
            botId: payment.botId,
            threadId: "thread",
            site: `shop-${payment.id}.example`,
            amount: payment.amount,
            currency: payment.currency,
            createdAt: payment.createdAt,
            releasedAt: payment.released ? payment.createdAt : null,
          },
        });
      }
    }
  };
}

function spendingLimitCases(): Case[] {
  const get = (name: string, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `spend-get-${name}`,
    procedure: "spendingLimit.get",
    input: {},
    seed,
    ...extra,
  });
  const hour = 3_600_000;
  // Payments one second before the period start (out) and after it (in), same currency.
  const around = (period: "day" | "week" | "month") => (ctx: SpendingContext) => {
    const start = ctx.startOf(period).getTime();
    return [
      { id: "in1", botId: "b", currency: "usd", amount: 120, createdAt: new Date(start + 1000) },
      { id: "in2", botId: "b", currency: "usd", amount: 30, createdAt: new Date(ctx.now.getTime() - 1000) },
      { id: "out", botId: "b", currency: "usd", amount: 7, createdAt: new Date(start - 1000) },
      { id: "eur", botId: "b", currency: "eur", amount: 55, createdAt: new Date(start + 1000) },
      { id: "rel", botId: "b", currency: "usd", amount: 9, createdAt: new Date(start + 1000), released: true },
      { id: "oth", owner: "other" as const, botId: "b", currency: "usd", amount: 11, createdAt: new Date(start + 1000) },
    ];
  };
  return [
    {
      name: "spend-pay-empty",
      procedure: "spendingLimit.payments",
      input: {},
      seed: seedSpending({ bots: true, payments: () => [{ id: "x", owner: "other", botId: "b", currency: "usd", amount: 1, createdAt: new Date(0) }] }),
    },
    {
      name: "spend-pay-list",
      procedure: "spendingLimit.payments",
      input: {},
      seed: seedSpending({
        bots: true,
        payments: ({ seeded }) => {
          const t = Date.UTC(2026, 4, 1, 12, 0, 0, 123);
          return [
            { id: "p1", botId: `${seeded.userId}-own-bot`, currency: "usd", amount: 500, createdAt: new Date(t) },
            { id: "p2", botId: `${seeded.userId}-foreign-bot`, currency: "eur", amount: 700, createdAt: new Date(t + hour) },
            { id: "p3", botId: "gone", currency: "usd", amount: 900, createdAt: new Date(t + 2 * hour) },
            { id: "p4", botId: `${seeded.userId}-own-bot`, currency: "usd", amount: 100, createdAt: new Date(t + 3 * hour), released: true },
            { id: "p5", botId: `${seeded.userId}-own-bot`, currency: "ils", amount: 300, createdAt: new Date(t + hour) },
            { id: "px", owner: "other", botId: `${seeded.userId}-own-bot`, currency: "usd", amount: 111, createdAt: new Date(t) },
          ];
        },
      }),
    },
    {
      name: "spend-pay-cap",
      procedure: "spendingLimit.payments",
      input: {},
      seed: seedSpending({
        payments: () =>
          Array.from({ length: 55 }, (_, i) => ({
            id: `c${String(i).padStart(2, "0")}`,
            botId: "b",
            currency: "usd",
            amount: i + 1,
            createdAt: new Date(Date.UTC(2026, 4, 1) + (i % 5) * 60_000),
          })),
      }),
    },
    { name: "spend-pay-no-input", procedure: "spendingLimit.payments", input: undefined, seed: seedSpending({ bots: true }) },
    { name: "spend-pay-anonymous", procedure: "spendingLimit.payments", input: {}, anonymous: true },
    get("nothing", seedSpending()),
    get("no-input", seedSpending(), { input: undefined }),
    get("anonymous", seedSpending(), { anonymous: true }),
    get("card-account", seedSpending({ card: "account" })),
    get("card-other-space", seedSpending({ card: "other-space" })),
    get("login-only", seedSpending({ card: "login" })),
    get("wallet-pending", seedSpending({ wallet: "pending" })),
    get("wallet-connected", seedSpending({ wallet: "connected" })),
    get("paid-no-limit", seedSpending({ payments: ({ now }) => [{ id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now }] })),
    get("paid-released-only", seedSpending({ payments: ({ now }) => [{ id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now, released: true }] })),
    get("day-utc", seedSpending({ limit: { amount: 1000, currency: "usd", period: "day" }, payments: around("day") })),
    get("day-no-payments", seedSpending({ limit: { amount: 1000, currency: "usd", period: "day" } })),
    get(
      "week-auckland",
      seedSpending({ timezone: "Pacific/Auckland", limit: { amount: 2000, currency: "usd", period: "week" }, payments: around("week") }),
    ),
    get(
      "month-new-york-lowercase",
      seedSpending({ timezone: "america/new_york", limit: { amount: 3000, currency: "usd", period: "month" }, payments: around("month") }),
    ),
    get(
      "day-kiritimati",
      seedSpending({ timezone: "Pacific/Kiritimati", limit: { amount: 1000, currency: "eur", period: "day" }, payments: around("day") }),
    ),
    get(
      "day-unknown-timezone",
      seedSpending({ timezone: "No/Such_Zone", limit: { amount: 1000, currency: "usd", period: "day" }, payments: around("day") }),
    ),
    get(
      "none-since-start",
      seedSpending({
        limit: { amount: 1000, currency: "usd", period: "none", startsAt: new Date(Date.now() - 48 * hour) },
        payments: ({ now }) => [
          { id: "old", botId: "b", currency: "usd", amount: 3, createdAt: new Date(now.getTime() - 72 * hour) },
          { id: "new", botId: "b", currency: "usd", amount: 4, createdAt: new Date(now.getTime() - 24 * hour) },
        ],
      }),
    ),
    get(
      "invalid-stored-limit",
      seedSpending({
        limit: { amount: 0, currency: "jpy", period: "hourly" },
        payments: ({ now }) => [{ id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now }],
      }),
    ),
    get(
      "oversized-stored-limit",
      seedSpending({ limit: { amount: 2_000_000_000, currency: "gbp", period: "day" }, payments: around("day") }),
    ),
    get("limit-with-card", seedSpending({ card: "account", limit: { amount: 100, currency: "ils", period: "week" } })),
  ];
}

function botSectionCases(): Case[] {
  const base = Date.UTC(2026, 4, 1, 12, 0, 0, 456);
  const seedSections = (extra?: Case["seed"]) => async (seeded: Seeded) => {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    const make = (id: string, spaceId: string, userId: string, name: string, position: number, offset: number) =>
      system.botSection.create({
        data: {
          id: `${seeded.userId}-${id}`,
          spaceId,
          userId,
          name,
          position,
          createdAt: new Date(base + offset),
          updatedAt: new Date(base + offset + 1),
        },
      });
    await make("a", seeded.spaces[0], seeded.userId, "Late", 2, 0);
    await make("b", seeded.spaces[0], other, "Second by time", 1, 3_600_000);
    await make("c", seeded.spaces[0], seeded.userId, "First by time", 1, 0);
    await make("d", seeded.spaces[0], seeded.userId, "Zero", 0, 7);
    await make("e", seeded.spaces[1], seeded.userId, "Other space", 0, 0);
    await extra?.(seeded);
  };
  return [
    { name: "sections-list", procedure: "botSections.list", input: {}, seed: seedSections() },
    { name: "sections-list-empty", procedure: "botSections.list", input: {} },
    { name: "sections-list-no-input", procedure: "botSections.list", input: undefined, seed: seedSections() },
    { name: "sections-list-ignores-input", procedure: "botSections.list", input: { anything: 1 }, seed: seedSections() },
    { name: "sections-list-anonymous", procedure: "botSections.list", input: {}, anonymous: true },
  ];
}

const PAGE_BASE = Date.UTC(2026, 4, 1, 12, 0, 0, 0);

async function seedPages(seeded: Seeded) {
  const other = `${seeded.userId}-other`;
  await system.user.create({
    data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
  });
  const bot = `${seeded.userId}-bot`;
  const group = `${seeded.userId}-group`;
  await system.bot.create({
    data: { id: bot, spaceId: seeded.spaces[0], userId: seeded.userId, name: "Bot", color: "blue" },
  });
  await system.chatGroup.create({
    data: { id: group, spaceId: seeded.spaces[0], userId: seeded.userId, name: "Group" },
  });
  const hour = 3_600_000;
  const page = (
    id: string,
    title: string,
    updated: number,
    extra: { pinned?: number; botId?: string; groupId?: string; spaceId?: string; userId?: string; visibility?: string; version?: number } = {},
  ) =>
    system.page.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: extra.spaceId ?? seeded.spaces[0],
        userId: extra.userId ?? seeded.userId,
        title,
        botId: extra.botId ?? null,
        groupId: extra.groupId ?? null,
        visibility: extra.visibility ?? "private",
        currentVersion: extra.version ?? 1,
        pinnedAt: extra.pinned === undefined ? null : new Date(extra.pinned),
        createdAt: new Date(updated - hour),
        updatedAt: new Date(updated),
      },
    });
  await page("pa", "Alpha pinned", PAGE_BASE - 72 * hour, { pinned: PAGE_BASE - hour });
  await page("pb", "Beta pinned", PAGE_BASE - 48 * hour, { pinned: PAGE_BASE - 2 * hour, visibility: "link", version: 3 });
  await page("pc", "Tie pin", PAGE_BASE - 10 * hour, { pinned: PAGE_BASE - hour });
  await page("pd", "Tie pin newer update", PAGE_BASE - 9 * hour, { pinned: PAGE_BASE - hour + 5 });
  await page("u1", "100% sure", PAGE_BASE);
  await page("u2", "a_b", PAGE_BASE);
  await page("u3", "axb", PAGE_BASE, { botId: bot });
  await page("u4", "back\\slash", PAGE_BASE + 123);
  await page("u5", "Ünïcode Straße", PAGE_BASE, { visibility: "weird" });
  await page("u6", "plain Plain PLAIN", PAGE_BASE - hour);
  await page("g1", "group page", PAGE_BASE - 2 * hour, { groupId: group });
  await page("g2", "group bot page", PAGE_BASE - 2 * hour, { groupId: group, botId: bot });
  await page("x1", "other space", PAGE_BASE, { spaceId: seeded.spaces[1] });
  await page("x2", "other user", PAGE_BASE, { userId: other });
}

type WriteSeed = { deleting?: boolean; noSections?: boolean };

/** Bots, groups and sections for the botSections write cases (ids: `${userId}-ba` and so on). */
function seedWrites(config: WriteSeed = {}) {
  return async (seeded: Seeded) => {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    const user = seeded.userId;
    const old = new Date(Date.UTC(2020, 0, 1));
    const base = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
    const section = (id: string, spaceId: string, userId: string, name: string, position: number, offset: number) =>
      system.botSection.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId,
          name,
          position,
          createdAt: new Date(base + offset),
          updatedAt: new Date(base + offset + 1),
        },
      });
    if (!config.noSections) {
      await section("s1", seeded.spaces[0], user, "Work", 0, 0);
      await section("s2", seeded.spaces[0], other, "Play", 1, 1000);
      await section("s3", seeded.spaces[1], user, "Elsewhere", 0, 0);
    }
    const bot = (id: string, spaceId: string, name: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: user, name, color: "blue", updatedAt: old, ...extra },
      });
    await bot("ba", seeded.spaces[0], "Bot A");
    await bot("bb", seeded.spaces[0], "Bot B", config.noSections ? {} : { sectionId: `${user}-s2` });
    await bot("bx", seeded.spaces[1], "Bot X");
    await bot("barch", seeded.spaces[0], "Bot archived", { archivedAt: old });
    const group = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      system.chatGroup.create({
        data: { id: `${user}-${id}`, spaceId: seeded.spaces[0], userId: user, name, updatedAt: old, ...extra },
      });
    await group("grp", "Group", config.noSections ? {} : { sectionId: `${user}-s2` });
    await group("garch", "Group archived", { archivedAt: old });
    if (config.deleting) {
      await system.space.update({ where: { id: seeded.spaces[0] }, data: { deletingAt: new Date() } });
    }
  };
}

function botSectionWriteCases(): Case[] {
  const create = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bsw-create-${name}`,
    procedure: "botSections.create",
    input,
    seed: seedWrites(),
    ...extra,
  });
  const update = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bsw-update-${name}`,
    procedure: "botSections.update",
    input,
    seed: seedWrites(),
    ...extra,
  });
  const remove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bsw-remove-${name}`,
    procedure: "botSections.remove",
    input,
    seed: seedWrites(),
    ...extra,
  });
  return [
    create("bot-new", { botId: "__ba__", name: "Fresh" }),
    create("bot-new-empty-space", { botId: "__ba__", name: "Fresh" }, { seed: seedWrites({ noSections: true }) }),
    create("bot-existing-own", { botId: "__ba__", name: "Work" }),
    create("bot-existing-other-member", { botId: "__ba__", name: "Play" }),
    create("bot-moves-section", { botId: "__bb__", name: "Work" }),
    create("bot-already-in-section", { botId: "__bb__", name: "Play" }),
    create("group-new", { groupId: "__grp__", name: "Fresh" }),
    create("group-existing", { groupId: "__grp__", name: "Work" }),
    create("trim", { botId: "__ba__", name: "  Spaced \t" }),
    create("case-sensitive", { botId: "__ba__", name: "work" }),
    create("name-60", { botId: "__ba__", name: "n".repeat(60) }),
    create("name-astral-60", { botId: "__ba__", name: "😀".repeat(60) }),
    create("name-61", { botId: "__ba__", name: "n".repeat(61) }),
    create("name-astral-61", { botId: "__ba__", name: "😀".repeat(61) }),
    create("name-padded-61", { botId: "__ba__", name: ` ${"n".repeat(61)} ` }),
    create("bot-other-space", { botId: "__bx__", name: "x" }),
    create("bot-archived", { botId: "__barch__", name: "x" }),
    create("bot-unknown", { botId: "nope", name: "x" }),
    create("group-archived", { groupId: "__garch__", name: "x" }),
    create("group-unknown", { groupId: "nope", name: "x" }),
    create("space-deleting", { botId: "__ba__", name: "x" }, { seed: seedWrites({ deleting: true }) }),
    create("space-deleting-unknown-bot", { botId: "nope", name: "x" }, { seed: seedWrites({ deleting: true }) }),
    create("neither", { name: "x" }),
    create("both", { botId: "__ba__", groupId: "__grp__", name: "x" }),
    create("empty-bot-id", { botId: "", name: "x" }),
    create("empty-bot-id-with-group", { botId: "", groupId: "__grp__", name: "x" }),
    create("empty-both-ids", { botId: "", groupId: "", name: "x" }),
    create("bot-id-number", { botId: 5, name: "x" }),
    create("bot-id-null", { botId: null, name: "x" }),
    create("group-id-empty-array", { groupId: [], name: "x" }),
    create("group-id-array", { groupId: [1], name: "x" }),
    create("name-missing", { botId: "__ba__" }),
    create("name-number", { botId: "__ba__", name: 5 }),
    create("name-null", { botId: "__ba__", name: null }),
    create("name-blank", { botId: "__ba__", name: "   " }),
    create("name-empty", { botId: "__ba__", name: "" }),
    create("name-nbsp-only", { botId: "__ba__", name: "\u00a0\u3000" }),
    create("name-array", { botId: "__ba__", name: [] }),
    create("name-object-length", { botId: "__ba__", name: { length: 70 } }),
    create("many-issues", { botId: "", groupId: "", name: "" }),
    create("extra-keys-ignored", { botId: "__ba__", name: "Extra", more: 1 }),
    create("no-input", undefined),
    create("null-input", null),
    create("array-input", []),
    create("string-input", "x"),
    create("anonymous", { botId: "__ba__", name: "Fresh" }, { anonymous: true }),
    update("rename", { sectionId: "__s1__", name: "Office" }),
    update("rename-trim", { sectionId: "__s1__", name: "  Office  " }),
    update("rename-case", { sectionId: "__s1__", name: "work" }),
    update("same-name", { sectionId: "__s1__", name: "Work" }),
    update("same-name-after-trim", { sectionId: "__s1__", name: "  Work  " }),
    update("conflict", { sectionId: "__s1__", name: "Play" }),
    update("conflict-other-member-rename", { sectionId: "__s2__", name: "Work" }),
    update("other-space-section", { sectionId: "__s3__", name: "Z" }),
    update("other-space-same-name", { sectionId: "__s3__", name: "Elsewhere" }),
    update("unknown", { sectionId: "nope", name: "Z" }),
    update("name-61", { sectionId: "__s1__", name: "n".repeat(61) }),
    update("name-60-astral", { sectionId: "__s1__", name: "😀".repeat(60) }),
    update("section-missing", { name: "Z" }),
    update("section-empty", { sectionId: "", name: "Z" }),
    update("section-number", { sectionId: 5, name: "Z" }),
    update("section-array", { sectionId: [], name: "Z" }),
    update("name-missing", { sectionId: "__s1__" }),
    update("name-blank", { sectionId: "__s1__", name: "  " }),
    update("name-null", { sectionId: "__s1__", name: null }),
    update("both-invalid", { sectionId: "", name: "" }),
    update("extra-keys-ignored", { sectionId: "__s1__", name: "Office", more: 1 }),
    update("no-input", undefined),
    update("null-input", null),
    update("space-deleting-rename", { sectionId: "__s1__", name: "Office" }, { seed: seedWrites({ deleting: true }) }),
    update("space-deleting-same-name", { sectionId: "__s1__", name: "Work" }, { seed: seedWrites({ deleting: true }) }),
    update("anonymous", { sectionId: "__s1__", name: "Office" }, { anonymous: true }),
    remove("with-members", { sectionId: "__s2__" }),
    remove("empty", { sectionId: "__s1__" }),
    remove("other-space", { sectionId: "__s3__" }),
    remove("unknown", { sectionId: "nope" }),
    remove("missing", {}),
    remove("empty-id", { sectionId: "" }),
    remove("number-id", { sectionId: 5 }),
    remove("array-id", { sectionId: [] }),
    remove("array-id-one", { sectionId: [1] }),
    remove("extra-keys-ignored", { sectionId: "__s1__", more: 1 }),
    remove("no-input", undefined),
    remove("null-input", null),
    remove("array-input", []),
    remove("space-deleting", { sectionId: "__s1__" }, { seed: seedWrites({ deleting: true }) }),
    remove("anonymous", { sectionId: "__s1__" }, { anonymous: true }),
  ];
}

function spendingSetCases(): Case[] {
  const set = (name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `sls-${name}`,
    procedure: "spendingLimit.set",
    input,
    seed: seed ?? seedSpending(),
    ...extra,
  });
  const long = new Date(Date.UTC(2020, 0, 1));
  const limit = (amount: number, currency: string, period: string) => ({ limit: { amount, currency, period } });
  const cases: Case[] = [];
  for (const currency of ["usd", "eur", "gbp", "ils"]) {
    for (const period of ["day", "week", "month", "none"]) {
      cases.push(set(`new-${currency}-${period}`, limit(250, currency, period)));
    }
  }
  const existing = (period: string) =>
    seedSpending({ limit: { amount: 1000, currency: "usd", period, startsAt: long } });
  return [
    ...cases,
    set("replace-same-period", limit(2000, "eur", "week"), existing("week")),
    set("replace-day-with-week", limit(2000, "usd", "week"), existing("day")),
    set("day-to-none-restarts", limit(500, "usd", "none"), existing("day")),
    set("none-to-none-keeps-start", limit(500, "eur", "none"), existing("none")),
    set("none-to-day-keeps-start", limit(500, "usd", "day"), existing("none")),
    set("remove-existing", { limit: null }, existing("week")),
    set("remove-none-existing", { limit: null }),
    set(
      "with-payments-in-status",
      limit(900, "usd", "day"),
      seedSpending({
        limit: { amount: 1000, currency: "usd", period: "week", startsAt: long },
        payments: ({ now }) => [{ id: "a", botId: "b", currency: "usd", amount: 70, createdAt: new Date(now.getTime() - 1000) }],
      }),
    ),
    set("card-makes-it-shown", { limit: null }, seedSpending({ card: "account" })),
    set("amount-1", limit(1, "usd", "day")),
    set("amount-max", limit(100_000_000, "usd", "day")),
    set("amount-over-max", limit(100_000_001, "usd", "day")),
    set("amount-zero", limit(0, "usd", "day")),
    set("amount-negative", limit(-1, "usd", "day")),
    set("amount-fraction", limit(1.5, "usd", "day")),
    set("amount-small-fraction", limit(0.5, "usd", "day")),
    set("amount-string", limit("5" as never, "usd", "day")),
    set("amount-null", limit(null as never, "usd", "day")),
    set("amount-bool", limit(true as never, "usd", "day")),
    set("amount-huge", limit(1e300, "usd", "day")),
    set("amount-negative-huge", limit(-1e300, "usd", "day")),
    set("amount-unsafe", limit(9007199254740993, "usd", "day")),
    set("amount-missing", { limit: { currency: "usd", period: "day" } }),
    set("currency-unknown", limit(5, "jpy", "day")),
    set("currency-uppercase", limit(5, "USD", "day")),
    set("currency-number", limit(5, 5 as never, "day")),
    set("currency-null", limit(5, null as never, "day")),
    set("currency-array", limit(5, [] as never, "day")),
    set("currency-missing", { limit: { amount: 5, period: "day" } }),
    set("period-unknown", limit(5, "usd", "hourly")),
    set("period-null", limit(5, "usd", null as never)),
    set("period-missing", { limit: { amount: 5, currency: "usd" } }),
    set("all-invalid", limit(0, "jpy", "hourly")),
    set("all-missing", { limit: {} }),
    set("limit-missing", {}),
    set("limit-string", { limit: "x" }),
    set("limit-number", { limit: 5 }),
    set("limit-array", { limit: [] }),
    set("limit-bool", { limit: true }),
    set("limit-extra-key", { limit: { amount: 5, currency: "usd", period: "day", more: 1 } }),
    set("outer-extra-key", { limit: null, more: 1 }),
    set("outer-extra-key-with-limit", { ...limit(5, "usd", "day"), b: 1, 2: 1 }),
    set("both-extra-keys", { limit: { amount: 0, currency: "usd", period: "day", more: 1 }, other: 1 }),
    set("no-input", undefined),
    set("null-input", null),
    set("array-input", []),
    set("string-input", "x"),
    set("anonymous", limit(5, "usd", "day"), undefined, { anonymous: true }),
    set("anonymous-remove", { limit: null }, undefined, { anonymous: true }),
  ];
}

type MessagingSeed = {
  ownerName?: string;
  /** Outbound row for the c1 invite: its status and provider handle. */
  outbound?: { status: string; providerHandle?: string };
  noIdentities?: boolean;
  noChannels?: boolean;
  noConnections?: boolean;
  existingCode?: boolean;
};

function seedMessaging(config: MessagingSeed = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = `${user}-other`;
    await system.user.create({
      data: { id: other, name: config.ownerName ?? "Jane Quinn", email: `${other}@example.test`, emailVerified: true },
    });
    const old = new Date(Date.UTC(2020, 0, 1));
    const base = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
    const bot = (id: string, spaceId: string, owner: string, name: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: owner, name, color: "blue", updatedAt: old, ...extra },
      });
    await bot("mb1", seeded.spaces[0], user, "My bot one");
    await bot("mb2", seeded.spaces[0], user, "My bot two");
    await bot("mbx", seeded.spaces[1], user, "My bot in space two");
    await bot("march", seeded.spaces[0], user, "My archived bot", { archivedAt: old });
    await bot("pb1", seeded.spaces[1], other, "Peer bot one");
    await bot("pb2", seeded.spaces[1], other, "Peer bot two");
    await bot("pb3", seeded.spaces[1], other, "Peer bot three");
    await bot("pb4", seeded.spaces[0], other, "Peer bot in space one");
    const identity = (id: string, owner: string, spaceId: string, botId: string, extra: Record<string, unknown> = {}) =>
      system.messagingIdentity.create({
        data: {
          id: `${user}-${id}`,
          provider: "telegram",
          address: `${user}-${id}-addr`,
          userId: owner,
          spaceId,
          botId: `${user}-${botId}`,
          updatedAt: old,
          ...extra,
        },
      });
    if (!config.noIdentities) {
      await identity("id1", user, seeded.spaces[0], "mb1");
      await identity("id2", user, seeded.spaces[0], "mb2");
      await identity("idx", other, seeded.spaces[1], "pb1");
      await identity("idpb2", other, seeded.spaces[1], "pb2");
      const installation = await system.messagingInstallation.create({
        data: {
          id: `${user}-inst`,
          provider: "slack",
          workspaceId: `${user}-ws`,
          workspaceName: "Workspace",
          spaceId: seeded.spaces[1],
          userId: user,
          botId: `${user}-mbx`,
          ciphertext: "sealed",
        },
      });
      await system.bot.create({
        data: { id: `${user}-mb5`, spaceId: seeded.spaces[1], userId: user, name: "Slack bot", color: "blue", updatedAt: old },
      });
      await identity("idsl", user, seeded.spaces[1], "mb5", { installationId: installation.id });
    }
    if (config.existingCode) {
      await system.messagingLinkCode.create({
        data: { id: `${user}-oldcode`, code: "AAAAAAAA", userId: user, spaceId: seeded.spaces[0], botId: `${user}-mb2`, expiresAt: new Date(Date.now() + 60_000) },
      });
    }
    if (!config.noChannels) {
      const channel = (id: string, name: string | null, threadId: string) =>
        system.messagingChannel.create({ data: { id: `${user}-${id}`, provider: "telegram", name, threadId: `${user}-${threadId}` } });
      await channel("cn1", "Team", "th1");
      await channel("cn2", null, "th2");
      await channel("cn3", "Other people", "th3");
      const member = (id: string, channelId: string, address: string, identityId: string | null, status: string, offset: number) =>
        system.messagingChannelMember.create({
          data: {
            id: `${user}-${id}`,
            channelId: `${user}-${channelId}`,
            address,
            identityId: identityId ? `${user}-${identityId}` : null,
            status,
            createdAt: new Date(base + offset),
            updatedAt: new Date(base + offset),
          },
        });
      await member("mm1", "cn1", "a1", "id1", "invited", 1000);
      await member("mm2", "cn1", "a2", "id2", "approved", 2000);
      await member("mm3", "cn1", "a3", null, "approved", 3000);
      await member("mm4", "cn1", "a4", null, "left", 4000);
      await member("mm5", "cn2", "a5", "id1", "left", 5000);
      await member("mm6", "cn2", "a6", "id2", "invited", 6000);
      await member("mm7", "cn3", "a7", `${"idx"}`, "invited", 7000);
    }
    if (!config.noConnections) {
      const connection = (id: string, requester: string, target: string, status: string, offset: number) =>
        system.agentConnection.create({
          data: {
            id: `${user}-${id}`,
            requesterBotId: `${user}-${requester}`,
            targetBotId: `${user}-${target}`,
            status,
            requestVersion: 3,
            createdAt: new Date(base + offset),
            updatedAt: new Date(base + offset),
          },
        });
      await connection("cn4", "mb1", "pb1", "pending", 1000);
      await connection("cn5", "pb2", "mb2", "pending", 2000);
      await connection("cn6", "mb1", "pb2", "approved", 3000);
      await connection("cn7", "pb3", "mb1", "declined", 4000);
      await connection("cn8", "mb2", "pb3", "revoked", 5000);
      await connection("cn9", "pb1", "pb2", "pending", 6000);
      await connection("cn10", "mb2", "pb4", "approved", 7000);
      if (config.outbound) {
        await system.messagingOutbound.create({
          data: {
            id: `${user}-ob1`,
            idempotencyKey: `connect:${user}-mb1:${user}-pb1`,
            kind: "dm",
            body: "invite",
            status: config.outbound.status,
            providerHandle: config.outbound.providerHandle ?? null,
          },
        });
      }
      await system.messagingOutbound.create({
        data: { id: `${user}-ob2`, idempotencyKey: `connect:other:${user}`, kind: "dm", body: "unrelated", status: "pending" },
      });
    }
  };
}

function messagingCases(): Case[] {
  const mk = (procedure: string, label: string) => (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `msg-${label}-${name}`,
    procedure: `messaging.${procedure}`,
    input,
    seed: seedMessaging(),
    ...extra,
  });
  const link = mk("link.start", "link");
  const setBot = mk("identities.setBot", "setbot");
  const unlink = mk("identities.unlink", "unlink");
  const channels = mk("channels.list", "chlist");
  const respond = mk("channels.respond", "respond");
  const leave = mk("channels.leave", "leave");
  const connections = mk("connections.list", "connlist");
  const revoke = mk("connections.revoke", "revoke");
  const outbound = (status: string, providerHandle?: string) => seedMessaging({ outbound: { status, providerHandle } });
  return [
    link("new", { botId: "__mb1__" }),
    link("second-bot-supersedes", { botId: "__mb2__" }, { seed: seedMessaging({ existingCode: true }) }),
    link("bot-in-shared-space", { botId: "__mbx__" }),
    link("already-linked", { botId: "__mb1__" }),
    link("unknown-bot", { botId: "nope" }),
    link("archived-bot", { botId: "__march__" }),
    link("peer-bot-not-mine", { botId: "__pb1__" }),
    link("no-identities-new", { botId: "__mb1__" }, { seed: seedMessaging({ noIdentities: true }) }),
    link("missing", {}),
    link("empty", { botId: "" }),
    link("number", { botId: 5 }),
    link("array", { botId: [] }),
    link("extra-keys", { botId: "__mb1__", more: 1 }),
    link("no-input", undefined),
    link("null-input", null),
    link("anonymous", { botId: "__mb1__" }, { anonymous: true }),
    setBot("to-free-bot", { identityId: "__id1__", botId: "__mb2__" }, { seed: seedMessaging({ noChannels: true }) }),
    setBot("to-linked-bot", { identityId: "__id1__", botId: "__mb2__" }),
    setBot("same-bot", { identityId: "__id1__", botId: "__mb1__" }),
    setBot("archived-bot", { identityId: "__id1__", botId: "__march__" }),
    setBot("unknown-bot", { identityId: "__id1__", botId: "nope" }),
    setBot("other-space-bot", { identityId: "__id1__", botId: "__mbx__" }),
    setBot("peer-bot", { identityId: "__id1__", botId: "__pb4__" }),
    setBot("unknown-identity", { identityId: "nope", botId: "__mb2__" }),
    setBot("someone-elses-identity", { identityId: "__idx__", botId: "__mb2__" }),
    setBot("workspace-identity-other-space", { identityId: "__idsl__", botId: "__mb2__" }),
    setBot("missing-both", {}),
    setBot("types", { identityId: 5, botId: [] }),
    setBot("empty-ids", { identityId: "", botId: "" }),
    setBot("no-input", undefined),
    setBot("anonymous", { identityId: "__id1__", botId: "__mb2__" }, { anonymous: true }),
    unlink("own", { identityId: "__id1__" }),
    unlink("unknown", { identityId: "nope" }),
    unlink("someone-elses", { identityId: "__idx__" }),
    unlink("missing", {}),
    unlink("empty", { identityId: "" }),
    unlink("number", { identityId: 5 }),
    unlink("array-one", { identityId: [1] }),
    unlink("anonymous", { identityId: "__id1__" }, { anonymous: true }),
    channels("memberships", {}),
    channels("no-identities", {}, { seed: seedMessaging({ noIdentities: true }) }),
    channels("no-channels", {}, { seed: seedMessaging({ noChannels: true }) }),
    channels("no-input", undefined),
    channels("anonymous", {}, { anonymous: true }),
    respond("accept", { membershipId: "__mm1__", accept: true }),
    respond("decline", { membershipId: "__mm1__", accept: false }),
    respond("invited-on-second-identity", { membershipId: "__mm6__", accept: true }),
    respond("already-approved", { membershipId: "__mm2__", accept: true }),
    respond("left", { membershipId: "__mm5__", accept: true }),
    respond("someone-elses", { membershipId: "__mm7__", accept: true }),
    respond("unknown", { membershipId: "nope", accept: true }),
    respond("no-identities", { membershipId: "__mm1__", accept: true }, { seed: seedMessaging({ noIdentities: true }) }),
    respond("accept-string", { membershipId: "__mm1__", accept: "yes" }),
    respond("accept-missing", { membershipId: "__mm1__" }),
    respond("both-invalid", { membershipId: "", accept: 1 }),
    respond("no-input", undefined),
    respond("anonymous", { membershipId: "__mm1__", accept: true }, { anonymous: true }),
    leave("approved", { membershipId: "__mm2__" }),
    leave("invited", { membershipId: "__mm1__" }),
    leave("already-left", { membershipId: "__mm5__" }),
    leave("someone-elses", { membershipId: "__mm7__" }),
    leave("unknown", { membershipId: "nope" }),
    leave("no-identities", { membershipId: "__mm1__" }, { seed: seedMessaging({ noIdentities: true }) }),
    leave("missing", {}),
    leave("empty", { membershipId: "" }),
    leave("anonymous", { membershipId: "__mm1__" }, { anonymous: true }),
    connections("mixed", {}),
    connections("no-identities", {}, { seed: seedMessaging({ noIdentities: true }) }),
    connections("none", {}, { seed: seedMessaging({ noConnections: true }) }),
    connections("owner-name-multiword", {}, { seed: seedMessaging({ ownerName: "  \u00a0Mary-Jane  Smith" }) }),
    connections("owner-name-opaque", {}, { seed: seedMessaging({ ownerName: "ck1234567890123456789abcd" }) }),
    connections("owner-name-uuid", {}, { seed: seedMessaging({ ownerName: "123e4567-e89b-12d3-a456-426614174000" }) }),
    connections("owner-name-symbols", {}, { seed: seedMessaging({ ownerName: "😀 ✨" }) }),
    connections("owner-name-unicode-space", {}, { seed: seedMessaging({ ownerName: "Zoë\u2003Ünï" }) }),
    connections("owner-name-dunder", {}, { seed: seedMessaging({ ownerName: "__Placeholder_1__" }) }),
    connections("owner-name-camel", {}, { seed: seedMessaging({ ownerName: "AliceSmith1234567890Longname" }) }),
    connections("owner-name-mixed-long", {}, { seed: seedMessaging({ ownerName: "aB3dE6gH9jK2mN5pQ8sT" }) }),
    connections("no-input", undefined),
    connections("anonymous", {}, { anonymous: true }),
    revoke("pending-outgoing", { connectionId: "__cn4__" }, { seed: outbound("pending") }),
    revoke("pending-outgoing-retry", { connectionId: "__cn4__" }, { seed: outbound("retry") }),
    revoke("sent-without-handle", { connectionId: "__cn4__" }, { seed: outbound("sent") }),
    revoke("sent-with-handle", { connectionId: "__cn4__" }, { seed: outbound("sent", "provider-1") }),
    revoke("failed-invite-kept", { connectionId: "__cn4__" }, { seed: outbound("failed") }),
    revoke("incoming-pending", { connectionId: "__cn5__" }),
    revoke("approved", { connectionId: "__cn6__" }),
    revoke("declined", { connectionId: "__cn7__" }),
    revoke("already-revoked", { connectionId: "__cn8__" }),
    revoke("between-strangers", { connectionId: "__cn9__" }),
    revoke("unknown", { connectionId: "nope" }),
    revoke("no-identities", { connectionId: "__cn4__" }, { seed: seedMessaging({ noIdentities: true }) }),
    revoke("missing", {}),
    revoke("empty", { connectionId: "" }),
    revoke("number", { connectionId: 5 }),
    revoke("anonymous", { connectionId: "__cn4__" }, { anonymous: true }),
  ];
}

function pageCases(): Case[] {
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const cursorOf = (updatedAt: unknown, pinnedAt: unknown = null, id: unknown = "zzz") =>
    b64(JSON.stringify({ pinnedAt, updatedAt, id }));
  const list = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `pages-${name}`,
    procedure: "pages.list",
    input,
    seed: seedPages,
    ...extra,
  });
  const T = "2026-05-01T12:00:00.000Z";
  return [
    list("all", {}),
    list("all-no-seed", {}, { seed: undefined }),
    list("limit-1-walk", { limit: 1 }, { paginate: true }),
    list("limit-2-walk", { limit: 2 }, { paginate: true }),
    list("limit-3-walk", { limit: 3 }, { paginate: true }),
    list("limit-60", { limit: 60 }),
    list("bot", { botId: "__bot__" }),
    list("bot-walk", { botId: "__bot__", limit: 1 }, { paginate: true }),
    list("group", { groupId: "__group__" }),
    list("bot-and-group", { botId: "__bot__", groupId: "__group__" }),
    list("unknown-bot", { botId: "nope" }),
    list("query-percent", { query: "%" }),
    list("query-underscore", { query: "_" }),
    list("query-backslash", { query: "\\" }),
    list("query-percent-word", { query: "100%" }),
    list("query-wild-underscore", { query: "a_b" }),
    list("query-case", { query: "PLAIN" }),
    list("query-trim", { query: "  \u00a0\u3000 plain \t\n" }),
    list("query-unicode", { query: "STRASSE" }),
    list("query-unicode-lower", { query: "ünï" }),
    list("query-x", { query: "x", limit: 1 }, { paginate: true }),
    list("query-none", { query: "zzzz" }),
    list("query-with-bot", { query: "b", botId: "__bot__" }),
    list("anonymous", {}, { anonymous: true }),
    list("no-input", undefined),
    list("null-input", null),
    list("array-input", []),
    list("string-input", "x"),
    list("number-input", 5),
    list("unknown-key", { nope: 1 }),
    list("unknown-keys-order", { b: 1, 2: 1, 1: 1, a: 1, "01": 1 }),
    list("unknown-with-invalid", { zzz: 1, limit: 0, botId: "", query: "  " }),
    list("botid-empty", { botId: "" }),
    list("botid-number", { botId: 5 }),
    list("botid-null", { botId: null }),
    list("groupid-empty", { groupId: "" }),
    list("groupid-array", { groupId: [] }),
    list("groupid-array-one", { groupId: [1] }),
    list("botid-array-empty-and-limit", { botId: [], limit: 99, nope: 1 }),
    list("botid-object-length-zero", { botId: { length: 0 } }),
    list("botid-object-length-null", { botId: { length: null } }),
    list("botid-object-length-string", { botId: { length: "x" } }),
    list("botid-object-no-length", { botId: { size: 0 } }),
    list("cursor-array-long", { cursor: Array.from({ length: 501 }, () => 1) }),
    list("cursor-array-short", { cursor: [1, 2] }),
    list("cursor-object-length-big", { cursor: { length: 999 } }),
    list("query-array-empty", { query: [] }),
    list("query-array-long", { query: Array.from({ length: 201 }, () => 1) }),
    list("query-object-length-big", { query: { length: 999 } }),
    list("query-bool", { query: false }),
    list("cursor-too-long", { cursor: "a".repeat(501) }),
    list("cursor-max-length-invalid", { cursor: "a".repeat(500) }),
    list("cursor-empty", { cursor: "" }),
    list("cursor-number", { cursor: 5 }),
    list("cursor-null", { cursor: null }),
    list("limit-zero", { limit: 0 }),
    list("limit-61", { limit: 61 }),
    list("limit-negative", { limit: -3 }),
    list("limit-fraction", { limit: 1.5 }),
    list("limit-fraction-small", { limit: 0.5 }),
    list("limit-string", { limit: "5" }),
    list("limit-null", { limit: null }),
    list("limit-bool", { limit: true }),
    list("limit-huge", { limit: 1e300 }),
    list("limit-unsafe", { limit: 9007199254740993 }),
    list("limit-negative-huge", { limit: -1e300 }),
    list("query-empty", { query: "" }),
    list("query-blank", { query: " \n\t" }),
    list("query-too-long", { query: "q".repeat(201) }),
    list("query-max-length", { query: "q".repeat(200) }),
    list("query-padded-max", { query: ` ${"q".repeat(200)} ` }),
    list("query-number", { query: 5 }),
    list("query-null", { query: null }),
    // Cursors: ones the server writes, written by hand, and broken ones.
    list("cursor-unpinned", { cursor: cursorOf(T, null, "zzz") }),
    list("cursor-unpinned-tie", { cursor: cursorOf(T, null, "~") }),
    list("cursor-pinned", { cursor: cursorOf(T, "2026-04-30T11:00:00.000Z", "zzz") }),
    list("cursor-pinned-tie", { cursor: cursorOf("2026-04-21T02:00:00.000Z", "2026-05-01T11:00:00.000Z", "~") }),
    list("cursor-date-only", { cursor: cursorOf("2026-05-01", "2026-04-30") }),
    list("cursor-year-only", { cursor: cursorOf("2026", null) }),
    list("cursor-offset", { cursor: cursorOf("2026-05-01T17:30:00.000+05:30", null) }),
    list("cursor-no-fraction", { cursor: cursorOf("2026-05-01T12:00:00Z", null) }),
    list("cursor-lowercase-z", { cursor: cursorOf("2026-05-01T12:00:00z", null) }),
    list("cursor-long-fraction", { cursor: cursorOf("2026-05-01T12:00:00.1239999Z", null) }),
    list("cursor-24h", { cursor: cursorOf("2026-04-30T24:00:00.000Z", null) }),
    list("cursor-local-time", { cursor: cursorOf("2026-05-01T12:00:00.000", null) }),
    list("cursor-space-separator", { cursor: cursorOf("2026-05-01 12:00:00", null) }),
    list("cursor-ms-offset", { cursor: cursorOf("2026-05-01T12:00:00.123456+00:00", null) }),
    list("cursor-pinned-after-all", { cursor: cursorOf(T, "1999-01-01T00:00:00.000Z", "a") }),
    list("cursor-standard-base64", { cursor: Buffer.from(JSON.stringify({ pinnedAt: null, updatedAt: T, id: "zzz??" })).toString("base64") }),
    list("cursor-padded", { cursor: `${cursorOf(T, null, "zzz")}==` }),
    list("cursor-whitespace", { cursor: ` ${cursorOf(T, null, "zzz").slice(0, 10)}\n ${cursorOf(T, null, "zzz").slice(10)}` }),
    list("cursor-junk-chars", { cursor: `${cursorOf(T, null, "zzz").slice(0, 10)}*.${cursorOf(T, null, "zzz").slice(10)}` }),
    list("cursor-extra-keys", { cursor: b64(JSON.stringify({ pinnedAt: null, updatedAt: T, id: "zzz", more: [1] })) }),
    list("cursor-garbage", { cursor: "!!!" }),
    list("cursor-plain-text", { cursor: "hello" }),
    list("cursor-not-json", { cursor: b64("not json") }),
    list("cursor-null-doc", { cursor: b64("null") }),
    list("cursor-array-doc", { cursor: b64("[]") }),
    list("cursor-number-doc", { cursor: b64("5") }),
    list("cursor-string-doc", { cursor: b64('"x"') }),
    list("cursor-empty-object", { cursor: b64("{}") }),
    list("cursor-no-id", { cursor: b64(JSON.stringify({ pinnedAt: null, updatedAt: T })) }),
    list("cursor-id-number", { cursor: cursorOf(T, null, 5) }),
    list("cursor-id-null", { cursor: cursorOf(T, null, null) }),
    list("cursor-id-empty", { cursor: cursorOf(T, null, "") }),
    list("cursor-no-pinned", { cursor: b64(JSON.stringify({ updatedAt: T, id: "zzz" })) }),
    list("cursor-no-updated", { cursor: b64(JSON.stringify({ pinnedAt: null, id: "zzz" })) }),
    list("cursor-bad-updated", { cursor: cursorOf("yesterday", null) }),
    list("cursor-bad-pinned", { cursor: cursorOf(T, "soon") }),
    list("cursor-updated-null", { cursor: cursorOf(null, null) }),
    list("cursor-bad-month", { cursor: cursorOf("2026-13-01", null) }),
    list("cursor-bad-day", { cursor: cursorOf("2026-05-32", null) }),
    list("cursor-feb-30", { cursor: cursorOf("2026-02-30", null) }),
    list("cursor-hour-25", { cursor: cursorOf("2026-05-01T25:00:00Z", null) }),
    list("cursor-minute-60", { cursor: cursorOf("2026-05-01T12:60:00Z", null) }),
    list("cursor-24h-nonzero", { cursor: cursorOf("2026-05-01T24:00:01Z", null) }),
    list("cursor-empty-date", { cursor: cursorOf("", null) }),
    list("cursor-bad-with-valid-limit", { cursor: "!!!", limit: 5 }),
  ];
}

/** One call, or the whole cursor walk when the case paginates. */
async function run(
  testCase: Case,
  call: (procedure: string, input: unknown, seeded: Seeded) => Promise<{ status: number; headers: unknown; body: any }>,
  input: unknown,
  seeded: Seeded,
) {
  if (!testCase.paginate) {
    const result = await call(testCase.procedure, input, called(seeded, testCase));
    return testCase.after ? { ...result, followUps: await followUps(testCase, seeded) } : result;
  }
  const pages: Awaited<ReturnType<typeof call>>[] = [];
  let cursor: string | undefined;
  for (let step = 0; step < 30; step += 1) {
    const result = await call(
      testCase.procedure,
      { ...(input as object), ...(cursor ? { cursor } : {}) },
      called(seeded, testCase),
    );
    pages.push(result);
    cursor = result.body?.json?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return { status: pages[0]!.status, headers: pages[0]!.headers, body: pages.map((page) => page.body) };
}

/** What the web app does right after a read-state change: it reloads the chat lists (through TypeScript). */
async function followUps(testCase: Case, seeded: Seeded) {
  const results = [];
  for (const step of testCase.after ?? []) {
    results.push(await tsCall(step.procedure, withIds(step.input, seeded), called(seeded, testCase)));
  }
  return results;
}

type ThreadSeed = { noReads?: boolean };

/**
 * Chats for the thread read-state cases: bots tb1..tb5 and tbfresh (space 1), an archived bot, a bot without a
 * thread, a bot in space two, groups tg1/tg2 (one with a single active member), their threads, events, messages and
 * per-user reads (including another member's, which must stay untouched).
 */
function seedThreads(config: ThreadSeed = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = `${user}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: { id: `${seeded.orgId}-mo`, organizationId: seeded.orgId, userId: other, role: "member", createdAt: new Date() },
    });
    // Creating a member also adds them to the organization's default Space (space one).
    const old = new Date(Date.UTC(2020, 0, 1));
    const bot = (id: string, spaceId: string, name: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({ data: { id: `${user}-${id}`, spaceId, userId: user, name, color: "blue", updatedAt: old, ...extra } });
    await bot("tb1", seeded.spaces[0], "Chat one");
    await bot("tb2", seeded.spaces[0], "Chat two");
    await bot("tb3", seeded.spaces[0], "Chat three");
    await bot("tb4", seeded.spaces[0], "Chat four");
    await bot("tb5", seeded.spaces[0], "Chat five");
    await bot("tbfresh", seeded.spaces[0], "Chat fresh");
    await bot("tbarch", seeded.spaces[0], "Chat archived", { archivedAt: old });
    await bot("tbnone", seeded.spaces[0], "Chat without a thread");
    await bot("tbx", seeded.spaces[1], "Chat in space two");
    const thread = (id: string, spaceId: string, extra: Record<string, unknown>, next: number) =>
      system.thread.create({ data: { id: `${user}-${id}`, spaceId, userId: user, nextMessageSeq: next, nextEventSeq: next, ...extra } });
    await thread("th-tb1", seeded.spaces[0], { botId: `${user}-tb1` }, 10);
    await thread("th-tb2", seeded.spaces[0], { botId: `${user}-tb2` }, 10);
    await thread("th-tb3", seeded.spaces[0], { botId: `${user}-tb3` }, 10);
    await thread("th-tb4", seeded.spaces[0], { botId: `${user}-tb4` }, 0);
    await thread("th-tb5", seeded.spaces[0], { botId: `${user}-tb5` }, 10);
    await thread("th-tbfresh", seeded.spaces[0], { botId: `${user}-tbfresh` }, 10);
    await thread("th-tbarch", seeded.spaces[0], { botId: `${user}-tbarch` }, 10);
    await thread("th-tbx", seeded.spaces[1], { botId: `${user}-tbx` }, 10);
    const group = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      system.chatGroup.create({ data: { id: `${user}-${id}`, spaceId: seeded.spaces[0], userId: user, name, updatedAt: old, ...extra } });
    await group("tg1", "Group one");
    await group("tg2", "Group two");
    await group("tgone", "Group of one");
    await group("tgarch", "Group archived", { archivedAt: old });
    await group("tgnone", "Group without a thread");
    const member = (groupId: string, botId: string) =>
      system.chatGroupMember.create({ data: { id: `${user}-gm-${groupId}-${botId}`, groupId: `${user}-${groupId}`, botId: `${user}-${botId}` } });
    for (const id of ["tg1", "tg2", "tgarch", "tgnone"]) {
      await member(id, "tb1");
      await member(id, "tb2");
    }
    await member("tgone", "tb1");
    await member("tgone", "tbarch");
    await thread("th-tg1", seeded.spaces[0], { groupId: `${user}-tg1` }, 10);
    await thread("th-tg2", seeded.spaces[0], { groupId: `${user}-tg2` }, 3);
    await thread("th-tgone", seeded.spaces[0], { groupId: `${user}-tgone` }, 10);
    await thread("th-tgarch", seeded.spaces[0], { groupId: `${user}-tgarch` }, 10);
    const event = (threadId: string, seq: number) =>
      system.event.create({
        data: { id: `${user}-ev-${threadId}-${seq}`, spaceId: seeded.spaces[0], threadId: `${user}-${threadId}`, botId: `${user}-tb1`, seq, type: "note", payload: { n: seq } },
      });
    for (const seq of [0, 3, 7]) await event("th-tb1", seq);
    await event("th-tg1", 2);
    const message = (id: string, threadId: string, seq: number) =>
      system.message.create({
        data: { id: `${user}-${id}`, threadId: `${user}-${threadId}`, seq, role: "user", blocks: [{ kind: "text", text: "hi" }] },
      });
    await message("msg5", "th-tb1", 5);
    await message("msg0", "th-tb1", 0);
    await message("msgother", "th-tb2", 4);
    if (config.noReads) return;
    const read = (threadId: string, data: Record<string, unknown>, userId = user) =>
      system.threadRead.create({ data: { threadId: `${user}-${threadId}`, userId, spaceId: seeded.spaces[0], ...data } });
    await read("th-tb1", { unread: true, lastReadSeq: 4 });
    await read("th-tb2", { unread: false, lastReadSeq: 9 });
    await read("th-tb3", { unread: false, lastReadSeq: 3 });
    await read("th-tb4", { unread: true, lastReadSeq: -1 });
    await read("th-tb5", { unread: true, lastReadSeq: 9, snoozedUntil: THREAD_PAST });
    await read("th-tg1", { unread: false, lastReadSeq: 9, snoozedUntil: THREAD_FUTURE });
    await read("th-tg2", { unread: true, lastReadSeq: 0 });
    // Someone else's state for the same chats must stay untouched.
    await read("th-tb1", { unread: true, lastReadSeq: 1 }, other);
    await read("th-tb2", { unread: true, lastReadSeq: 2, snoozedUntil: THREAD_FUTURE }, other);
  };
}

function threadCases(): Case[] {
  const mk = (procedure: string, label: string) => (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `thr-${label}-${name}`,
    procedure: `threads.${procedure}`,
    input,
    seed: seedThreads(),
    after: AFTER,
    ...extra,
  });
  const read = mk("markRead", "read");
  const unread = mk("markUnread", "unread");
  const snooze = mk("snooze", "snooze");
  const head = mk("head", "head");
  const days = (n: number) => new Date(THREAD_FUTURE.getTime() + (n - 30) * 86_400_000).toISOString();
  // The same instant written with an offset, as a phone in another zone might.
  const wire = (n: number) => new Date(THREAD_FUTURE.getTime() + (n - 30) * 86_400_000 + 19_800_000).toISOString().replace("Z", "+05:30");
  return [
    // markRead: the client sends { botId } or { groupId }.
    read("bot-unread-with-gap", { botId: "__tb1__" }),
    read("bot-read-behind-without-dot", { botId: "__tb3__" }),
    read("bot-already-caught-up", { botId: "__tb2__" }),
    read("bot-empty-thread-unread", { botId: "__tb4__" }),
    read("bot-woken-snooze-ends", { botId: "__tb5__" }),
    read("bot-no-read-state", { botId: "__tbfresh__" }),
    read("bot-no-reads-at-all", { botId: "__tb1__" }, { seed: seedThreads({ noReads: true }) }),
    read("group-running-snooze-stays", { groupId: "__tg1__" }),
    read("group-unread", { groupId: "__tg2__" }),
    read("group-single-active-member", { groupId: "__tgone__" }),
    read("group-archived", { groupId: "__tgarch__" }),
    read("group-without-thread", { groupId: "__tgnone__" }),
    read("bot-archived", { botId: "__tbarch__" }),
    read("bot-without-thread", { botId: "__tbnone__" }),
    read("bot-in-other-space-wrong-header", { botId: "__tbx__" }),
    read("bot-in-other-space-own-header", { botId: "__tbx__" }, { space: 1 }),
    read("unknown-bot", { botId: "nope" }),
    read("unknown-group", { groupId: "nope" }),
    read("neither", {}),
    read("both", { botId: "__tb1__", groupId: "__tg1__" }),
    read("empty-bot-id", { botId: "" }),
    read("empty-both", { botId: "", groupId: "" }),
    read("bot-id-number", { botId: 5 }),
    read("bot-id-null", { botId: null }),
    read("group-id-array", { groupId: [] }),
    read("extra-keys-ignored", { botId: "__tb1__", messageId: "x", more: 1 }),
    read("no-input", undefined),
    read("null-input", null),
    read("array-input", []),
    read("anonymous", { botId: "__tb1__" }, { anonymous: true }),
    // markUnread: { botId|groupId, messageId? }.
    unread("bot-no-message", { botId: "__tb2__" }),
    unread("bot-no-read-state", { botId: "__tbfresh__" }),
    unread("bot-no-reads-at-all", { botId: "__tb1__" }, { seed: seedThreads({ noReads: true }) }),
    unread("bot-from-message", { botId: "__tb1__", messageId: "__msg5__" }),
    unread("bot-from-first-message", { botId: "__tb1__", messageId: "__msg0__" }),
    unread("bot-from-message-no-read-state", { botId: "__tbfresh__", messageId: "__msg5__" }),
    unread("group-no-message", { groupId: "__tg2__" }),
    unread("group-from-message-of-another-chat", { groupId: "__tg1__", messageId: "__msg5__" }),
    unread("bot-message-of-another-thread", { botId: "__tb1__", messageId: "__msgother__" }),
    unread("bot-unknown-message", { botId: "__tb1__", messageId: "nope" }),
    unread("bot-empty-message-id", { botId: "__tb1__", messageId: "" }),
    unread("bot-message-id-number", { botId: "__tb1__", messageId: 5 }),
    unread("bot-message-id-null", { botId: "__tb1__", messageId: null }),
    unread("bot-message-id-array", { botId: "__tb1__", messageId: [] }),
    unread("bot-archived", { botId: "__tbarch__" }),
    unread("group-single-active-member", { groupId: "__tgone__" }),
    unread("unknown-bot-with-message", { botId: "nope", messageId: "__msg5__" }),
    unread("neither", { messageId: "__msg5__" }),
    unread("both", { botId: "__tb1__", groupId: "__tg1__" }),
    unread("everything-wrong", { botId: 5, groupId: "", messageId: 7 }),
    unread("no-input", undefined),
    unread("array-input", []),
    unread("null-input", null),
    unread("anonymous", { botId: "__tb1__" }, { anonymous: true }),
    // snooze: until is toISOString() or null.
    snooze("bot-30-days", { botId: "__tb1__", until: days(30) }),
    snooze("bot-offset-notation", { botId: "__tb2__", until: wire(20) }),
    snooze("bot-fraction-digits", { botId: "__tb2__", until: days(20).replace(/Z$/, "456Z") }),
    snooze("bot-no-fraction", { botId: "__tb2__", until: days(20).replace(/\.\d+Z$/, "Z") }),
    snooze("bot-no-read-state", { botId: "__tbfresh__", until: days(2) }),
    snooze("bot-no-reads-at-all", { botId: "__tb1__", until: days(2) }, { seed: seedThreads({ noReads: true }) }),
    snooze("bot-keeps-unread-and-cursor", { botId: "__tb4__", until: days(2) }),
    snooze("bot-null-wakes", { botId: "__tb5__", until: null }),
    snooze("group-null-wakes", { groupId: "__tg1__", until: null }),
    snooze("bot-null-no-read-state-creates-nothing", { botId: "__tbfresh__", until: null }),
    snooze("group-replaces-snooze", { groupId: "__tg1__", until: days(300) }),
    snooze("bot-in-the-past", { botId: "__tb1__", until: "2020-01-01T00:00:00.000Z" }),
    snooze("bot-just-past", { botId: "__tb1__", until: new Date(Date.now() - 1000).toISOString() }),
    snooze("bot-365-days", { botId: "__tb1__", until: days(365) }),
    snooze("bot-367-days", { botId: "__tb1__", until: days(367) }),
    snooze("bot-far-future", { botId: "__tb1__", until: "2999-01-01T00:00:00.000Z" }),
    snooze("unknown-bot-bad-time", { botId: "nope", until: "2020-01-01T00:00:00.000Z" }),
    snooze("archived-bot", { botId: "__tbarch__", until: days(2) }),
    snooze("group-single-active-member", { groupId: "__tgone__", until: days(2) }),
    snooze("date-only", { botId: "__tb1__", until: "2026-12-01" }),
    snooze("no-seconds", { botId: "__tb1__", until: "2026-12-01T10:00Z" }),
    snooze("no-zone", { botId: "__tb1__", until: "2026-12-01T10:00:00" }),
    snooze("compact-offset", { botId: "__tb1__", until: "2026-12-01T10:00:00+0530" }),
    snooze("space-separator", { botId: "__tb1__", until: "2026-12-01 10:00:00Z" }),
    snooze("impossible-date", { botId: "__tb1__", until: "2026-02-30T10:00:00Z" }),
    snooze("hour-24", { botId: "__tb1__", until: "2026-12-01T24:00:00Z" }),
    snooze("leading-space", { botId: "__tb1__", until: " 2026-12-01T10:00:00Z" }),
    snooze("empty-string", { botId: "__tb1__", until: "" }),
    snooze("number", { botId: "__tb1__", until: 5 }),
    snooze("missing", { botId: "__tb1__" }),
    snooze("bool", { botId: "__tb1__", until: false }),
    snooze("array", { botId: "__tb1__", until: [] }),
    snooze("target-and-time-wrong", { botId: 5, until: 5 }),
    snooze("neither-target", { until: null }),
    snooze("both-targets", { botId: "__tb1__", groupId: "__tg1__", until: null }),
    snooze("no-input", undefined),
    snooze("array-input", []),
    snooze("anonymous", { botId: "__tb1__", until: null }, { anonymous: true }),
    // head
    head("bot-with-events", { botId: "__tb1__" }, { after: [] }),
    head("bot-without-events", { botId: "__tb2__" }, { after: [] }),
    head("group-with-events", { groupId: "__tg1__" }, { after: [] }),
    head("group-without-events", { groupId: "__tg2__" }, { after: [] }),
    head("archived-bot", { botId: "__tbarch__" }, { after: [] }),
    head("bot-without-thread", { botId: "__tbnone__" }, { after: [] }),
    head("group-single-active-member", { groupId: "__tgone__" }, { after: [] }),
    head("other-space-bot", { botId: "__tbx__" }, { after: [] }),
    head("other-space-bot-own-header", { botId: "__tbx__" }, { after: [], space: 1 }),
    head("unknown", { groupId: "nope" }, { after: [] }),
    head("neither", {}, { after: [] }),
    head("both", { botId: "__tb1__", groupId: "__tg1__" }, { after: [] }),
    head("bot-id-number", { botId: 5 }, { after: [] }),
    head("empty-id", { botId: "" }, { after: [] }),
    head("extra-keys", { botId: "__tb1__", signal: true }, { after: [] }),
    head("no-input", undefined, { after: [] }),
    head("array-input", [], { after: [] }),
    head("anonymous", { botId: "__tb1__" }, { after: [], anonymous: true }),
  ];
}

function seedConversations() {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = `${user}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    await system.member.create({
      data: { id: `${seeded.orgId}-mo`, organizationId: seeded.orgId, userId: other, role: "member", createdAt: new Date() },
    });
    // Creating a member also adds them to the organization's default Space (space one).
    const old = new Date(Date.UTC(2020, 0, 1));
    await system.bot.create({ data: { id: `${user}-tb1`, spaceId: seeded.spaces[0], userId: user, name: "Bot", color: "blue", updatedAt: old } });
    await system.bot.create({ data: { id: `${user}-tbx`, spaceId: seeded.spaces[1], userId: user, name: "Bot x", color: "blue", updatedAt: old } });
    const conversation = (id: string, owner: string, spaceId: string, botId: string) =>
      system.externalConversation.create({
        data: {
          id: `${user}-${id}`,
          provider: "telegram",
          workspaceId: "w",
          externalKey: `${user}-${id}`,
          conversationId: `${user}-${id}`,
          spaceId,
          botId: `${user}-${botId}`,
          userId: owner,
          teamChatAmbientEnabled: true,
          teamChatRules: "old rules",
          automatedSenderPolicies: { old: { name: "Old", mode: "ignore" } },
          updatedAt: old,
        },
      });
    await conversation("ec1", user, seeded.spaces[0], "tb1");
    await conversation("ec2", other, seeded.spaces[0], "tb1");
    await conversation("ec3", user, seeded.spaces[1], "tbx");
  };
}

function policyCases(): Case[] {
  const update = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `ecp-${name}`,
    procedure: "externalConversations.updatePolicy",
    input,
    seed: seedConversations(),
    ...extra,
  });
  const policy = (automatedSenderPolicies: unknown, rest: Record<string, unknown> = {}) => ({
    externalConversationId: "__ec1__",
    teamChatAmbientEnabled: true,
    teamChatRules: "Be brief.",
    automatedSenderPolicies,
    ...rest,
  });
  const entries = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`sender-${String(i).padStart(3, "0")}`, { name: `Sender ${i}`, mode: "ignore" }]));
  return [
    // The web client sends the whole form.
    update("client-shape", policy({ "bot-1": { name: "CI bot", mode: "rollup", rollupHours: 24 }, "bot-2": { name: "Alerts", mode: "action" } })),
    update("empty-policies", policy({})),
    update("ambient-null-rules-null", policy({}, { teamChatAmbientEnabled: null, teamChatRules: null })),
    update("ambient-false", policy({}, { teamChatAmbientEnabled: false, teamChatRules: "" })),
    update("all-modes", policy({ a: { name: "A", mode: "ignore" }, b: { name: "B", mode: "rollup", rollupHours: 1 }, c: { name: "C", mode: "action" }, d: { name: "D", mode: "user" } })),
    update("rollup-hours-720", policy({ a: { name: "A", mode: "rollup", rollupHours: 720 } })),
    update("hours-with-other-mode", policy({ a: { name: "A", mode: "user", rollupHours: 5 } })),
    update("keys-trimmed", policy({ "  padded \t": { name: "  Padded name  ", mode: "ignore" } })),
    update("keys-collide-after-trim", policy({ " a ": { name: "first", mode: "ignore" }, a: { name: "second", mode: "user" } })),
    update("numeric-keys-order", policy({ b: { name: "b", mode: "ignore" }, 10: { name: "ten", mode: "ignore" }, 2: { name: "two", mode: "ignore" }, a: { name: "a", mode: "ignore" } })),
    update("proto-key-dropped", JSON.parse(`{"externalConversationId":"__ec1__","teamChatAmbientEnabled":true,"teamChatRules":"r","automatedSenderPolicies":{"__proto__":{"name":"x","mode":"ignore"},"ok":{"name":"y","mode":"ignore"}}}`)),
    update("unknown-keys-stripped", policy({ a: { name: "A", mode: "ignore", extra: [1], deep: { x: 1 } } }, { more: true })),
    update("unicode", policy({ "ключ-😀": { name: "Имя ✨", mode: "ignore" } }, { teamChatRules: "règles — 日本語 😀" })),
    update("line-separators-in-text", policy({ a: { name: "A\u2028B", mode: "ignore" } }, { teamChatRules: "x\u2028y\u2029z <b> & \"q\" \\ /" })),
    update("nul-in-rules-and-names", policy({ "k\u0000": { name: "n\u0000m", mode: "ignore" } }, { teamChatRules: "a\u0000b" })),
    update("controls-and-escapes", policy({ a: { name: "tab\there", mode: "ignore" } }, { teamChatRules: "line1\nline2\r\n\u0007\u007f" })),
    update("rules-4000", policy({}, { teamChatRules: "r".repeat(4000) })),
    update("rules-4001", policy({}, { teamChatRules: "r".repeat(4001) })),
    update("rules-astral-4000", policy({}, { teamChatRules: "😀".repeat(4000) })),
    update("rules-astral-4001", policy({}, { teamChatRules: "😀".repeat(4001) })),
    update("name-120", policy({ a: { name: "n".repeat(120), mode: "ignore" } })),
    update("name-121", policy({ a: { name: "n".repeat(121), mode: "ignore" } })),
    update("name-padded-121", policy({ a: { name: ` ${"n".repeat(121)} `, mode: "ignore" } })),
    update("key-200", policy({ ["k".repeat(200)]: { name: "A", mode: "ignore" } })),
    update("key-201", policy({ ["k".repeat(201)]: { name: "A", mode: "ignore" } })),
    update("key-empty", policy({ "": { name: "A", mode: "ignore" } })),
    update("key-blank", policy({ " \u00a0\u3000": { name: "A", mode: "ignore" } })),
    update("key-invalid-and-value-invalid", policy({ "": { name: "", mode: "bad" } })),
    update("entries-50", policy(entries(50))),
    update("entries-51", policy(entries(51))),
    update("entries-51-with-bad-value", policy({ ...entries(51), bad: { name: "", mode: "ignore" } })),
    update("entries-51-with-type-error", policy({ ...entries(51), bad: 5 })),
    update("entries-51-with-key-error", policy({ ...entries(51), "": { name: "A", mode: "ignore" } })),
    update("entries-51-collapse-to-50", policy({ ...entries(50), " sender-000 ": { name: "dup", mode: "user" } })),
    update("rollup-without-hours", policy({ a: { name: "A", mode: "rollup" } })),
    update("rollup-without-hours-two-keys", policy({ a: { name: "A", mode: "rollup" }, b: { name: "B", mode: "rollup" } })),
    update("rollup-blank-name-no-hours", policy({ a: { name: " ", mode: "rollup" } })),
    update("rollup-wrong-name-type-no-hours", policy({ a: { name: 5, mode: "rollup" } })),
    update("rollup-bad-hours-type", policy({ a: { name: "A", mode: "rollup", rollupHours: "3" } })),
    update("hours-0", policy({ a: { name: "A", mode: "ignore", rollupHours: 0 } })),
    update("hours-721", policy({ a: { name: "A", mode: "ignore", rollupHours: 721 } })),
    update("hours-fraction", policy({ a: { name: "A", mode: "ignore", rollupHours: 1.5 } })),
    update("hours-null", policy({ a: { name: "A", mode: "ignore", rollupHours: null } })),
    update("hours-negative-huge", policy({ a: { name: "A", mode: "ignore", rollupHours: -1e300 } })),
    update("mode-unknown", policy({ a: { name: "A", mode: "block" } })),
    update("mode-missing", policy({ a: { name: "A" } })),
    update("mode-number", policy({ a: { name: "A", mode: 1 } })),
    update("name-missing", policy({ a: { mode: "ignore" } })),
    update("name-null", policy({ a: { name: null, mode: "ignore" } })),
    update("value-not-object", policy({ a: 5, b: "x", c: null, d: [], e: true })),
    update("policies-array", policy([])),
    update("policies-null", policy(null)),
    update("policies-string", policy("x")),
    update("policies-missing", { externalConversationId: "__ec1__", teamChatAmbientEnabled: true, teamChatRules: "r" }),
    update("ambient-string", policy({}, { teamChatAmbientEnabled: "yes" })),
    update("ambient-missing", { externalConversationId: "__ec1__", teamChatRules: "r", automatedSenderPolicies: {} }),
    update("rules-number", policy({}, { teamChatRules: 5 })),
    update("rules-array", policy({}, { teamChatRules: [] })),
    update("rules-missing", { externalConversationId: "__ec1__", teamChatAmbientEnabled: true, automatedSenderPolicies: {} }),
    update("id-empty", policy({}, { externalConversationId: "" })),
    update("id-number", policy({}, { externalConversationId: 5 })),
    update("id-missing", { teamChatAmbientEnabled: true, teamChatRules: "r", automatedSenderPolicies: {} }),
    update("everything-wrong", { externalConversationId: "", teamChatAmbientEnabled: "y", teamChatRules: 5, automatedSenderPolicies: [] }),
    update("empty-object", {}),
    update("no-input", undefined),
    update("null-input", null),
    update("array-input", []),
    update("someone-elses-conversation", policy({}, { externalConversationId: "__ec2__" })),
    update("other-space-conversation", policy({}, { externalConversationId: "__ec3__" })),
    update("other-space-conversation-own-header", policy({}, { externalConversationId: "__ec3__" }), { space: 1 }),
    update("unknown-conversation", policy({}, { externalConversationId: "nope" })),
    update("anonymous", policy({}), { anonymous: true }),
  ];
}

const SETTINGS_BASE = Date.UTC(2020, 0, 1);
const HOUR = 3_600_000;

/** A second member of the organization, who shares Space one with the case's user. */
async function seedOtherMember(seeded: Seeded) {
  const other = `${seeded.userId}-other`;
  await system.user.create({
    data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
  });
  await system.member.create({
    data: { id: `${seeded.orgId}-mo`, organizationId: seeded.orgId, userId: other, role: "member", createdAt: new Date() },
  });
  // Creating a member also adds them to the organization's default Space (space one).
  return other;
}

/** Bots tb1/tb2/tbarch in space one and tbx in space two, with the items notes on them. */
function seedScratchpad() {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const bot = (id: string, spaceId: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({ data: { id: `${user}-${id}`, spaceId, userId: user, name: id, color: "blue", ...extra } });
    await bot("tb1", seeded.spaces[0]);
    await bot("tb2", seeded.spaces[0]);
    await bot("tbarch", seeded.spaces[0], { archivedAt: new Date(SETTINGS_BASE) });
    await bot("tbx", seeded.spaces[1]);
    const item = (id: string, botId: string, spaceId: string, title: string, status: string, updated: number, created: number, userId = user) =>
      system.scratchpadItem.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          botId: `${user}-${botId}`,
          userId,
          title,
          status,
          notes: `notes of ${title}`,
          createdAt: new Date(SETTINGS_BASE + created * HOUR),
          updatedAt: new Date(SETTINGS_BASE + updated * HOUR),
        },
      });
    await item("i1", "tb1", seeded.spaces[0], "Alpha", "open", 1, 1);
    await item("i2", "tb1", seeded.spaces[0], "Beta", "parked", 2, 2);
    await item("i3", "tb1", seeded.spaces[0], "Gamma", "done", 3, 3);
    await item("i4", "tb1", seeded.spaces[0], "Delta", "weird", 4, 4);
    await item("i5", "tb1", seeded.spaces[0], "Tie", "open", 1, 5);
    await item("i6", "tb1", seeded.spaces[0], "Someone else's", "open", 6, 6, other);
    await item("i7", "tb2", seeded.spaces[0], "Other bot", "open", 1, 1);
    await item("i8", "tbarch", seeded.spaces[0], "Archived bot", "open", 1, 1);
    await item("i9", "tbx", seeded.spaces[1], "Space two", "open", 1, 1);
  };
}

function scratchpadCases(): Case[] {
  const mk = (procedure: string) => (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `scr-${procedure}-${name}`,
    procedure: `scratchpad.${procedure}`,
    input,
    seed: seedScratchpad(),
    after: procedure === "list" ? undefined : SCRATCH_AFTER,
    ...extra,
  });
  const list = mk("list");
  const create = mk("create");
  const update = mk("update");
  const remove = mk("remove");
  const long = (count: number, character = "t") => character.repeat(count);
  return [
    list("open-and-parked-by-default", { botId: "__s-tb1__" }),
    list("include-done", { botId: "__s-tb1__", includeDone: true }),
    list("include-done-false", { botId: "__s-tb1__", includeDone: false }),
    list("status-open", { botId: "__s-tb1__", status: "open" }),
    list("status-parked", { botId: "__s-tb1__", status: "parked" }),
    list("status-done", { botId: "__s-tb1__", status: "done" }),
    list("status-wins-over-include-done", { botId: "__s-tb1__", status: "open", includeDone: true }),
    list("bot-with-an-item", { botId: "__s-tb2__" }),
    list("archived-bot", { botId: "__s-tbarch__" }),
    list("unknown-bot", { botId: "nope" }),
    list("other-space-bot", { botId: "__s-tbx__" }),
    list("other-space-bot-own-header", { botId: "__s-tbx__" }, { space: 1 }),
    list("extra-keys-ignored", { botId: "__s-tb1__", more: true }),
    list("status-unknown", { botId: "__s-tb1__", status: "weird" }),
    list("status-null", { botId: "__s-tb1__", status: null }),
    list("status-number", { botId: "__s-tb1__", status: 1 }),
    list("include-done-string", { botId: "__s-tb1__", includeDone: "yes" }),
    list("include-done-null", { botId: "__s-tb1__", includeDone: null }),
    list("bot-id-missing", {}),
    list("bot-id-empty", { botId: "" }),
    list("bot-id-number", { botId: 5 }),
    list("everything-wrong", { botId: 5, status: "x", includeDone: 1 }),
    list("no-input", undefined),
    list("null-input", null),
    list("array-input", []),
    list("anonymous", { botId: "__s-tb1__" }, { anonymous: true }),

    create("client-shape", { botId: "__s-tb1__", title: "Call the bank", status: "open", notes: "" }),
    create("defaults", { botId: "__s-tb1__", title: "Only a title" }),
    create("trimmed", { botId: "__s-tb1__", title: "  Padded\t", notes: "\n  padded notes \u00a0\ufeff" }),
    create("whitespace-only-title-stores-empty", { botId: "__s-tb1__", title: "   " }),
    create("status-parked", { botId: "__s-tb1__", title: "Parked", status: "parked" }),
    create("status-done", { botId: "__s-tb1__", title: "Done", status: "done", notes: "n" }),
    create("title-200", { botId: "__s-tb1__", title: long(200) }),
    create("title-201", { botId: "__s-tb1__", title: long(201) }),
    create("title-astral-200", { botId: "__s-tb1__", title: long(200, "😀") }),
    create("title-astral-201", { botId: "__s-tb1__", title: long(201, "😀") }),
    create("title-padded-201-trims-to-200", { botId: "__s-tb1__", title: ` ${long(199)} ` }),
    create("notes-4000", { botId: "__s-tb1__", title: "N", notes: long(4000, "n") }),
    create("notes-4001", { botId: "__s-tb1__", title: "N", notes: long(4001, "n") }),
    create("notes-astral-4000", { botId: "__s-tb1__", title: "N", notes: long(4000, "😀") }),
    create("notes-astral-4001", { botId: "__s-tb1__", title: "N", notes: long(4001, "😀") }),
    create("unicode-and-separators", { botId: "__s-tb1__", title: "Ключ 日本語 \u2028 <b> & \"q\" \\ /", notes: "line1\nline2\r\n\u2029 ✨" }),
    create("nul-in-title", { botId: "__s-tb1__", title: "a\u0000b" }),
    create("nul-in-notes", { botId: "__s-tb1__", title: "ok", notes: "a\u0000b" }),
    create("lone-surrogate-escape", JSON.parse(`{"botId":"__s-tb1__","title":"a\\ud800b"}`)),
    create("status-unknown", { botId: "__s-tb1__", title: "T", status: "weird" }),
    create("status-null", { botId: "__s-tb1__", title: "T", status: null }),
    create("notes-null", { botId: "__s-tb1__", title: "T", notes: null }),
    create("notes-number", { botId: "__s-tb1__", title: "T", notes: 5 }),
    create("title-empty", { botId: "__s-tb1__", title: "" }),
    create("title-null", { botId: "__s-tb1__", title: null }),
    create("title-missing", { botId: "__s-tb1__" }),
    create("title-array", { botId: "__s-tb1__", title: [] }),
    create("bot-id-missing", { title: "T" }),
    create("bot-id-empty", { botId: "", title: "T" }),
    create("everything-wrong", { botId: 5, title: "", status: "x", notes: 5 }),
    create("archived-bot", { botId: "__s-tbarch__", title: "T" }),
    create("unknown-bot", { botId: "nope", title: "T" }),
    create("other-space-bot", { botId: "__s-tbx__", title: "T" }),
    create("other-space-bot-own-header", { botId: "__s-tbx__", title: "T" }, { space: 1 }),
    create("invalid-input-before-missing-bot", { botId: "nope", title: "" }),
    create("extra-keys-ignored", { botId: "__s-tb1__", title: "T", id: "x", userId: "y" }),
    create("no-input", undefined),
    create("null-input", null),
    create("array-input", []),
    create("anonymous", { botId: "__s-tb1__", title: "T" }, { anonymous: true }),

    update("title-only", { itemId: "__s-i1__", title: "Renamed" }),
    update("status-only", { itemId: "__s-i1__", status: "done" }),
    update("notes-only", { itemId: "__s-i1__", notes: "new notes" }),
    update("all-fields", { itemId: "__s-i2__", title: "T2", status: "open", notes: "N2" }),
    update("no-fields-writes-nothing", { itemId: "__s-i1__" }),
    update("trimmed", { itemId: "__s-i1__", title: "  x  ", notes: "  y  " }),
    update("whitespace-only-title-stores-empty", { itemId: "__s-i1__", title: "   " }),
    update("empty-notes-clear", { itemId: "__s-i1__", notes: "" }),
    update("odd-stored-status-reads-open", { itemId: "__s-i4__", title: "Kept weird" }),
    update("done-item-reopened", { itemId: "__s-i3__", status: "open" }),
    update("someone-elses-item-in-my-space", { itemId: "__s-i6__", title: "Edited" }),
    update("title-200", { itemId: "__s-i1__", title: long(200) }),
    update("title-201", { itemId: "__s-i1__", title: long(201) }),
    update("notes-4000", { itemId: "__s-i1__", notes: long(4000, "n") }),
    update("notes-4001", { itemId: "__s-i1__", notes: long(4001, "n") }),
    update("nul-in-title", { itemId: "__s-i1__", title: "a\u0000b" }),
    update("title-empty", { itemId: "__s-i1__", title: "" }),
    update("title-null", { itemId: "__s-i1__", title: null }),
    update("status-null", { itemId: "__s-i1__", status: null }),
    update("status-unknown", { itemId: "__s-i1__", status: "weird" }),
    update("notes-null", { itemId: "__s-i1__", notes: null }),
    update("notes-number", { itemId: "__s-i1__", notes: 5 }),
    update("everything-wrong", { itemId: "", title: "", status: "x", notes: 5 }),
    update("item-id-missing", { title: "T" }),
    update("item-id-empty", { itemId: "" }),
    update("unknown-item", { itemId: "nope", title: "T" }),
    update("invalid-input-before-missing-item", { itemId: "nope", title: "" }),
    update("other-space-item", { itemId: "__s-i9__", title: "T" }),
    update("other-space-item-own-header", { itemId: "__s-i9__", title: "T" }, { space: 1 }),
    update("archived-bot-item", { itemId: "__s-i8__", title: "T" }),
    update("extra-keys-ignored", { itemId: "__s-i1__", title: "T", botId: "other" }),
    update("no-input", undefined),
    update("array-input", []),
    update("anonymous", { itemId: "__s-i1__", title: "T" }, { anonymous: true }),

    remove("item", { itemId: "__s-i1__" }),
    remove("done-item", { itemId: "__s-i3__" }),
    remove("someone-elses-item-in-my-space", { itemId: "__s-i6__" }),
    remove("archived-bot-item", { itemId: "__s-i8__" }),
    remove("unknown", { itemId: "nope" }),
    remove("other-space-item", { itemId: "__s-i9__" }),
    remove("other-space-item-own-header", { itemId: "__s-i9__" }, { space: 1 }),
    remove("item-id-missing", {}),
    remove("item-id-empty", { itemId: "" }),
    remove("item-id-number", { itemId: 5 }),
    remove("extra-keys-ignored", { itemId: "__s-i1__", botId: "x" }),
    remove("no-input", undefined),
    remove("null-input", null),
    remove("anonymous", { itemId: "__s-i1__" }, { anonymous: true }),
  ];
}

type SettingsSeed = {
  /** Settings Space one overrides, each with a Space copy that differs from the account's. */
  overrides?: string[];
  /** A Space copy with no override row, as a half-finished earlier run could leave. */
  strayCopy?: boolean;
  /** The account has nothing saved to copy. */
  bare?: boolean;
};

/**
 * The member's account settings (model roles, voice, confirmations, vault) and, when asked, Space overrides with
 * their own copies; a second member's rows in the same Space must never move.
 */
function seedSettings(config: SettingsSeed = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const [one, two] = seeded.spaces;
    const at = (offset: number) => new Date(SETTINGS_BASE + offset * 1000);
    const rule = (id: string, effect: string, matchKind: string, matchValue: string, offset: number) =>
      system.userActionApprovalRule.create({ data: { id: `${user}-${id}`, userId: user, effect, matchKind, matchValue, createdAt: at(offset) } });
    const spaceRule = (id: string, spaceId: string, effect: string, matchKind: string, matchValue: string, offset: number, userId = user) =>
      system.actionApprovalRule.create({ data: { id: `${user}-${id}`, spaceId, createdByUserId: userId, effect, matchKind, matchValue, createdAt: at(offset) } });
    if (!config.bare) {
      await rule("ra1", "always_allow", "tool", "bash", 1);
      await rule("ra2", "deny", "site", "Example.com", 2);
      await rule("ra3", "require_approval", "connector", "github", 3);
      await rule("ra4", "deny", "category", "web", 4);
      await rule("ra5", "always_allow", "tool", "Under_score", 5);
      await rule("ra6", "always_allow", "tool", "i\u0307x", 6);
      await rule("ra7", "always_allow", "tool", "ΑΣ", 7);
      await rule("ra8", "always_allow", "tool", "MiXed", 8);
      await system.userActionAutoReviewPreference.create({ data: { userId: user, enabled: true, skipApprovals: true } });
      for (const id of ["mc1", "vc1", "vc2"]) {
        await system.secret.create({ data: { id: `${user}-sec-${id}`, userId: user, spaceId: null, kind: id.startsWith("vc") ? "voice" : "model", ciphertext: "sealed" } });
      }
      await system.userModelCredential.create({
        data: { id: `${user}-mc1`, userId: user, provider: "openai", label: "Key", secretId: `${user}-sec-mc1` },
      });
      const choice = (role: string, position: number, provider: string, modelId: string, thinkingLevel: string | null, credentialId: string | null) =>
        system.userModelRoleChoice.create({ data: { userId: user, role, position, provider, modelId, thinkingLevel, credentialId } });
      await choice("chat", 0, "openai", "gpt-a", "high", `${user}-mc1`);
      await choice("chat", 1, "anthropic", "claude-b", null, null);
      await choice("summary", 0, "openai", "gpt-c", null, `${user}-mc1`);
      for (const id of ["vc1", "vc2"]) {
        await system.userVoiceCredential.create({ data: { id: `${user}-${id}`, userId: user, provider: "fish", secretId: `${user}-sec-${id}` } });
      }
      await system.userVoicePreference.create({
        data: { userId: user, credentialId: `${user}-vc1`, voiceId: "voice-one", speechModel: "s1", isDefault: true },
      });
      await system.userVoicePreference.create({
        data: { userId: user, credentialId: `${user}-vc2`, voiceId: "voice-two", speechModel: null, isDefault: false },
      });
    }
    const vault = (id: string, spaceId: string | null, userId = user) =>
      system.vaultCredential.create({
        data: { id: `${user}-${id}`, userId, spaceId, name: id, origin: "https://example.test", auth: {}, ciphertext: "sealed" },
      });
    await vault("v1", one);
    await vault("v2", two);
    await vault("v3", null);
    await vault("vo", one, other);
    await spaceRule("rs1", one, "deny", "tool", "bash", 11);
    await spaceRule("rs2", one, "always_allow", "site", "space.example", 12);
    await spaceRule("rs3", one, "deny", "tool", "SPACE", 13);
    await spaceRule("rt1", two, "deny", "tool", "bash", 14);
    await system.userActionApprovalRule.create({ data: { id: `${user}-rao`, userId: other, effect: "deny", matchKind: "tool", matchValue: "bash", createdAt: at(15) } });
    await spaceRule("rso", one, "deny", "tool", "bash", 16, other);
    await system.spaceSettingOverride.create({ data: { spaceId: one, userId: other, setting: "confirmations" } });
    for (const setting of config.overrides ?? []) {
      await system.spaceSettingOverride.create({ data: { spaceId: one, userId: user, setting } });
    }
    const copies = new Set(config.overrides ?? []);
    if (config.strayCopy) for (const setting of ["models", "voice", "confirmations"]) copies.add(setting);
    if (copies.has("models")) {
      await system.spaceModelRoleChoice.create({
        data: { spaceId: one, userId: user, role: "chat", position: 0, provider: "stale", modelId: "stale-model", thinkingLevel: null, credentialId: null },
      });
    }
    if (copies.has("voice") && !config.bare) {
      await system.spaceVoicePreference.create({
        data: { id: `${user}-svp`, spaceId: one, userId: user, credentialId: `${user}-vc1`, voiceId: "stale-voice", isDefault: true },
      });
    }
    if (copies.has("confirmations")) {
      await system.actionAutoReviewPreference.create({ data: { id: `${user}-sar`, spaceId: one, userId: user, enabled: false, skipApprovals: false } });
    }
    await system.actionAutoReviewPreference.create({ data: { id: `${user}-saro`, spaceId: one, userId: other, enabled: true, skipApprovals: true } });
    await system.actionAutoReviewPreference.create({ data: { id: `${user}-sar2`, spaceId: two, userId: user, enabled: true, skipApprovals: false } });
  };
}

function approvalRuleCases(): Case[] {
  const mk = (procedure: string, seed = seedSettings()) => (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `apr-${procedure}-${name}`,
    procedure: `approvalRules.${procedure}`,
    input,
    seed,
    after: procedure === "set" ? SETTINGS_AFTER : undefined,
    ...extra,
  });
  const list = mk("list");
  const set = mk("set");
  const overridden = { seed: seedSettings({ overrides: ["confirmations"] }) };
  const rule = (matchValue: string, effect: string | null = "deny", matchKind = "tool", more: Record<string, unknown> = {}) => ({ effect, matchKind, matchValue, ...more });
  return [
    list("account-copy-by-default", undefined),
    list("empty-object", {}),
    list("space-copy-when-overridden", undefined, overridden),
    list("scope-account-while-overridden", { scope: "account" }, overridden),
    list("scope-space-while-overridden", { scope: "space" }, overridden),
    list("scope-space-without-override", { scope: "space" }),
    list("scope-account", { scope: "account" }),
    list("other-settings-override-does-not-switch", undefined, { seed: seedSettings({ overrides: ["models", "voice", "credentials"] }) }),
    list("space-two-header", undefined, { space: 1 }),
    list("nothing-saved", undefined, { seed: seedSettings({ bare: true }) }),
    list("extra-keys-ignored", { scope: "space", more: 1 }),
    list("scope-unknown", { scope: "team" }),
    list("scope-null", { scope: null }),
    list("scope-number", { scope: 1 }),
    list("null-input", null),
    list("array-input", []),
    list("string-input", "account"),
    list("anonymous", undefined, { anonymous: true }),

    set("client-shape-new-rule", rule("git", "always_allow")),
    set("new-rule-each-kind-connector", rule("slack", "require_approval", "connector")),
    set("new-rule-each-kind-site", rule("new.example", "deny", "site")),
    set("same-rule-again-returns-the-existing-one", rule("bash", "always_allow")),
    set("other-effect-replaces", rule("bash", "deny")),
    set("require-approval-replaces", rule("bash", "require_approval")),
    set("different-case-same-effect-replaces-spelling", rule("BASH", "always_allow")),
    set("different-case-other-effect-replaces", rule("Bash", "deny")),
    set("site-case-replaces", rule("EXAMPLE.COM", "deny", "site")),
    set("padded-value-is-trimmed", rule("  bash \t", "deny")),
    set("padded-value-with-unicode-spaces", rule("\u00a0\ufeffbash\u3000", "deny")),
    set("underscore-is-not-a-wildcard", rule("underXscore", "deny")),
    set("underscore-matches-itself-in-any-case", rule("UNDER_score", "deny")),
    set("percent-is-not-a-wildcard", rule("%", "deny")),
    set("kind-is-part-of-the-match", rule("github", "deny", "tool")),
    set("category-rows-are-left-alone", rule("web", "deny", "tool")),
    set("dotted-capital-i-lowercases-to-i-and-a-dot", rule("\u0130x", "deny")),
    set("final-sigma-matches", rule("ας", "deny")),
    set("medial-sigma-differs", rule("ασ", "deny")),
    set("sigma-after-apostrophe", rule("Α'Σ", "deny")),
    set("mixed-case-lookup", rule("mixed", "deny")),
    set("unicode-value", rule("ключ-😀 日本語", "always_allow")),
    set("line-separators-in-value", rule("a\u2028b <x> & \"q\" \\ /", "deny")),
    set("nul-in-value", rule("a\u0000b", "deny")),
    set("long-value", rule("v".repeat(5000), "deny")),
    set("scope-account-explicit", rule("git", "deny", "tool", { scope: "account" })),
    set("scope-space-explicit", rule("git", "deny", "tool", { scope: "space" })),
    set("space-copy-when-overridden", rule("git", "deny"), overridden),
    set("space-copy-replaces-other-effect", rule("bash", "always_allow"), overridden),
    set("space-copy-same-rule-again", rule("bash", "deny"), overridden),
    set("scope-account-while-overridden", rule("git", "deny", "tool", { scope: "account" }), overridden),
    set("scope-space-without-override", rule("bash", "always_allow", "tool", { scope: "space" })),
    set("space-two-header", rule("git", "deny"), { space: 1 }),
    set("nothing-saved-yet", rule("git", "deny"), { seed: seedSettings({ bare: true }) }),
    set("extra-keys-ignored", rule("git", "deny", "tool", { id: "x", createdAt: "y" })),
    set("effect-unknown", rule("git", "block")),
    set("effect-missing", { matchKind: "tool", matchValue: "git" }),
    set("effect-null", rule("git", null)),
    set("kind-category-is-not-settable", rule("git", "deny", "category")),
    set("kind-unknown", rule("git", "deny", "plugin")),
    set("kind-missing", { effect: "deny", matchValue: "git" }),
    set("value-empty", rule("")),
    set("value-whitespace", rule(" \t\u00a0\u2028 ")),
    set("value-missing", { effect: "deny", matchKind: "tool" }),
    set("value-null", { effect: "deny", matchKind: "tool", matchValue: null }),
    set("value-number", { effect: "deny", matchKind: "tool", matchValue: 5 }),
    set("value-array", { effect: "deny", matchKind: "tool", matchValue: [] }),
    set("scope-unknown", rule("git", "deny", "tool", { scope: "team" })),
    set("scope-null", rule("git", "deny", "tool", { scope: null })),
    set("everything-wrong", { scope: 1, effect: 2, matchKind: 3, matchValue: 4 }),
    set("empty-object", {}),
    set("no-input", undefined),
    set("null-input", null),
    set("array-input", []),
    set("anonymous", rule("git"), { anonymous: true }),
  ];
}

function spaceSettingCases(): Case[] {
  const mk = (procedure: string) => (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `sso-${procedure}-${name}`,
    procedure: `spaceSettings.${procedure}`,
    input,
    seed: seedSettings(),
    after: procedure === "setOverride" ? SETTINGS_AFTER : undefined,
    ...extra,
  });
  const overrides = mk("overrides");
  const set = mk("setOverride");
  const all = ["models", "voice", "confirmations", "credentials"];
  const some = (...overrides: string[]) => ({ seed: seedSettings({ overrides }) });
  return [
    overrides("none", undefined),
    overrides("some-in-enum-order", undefined, some("credentials", "voice")),
    overrides("all", undefined, some(...all)),
    overrides("space-two-header", undefined, { space: 1, ...some("models") }),
    overrides("junk-input-is-ignored", { anything: 1 }),
    overrides("anonymous", undefined, { anonymous: true }),

    ...all.flatMap((setting) => [
      set(`${setting}-enable`, { setting, enabled: true }),
      set(`${setting}-disable`, { setting, enabled: false }, some(setting)),
      set(`${setting}-enable-when-already-on`, { setting, enabled: true }, some(setting)),
      set(`${setting}-disable-when-already-off`, { setting, enabled: false }),
      set(`${setting}-enable-over-a-stray-copy`, { setting, enabled: true }, { seed: seedSettings({ strayCopy: true }) }),
      set(`${setting}-enable-with-nothing-to-copy`, { setting, enabled: true }, { seed: seedSettings({ bare: true }) }),
      set(`${setting}-disable-leaves-the-others`, { setting, enabled: false }, some(...all)),
      set(`${setting}-enable-in-space-two`, { setting, enabled: true }, { space: 1 }),
    ]),
    set("extra-keys-ignored", { setting: "models", enabled: true, more: 1 }),
    set("setting-unknown", { setting: "billing", enabled: true }),
    set("setting-null", { setting: null, enabled: true }),
    set("setting-number", { setting: 1, enabled: true }),
    set("setting-missing", { enabled: true }),
    set("enabled-string", { setting: "models", enabled: "true" }),
    set("enabled-null", { setting: "models", enabled: null }),
    set("enabled-missing", { setting: "models" }),
    set("everything-wrong", { setting: 1, enabled: 2 }),
    set("empty-object", {}),
    set("no-input", undefined),
    set("null-input", null),
    set("array-input", []),
    set("anonymous", { setting: "models", enabled: true }, { anonymous: true }),
  ];
}

async function reset(seeded: ReturnType<typeof ids>) {
  const { userId, orgId } = seeded;
  await system.messagingOutbound.deleteMany({ where: { id: { startsWith: userId } } });
  await system.agentConnection.deleteMany({ where: { id: { startsWith: userId } } });
  // Delete the chat rows explicitly rather than relying on cascades under the runtime role.
  const own = { in: [userId, `${userId}-other`] };
  await system.externalConversation.deleteMany({ where: { userId: own } });
  await system.threadRead.deleteMany({ where: { threadId: { startsWith: userId } } });
  await system.message.deleteMany({ where: { threadId: { startsWith: userId } } });
  await system.event.deleteMany({ where: { threadId: { startsWith: userId } } });
  await system.thread.deleteMany({ where: { userId } });
  await system.chatGroupMember.deleteMany({ where: { id: { startsWith: userId } } });
  await system.scratchpadItem.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.actionApprovalRule.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.actionAutoReviewPreference.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.spaceSettingOverride.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.spaceModelRoleChoice.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.spaceVoicePreference.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.userActionApprovalRule.deleteMany({ where: { userId: own } });
  await system.userActionAutoReviewPreference.deleteMany({ where: { userId: own } });
  await system.userModelRoleChoice.deleteMany({ where: { userId: own } });
  await system.userVoicePreference.deleteMany({ where: { userId: own } });
  await system.userModelCredential.deleteMany({ where: { userId: own } });
  await system.userVoiceCredential.deleteMany({ where: { userId: own } });
  await system.vaultCredential.deleteMany({ where: { userId: own } });
  await system.messagingChannel.deleteMany({ where: { id: { startsWith: userId } } });
  await system.messagingLinkCode.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.messagingIdentity.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.messagingInstallation.deleteMany({ where: { userId } });
  await system.spaceMember.deleteMany({ where: { userId: own } });
  await system.securityEvent.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.auditEvent.deleteMany({ where: { OR: [{ organizationId: orgId }, { actorId: userId }] } });
  await system.page.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.chatGroup.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.trustedLinkSite.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.payment.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.spendingLimit.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.vaultCredential.deleteMany({ where: { userId } });
  await system.paymentWallet.deleteMany({ where: { userId } });
  await system.bot.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.agentSkillSpace.deleteMany({ where: { userId } });
  await system.mcpServerSpace.deleteMany({ where: { userId } });
  await system.capabilityInstallSpace.deleteMany({ where: { userId } });
  await system.agentSkill.deleteMany({ where: { userId } });
  await system.mcpServer.deleteMany({ where: { userId } });
  await system.capabilityInstall.deleteMany({ where: { userId } });
  await system.secret.deleteMany({ where: { userId } });
  await system.session.deleteMany({ where: { userId } });
  await system.spaceMember.deleteMany({ where: { userId } });
  await system.space.deleteMany({ where: { organizationId: { in: [orgId, `${orgId}-f`] } } });
  await system.organization.deleteMany({ where: { id: `${orgId}-f` } });
  await system.member.deleteMany({ where: { organizationId: orgId } });
  await system.organization.deleteMany({ where: { id: orgId } });
  await system.user.deleteMany({ where: { id: { in: [userId, `${userId}-other`] } } });
}

async function seed(caseIds: ReturnType<typeof ids>): Promise<Seeded> {
  await reset(caseIds);
  await system.user.create({
    data: {
      id: caseIds.userId,
      name: "Contract User",
      email: `${caseIds.userId}@example.test`,
      emailVerified: true,
    },
  });
  await system.organization.create({
    data: {
      id: caseIds.orgId,
      name: "Contract Org",
      slug: `contract-${caseIds.userId}`,
      createdAt: new Date(),
    },
  });
  await system.member.create({
    data: {
      id: `${caseIds.orgId}-m`,
      organizationId: caseIds.orgId,
      userId: caseIds.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  for (const [index, spaceId] of caseIds.spaces.entries()) {
    await system.space.create({
      data: {
        id: spaceId,
        organizationId: caseIds.orgId,
        name: `Space ${index + 1}`,
        isDefault: index === 0,
      },
    });
    await system.spaceMember.create({
      data: {
        id: `${spaceId}-m`,
        spaceId,
        organizationId: caseIds.orgId,
        userId: caseIds.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  await system.session.create({
    data: {
      id: `${caseIds.userId}-session`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      token: caseIds.sessionToken,
      userId: caseIds.userId,
    },
  });
  await system.agentSkill.create({
    data: {
      id: caseIds.skillId,
      spaceId: caseIds.spaces[0],
      userId: caseIds.userId,
      name: caseIds.skillName,
      description: "",
      content: "body",
      source: "user",
    },
  });
  const secret = await system.secret.create({
    data: {
      id: `${caseIds.userId}-secret`,
      userId: caseIds.userId,
      spaceId: caseIds.spaces[0],
      kind: "mcp",
      ciphertext: "sealed",
    },
  });
  await system.mcpServer.create({
    data: {
      id: caseIds.serverId,
      spaceId: caseIds.spaces[0],
      userId: caseIds.userId,
      slug: caseIds.serverSlug,
      name: "Contract server",
      transport: "stdio",
      command: "true",
      secretId: secret.id,
    },
  });
  await system.capabilityInstall.create({
    data: {
      id: caseIds.installId,
      spaceId: caseIds.spaces[0],
      userId: caseIds.userId,
      kind: "plugin",
      name: "Contract plugin",
      source: "test",
      config: {},
    },
  });
  return { ...caseIds, cookie: cookieFor(caseIds.sessionToken) };
}

function called(seeded: Seeded, testCase: Case): Seeded {
  const active = testCase.space === undefined ? seeded : { ...seeded, activeSpace: testCase.space };
  return testCase.anonymous ? { ...active, cookie: "" } : active;
}

function withIds(input: unknown, seeded: ReturnType<typeof ids>) {
  if (input === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(input)
      .replaceAll("__skill__", seeded.skillId)
      .replaceAll("__sp1__", seeded.spaces[0])
      .replaceAll("__sp2__", seeded.spaces[1])
      .replaceAll("__sp3__", seeded.spaces[2])
      .replaceAll("__bot__", `${seeded.userId}-bot`)
      .replaceAll("__group__", `${seeded.userId}-group`)
      .replaceAll("__ba__", `${seeded.userId}-ba`)
      .replaceAll("__bb__", `${seeded.userId}-bb`)
      .replaceAll("__bx__", `${seeded.userId}-bx`)
      .replaceAll("__barch__", `${seeded.userId}-barch`)
      .replaceAll("__grp__", `${seeded.userId}-grp`)
      .replaceAll("__garch__", `${seeded.userId}-garch`)
      .replaceAll("__s1__", `${seeded.userId}-s1`)
      .replaceAll("__s2__", `${seeded.userId}-s2`)
      .replaceAll("__s3__", `${seeded.userId}-s3`)
      .replaceAll("__id1__", `${seeded.userId}-id1`)
      .replaceAll("__id2__", `${seeded.userId}-id2`)
      .replaceAll("__idx__", `${seeded.userId}-idx`)
      .replaceAll("__idsl__", `${seeded.userId}-idsl`)
      .replaceAll("__mb1__", `${seeded.userId}-mb1`)
      .replaceAll("__mb2__", `${seeded.userId}-mb2`)
      .replaceAll("__mbx__", `${seeded.userId}-mbx`)
      .replaceAll("__march__", `${seeded.userId}-march`)
      .replaceAll("__pb1__", `${seeded.userId}-pb1`)
      .replaceAll("__mm1__", `${seeded.userId}-mm1`)
      .replaceAll("__mm2__", `${seeded.userId}-mm2`)
      .replaceAll("__mm3__", `${seeded.userId}-mm3`)
      .replaceAll("__mm4__", `${seeded.userId}-mm4`)
      .replaceAll("__mm5__", `${seeded.userId}-mm5`)
      .replaceAll("__cn1__", `${seeded.userId}-cn1`)
      .replaceAll("__cn2__", `${seeded.userId}-cn2`)
      .replaceAll("__cn3__", `${seeded.userId}-cn3`)
      .replaceAll("__cn4__", `${seeded.userId}-cn4`)
      .replaceAll("__cn5__", `${seeded.userId}-cn5`)
      .replaceAll("__cn6__", `${seeded.userId}-cn6`)
      .replaceAll("__cn7__", `${seeded.userId}-cn7`)
      .replaceAll("__cn8__", `${seeded.userId}-cn8`)
      .replaceAll("__cn9__", `${seeded.userId}-cn9`)
      .replaceAll("__mm6__", `${seeded.userId}-mm6`)
      .replaceAll("__mm7__", `${seeded.userId}-mm7`)
      .replaceAll("__pb4__", `${seeded.userId}-pb4`)
      .replaceAll("__tb1__", `${seeded.userId}-tb1`)
      .replaceAll("__tb2__", `${seeded.userId}-tb2`)
      .replaceAll("__tb3__", `${seeded.userId}-tb3`)
      .replaceAll("__tb4__", `${seeded.userId}-tb4`)
      .replaceAll("__tb5__", `${seeded.userId}-tb5`)
      .replaceAll("__tbarch__", `${seeded.userId}-tbarch`)
      .replaceAll("__tbnone__", `${seeded.userId}-tbnone`)
      .replaceAll("__tbx__", `${seeded.userId}-tbx`)
      .replaceAll("__tbfresh__", `${seeded.userId}-tbfresh`)
      .replaceAll("__tg1__", `${seeded.userId}-tg1`)
      .replaceAll("__tg2__", `${seeded.userId}-tg2`)
      .replaceAll("__tgarch__", `${seeded.userId}-tgarch`)
      .replaceAll("__tgone__", `${seeded.userId}-tgone`)
      .replaceAll("__tgnone__", `${seeded.userId}-tgnone`)
      .replaceAll("__msg5__", `${seeded.userId}-msg5`)
      .replaceAll("__msg0__", `${seeded.userId}-msg0`)
      .replaceAll("__msgother__", `${seeded.userId}-msgother`)
      .replaceAll("__ec1__", `${seeded.userId}-ec1`)
      .replaceAll("__ec2__", `${seeded.userId}-ec2`)
      .replaceAll("__ec3__", `${seeded.userId}-ec3`)
      .replace(/__s-([a-z0-9]+)__/g, (_match, name: string) => `${seeded.userId}-${name}`),
  );
}

const SELECTED_HEADERS = [
  "content-type",
  "cache-control",
  "x-rakazo-build",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "vary",
];

function selectedHeaders(headers: Headers) {
  return Object.fromEntries(SELECTED_HEADERS.map((name) => [name, headers.get(name)]));
}

async function tsCall(procedure: string, input: unknown, seeded: Seeded) {
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    {
      method: "POST",
      headers: callHeaders(seeded),
      body: input === undefined ? undefined : JSON.stringify({ json: input }),
    },
    // Hono reads the socket peer from the Node bindings; this is the loopback hop the Go side sees.
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: selectedHeaders(response.headers),
    body: text ? JSON.parse(text) : null,
  };
}

async function goCall(procedure: string, input: unknown, seeded: Seeded) {
  const response = await fetch(`${GO_URL}/rpc/${procedure.replaceAll(".", "/")}`, {
    method: "POST",
    headers: callHeaders(seeded),
    body: input === undefined ? undefined : JSON.stringify({ json: input }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: selectedHeaders(response.headers),
    body: text ? JSON.parse(text) : null,
  };
}

function callHeaders(seeded: Seeded) {
  return {
    "content-type": "application/json",
    origin: WEB_ORIGIN,
    cookie: seeded.cookie,
    "x-rakazo-space-id": seeded.spaces[seeded.activeSpace ?? 0],
    // What a security event records about the caller.
    "user-agent": "contract-harness/1",
    "x-forwarded-for": "198.51.100.77",
  };
}

const WRITE_PROCEDURES = new Set([
  "spendingLimit.set",
  "botSections.create",
  "botSections.update",
  "botSections.remove",
  "availability.set",
  "availability.chooseForSpace",
  "trustedLinkSites.remove",
]);

const CUID = /^c[0-9a-z]{24}$/;
const LINK_CODE = /^(?:[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}|[A-HJKMNP-TV-Z2-9]{8})$/;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const HARNESS_START = Date.now() - 3_600_000;

/**
 * Ids and times each side generates itself differ run to run. A fresh cuid becomes "<cuid>" and a time
 * since the harness started becomes "<now>", so shape and recency are still compared exactly.
 */
function normalize<T>(value: T): T {
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (CUID.test(node)) return "<cuid>";
      if (LINK_CODE.test(node)) return "<code>";
      // Times near now (link-code expiry is minutes ahead) vary per run; instants days away are the case's own data.
      if (ISO_TIME.test(node) && Date.parse(node) >= HARNESS_START && Date.parse(node) <= Date.now() + 6 * 3_600_000)
        return "<now>";
      return node;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]));
    return node;
  };
  return visit(JSON.parse(JSON.stringify(value))) as T;
}

const realtimeSignals: string[] = [];

/** Runs a call and reports the roster and Space-change signals published while it ran. */
async function observed(settleMs: number, call: () => Promise<any>, seeded: Seeded) {
  realtimeSignals.length = 0;
  const result = await call();
  await sleep(settleMs);
  // Background publishes (TypeScript's and Go's) may still be in flight. Wait until nothing has arrived
  // for a quiet period, with a hard cap, so none can land in the next case's capture; attribution by the
  // case's own ids (below) then makes a stray one impossible to misread.
  const QUIET_MS = 150;
  const CAP_MS = 4000;
  const waitStart = Date.now();
  for (let seen = -1; seen !== realtimeSignals.length && Date.now() - waitStart < CAP_MS; ) {
    seen = realtimeSignals.length;
    await sleep(QUIET_MS);
  }
  // The database may be shared with another run: only signals naming this case's own ids count.
  const own = [seeded.userId, ...seeded.spaces];
  const notifications = realtimeSignals
    .filter((payload) => {
      try {
        const { topic } = JSON.parse(payload) as { topic: string };
        return (
          (topic.startsWith("roster-") || topic.startsWith("space-changes:")) &&
          own.some((id) => topic.endsWith(`:${id}`))
        );
      } catch {
        return false;
      }
    })
    .sort();
  return { ...result, notifications };
}

async function databaseState(seeded: ReturnType<typeof ids>) {
  const skills = await system.agentSkill.findMany({
    where: { userId: seeded.userId },
    select: { id: true, spaceId: true, allSpaces: true },
    orderBy: { id: "asc" },
  });
  const skillSpaces = await system.agentSkillSpace.findMany({
    where: { userId: seeded.userId },
    select: { skillId: true, spaceId: true },
    orderBy: [{ skillId: "asc" }, { spaceId: "asc" }],
  });
  const servers = await system.mcpServer.findMany({
    where: { userId: seeded.userId },
    select: { id: true, spaceId: true, allSpaces: true, secretId: true },
    orderBy: { id: "asc" },
  });
  const serverSpaces = await system.mcpServerSpace.findMany({
    where: { userId: seeded.userId },
    select: { serverId: true, spaceId: true },
    orderBy: [{ serverId: "asc" }, { spaceId: "asc" }],
  });
  const installs = await system.capabilityInstall.findMany({
    where: { userId: seeded.userId },
    select: { id: true, spaceId: true, allSpaces: true, secretId: true },
    orderBy: { id: "asc" },
  });
  const installSpaces = await system.capabilityInstallSpace.findMany({
    where: { userId: seeded.userId },
    select: { installId: true, spaceId: true },
    orderBy: [{ installId: "asc" }, { spaceId: "asc" }],
  });
  const secrets = await system.secret.findMany({
    where: { userId: seeded.userId },
    select: { id: true, spaceId: true },
    orderBy: { id: "asc" },
  });
  const owners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const paymentRows = await system.payment.findMany({
    where: { userId: owners },
    select: { id: true, userId: true, amount: true, currency: true, releasedAt: true },
    orderBy: { id: "asc" },
  });
  // Each side seeds at its own "now"; whether a payment is released is what matters.
  const payments = paymentRows.map(({ releasedAt, ...row }) => ({ ...row, released: releasedAt !== null }));
  const spendingLimits = await system.spendingLimit.findMany({
    where: { userId: owners },
    select: { userId: true, amount: true, currency: true, period: true },
    orderBy: { userId: "asc" },
  });
  const pages = await system.page.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, userId: true, title: true, pinnedAt: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const botSections = await system.botSection.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, userId: true, name: true, position: true },
    orderBy: { id: "asc" },
  });
  const threadReads = await system.threadRead.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { threadId: true, userId: true, spaceId: true, unread: true, lastReadSeq: true, snoozedUntil: true },
    orderBy: [{ threadId: "asc" }, { userId: "asc" }],
  });
  const externalConversations = await system.externalConversation.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, userId: true, teamChatAmbientEnabled: true, teamChatRules: true, automatedSenderPolicies: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const messagingIdentities = await system.messagingIdentity.findMany({
    where: { userId: owners },
    select: { id: true, userId: true, spaceId: true, botId: true, provider: true, address: true, installationId: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const messagingLinkCodes = await system.messagingLinkCode.findMany({
    where: { userId: owners },
    select: { code: true, userId: true, spaceId: true, botId: true, expiresAt: true },
  });
  const messagingMemberships = await system.messagingChannelMember.findMany({
    where: { channelId: { startsWith: seeded.userId } },
    select: { id: true, channelId: true, status: true, identityId: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const agentConnections = await system.agentConnection.findMany({
    where: { id: { startsWith: seeded.userId } },
    select: { id: true, status: true, requestVersion: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const messagingOutbound = await system.messagingOutbound.findMany({
    where: { id: { startsWith: seeded.userId } },
    select: { id: true, idempotencyKey: true, status: true, providerHandle: true },
    orderBy: { id: "asc" },
  });
  const settingsOwners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const scratchpadItems = await system.scratchpadItem.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { title: "asc" }, { notes: "asc" }],
  });
  const approvalRulesAccount = await system.userActionApprovalRule.findMany({
    where: { userId: settingsOwners },
    orderBy: [{ userId: "asc" }, { matchKind: "asc" }, { matchValue: "asc" }, { effect: "asc" }],
  });
  const approvalRulesSpace = await system.actionApprovalRule.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { createdByUserId: "asc" }, { matchKind: "asc" }, { matchValue: "asc" }, { effect: "asc" }],
  });
  const spaceSettingOverrides = await system.spaceSettingOverride.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }, { setting: "asc" }],
  });
  const spaceModelChoices = await system.spaceModelRoleChoice.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }, { role: "asc" }, { position: "asc" }],
  });
  const spaceVoicePreferences = await system.spaceVoicePreference.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }, { credentialId: "asc" }],
  });
  const autoReviewPreferences = await system.actionAutoReviewPreference.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }],
  });
  // Which credentials exist, never what they hold.
  const vaultCredentials = await system.vaultCredential.findMany({
    where: { userId: settingsOwners },
    select: { id: true, userId: true, spaceId: true },
    orderBy: { id: "asc" },
  });
  const trustedLinkSites = await system.trustedLinkSite.findMany({
    where: { userId: { in: [seeded.userId, `${seeded.userId}-other`] } },
    select: { userId: true, site: true },
    orderBy: [{ userId: "asc" }, { site: "asc" }],
  });
  const byJson = (left: unknown, right: unknown) =>
    JSON.stringify(left) < JSON.stringify(right) ? -1 : 1;
  const securityEvents = (await system.securityEvent.findMany({ where: { userId: owners } })).sort(byJson);
  const auditEvents = (
    await system.auditEvent.findMany({
      where: { OR: [{ organizationId: seeded.orgId }, { actorId: seeded.userId }] },
    })
  ).sort(byJson);
  const bots = await system.bot.findMany({
    where: { userId: owners },
    select: { id: true, spaceId: true, archivedAt: true, updatedAt: true, section: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const groups = await system.chatGroup.findMany({
    where: { userId: owners },
    select: { id: true, spaceId: true, archivedAt: true, updatedAt: true, section: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  return {
    skills,
    skillSpaces,
    servers,
    serverSpaces,
    installs,
    installSpaces,
    secrets,
    trustedLinkSites,
    payments,
    spendingLimits,
    botSections,
    pages,
    securityEvents,
    auditEvents,
    bots,
    groups,
    messagingIdentities,
    messagingLinkCodes,
    messagingMemberships,
    agentConnections,
    messagingOutbound,
    threadReads,
    externalConversations,
    scratchpadItems,
    approvalRulesAccount,
    approvalRulesSpace,
    spaceSettingOverrides,
    spaceModelChoices,
    spaceVoicePreferences,
    autoReviewPreferences,
    vaultCredentials,
  };
}

let failures = 0;
for (const testCase of cases) {
  // CASE_FILTER=<regexp> reruns only the matching cases.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
  if (process.env.CASE_FILTER && !new RegExp(process.env.CASE_FILTER).test(testCase.name)) continue;
  const caseIds = ids(testCase.name);
  const input = withIds(testCase.input, caseIds);
  // A write has realtime signals to wait for; a read only needs to show it sent none.
  const settle = WRITE_PROCEDURES.has(testCase.procedure) || testCase.procedure.startsWith("messaging.") ? 400 : 40;

  let seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  const tsResult = await observed(settle, () => run(testCase, tsCall, input, seeded), seeded);
  const tsState = normalize(await databaseState(caseIds));

  seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  const goResult = await observed(settle, () => run(testCase, goCall, input, seeded), seeded);
  const goState = normalize(await databaseState(caseIds));

  try {
    assert.equal(goResult.status, tsResult.status, `${testCase.name}: status`);
    assert.deepEqual(goResult.headers, tsResult.headers, `${testCase.name}: headers`);
    assert.deepEqual(normalize(goResult.body), normalize(tsResult.body), `${testCase.name}: body`);
    assert.deepEqual(goResult.notifications, tsResult.notifications, `${testCase.name}: realtime signals`);
    assert.deepEqual(goState, tsState, `${testCase.name}: database state`);
    console.log(`ok   ${testCase.name} (${tsResult.status})`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
    console.error("typescript:", JSON.stringify(tsResult));
    console.error("go:        ", JSON.stringify(goResult));
  }
  await reset(caseIds);
}

await realtime.end();

go?.kill("SIGTERM");
await handles.stop();
await rm(dataDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} contract case(s) failed`);
  process.exit(1);
}
console.log(`contract: ${cases.length} cases match`);
