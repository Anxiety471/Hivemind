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
const GO_URL = "http://127.0.0.1:3201";

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
    "127.0.0.1:3201",
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
    userId: `ct-${suffix}-u`,
    orgId: `ct-${suffix}-o`,
    spaces: [`ct-${suffix}-s1`, `ct-${suffix}-s2`, `ct-${suffix}-s3`] as [string, string, string],
    skillId: `ct-${suffix}-sk`,
    skillName: `Contract skill ${suffix}`,
    serverId: `ct-${suffix}-sv`,
    serverSlug: `contract-server-${suffix}`,
    installId: `ct-${suffix}-in`,
    sessionToken: `token-${suffix}-${"0".repeat(24)}`,
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
  if (!testCase.paginate) return call(testCase.procedure, input, called(seeded, testCase));
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

async function reset(seeded: ReturnType<typeof ids>) {
  const { userId, orgId } = seeded;
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
  return testCase.anonymous ? { ...seeded, cookie: "" } : seeded;
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
      .replaceAll("__s3__", `${seeded.userId}-s3`),
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
    "x-rakazo-space-id": seeded.spaces[0],
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
      if (ISO_TIME.test(node) && Date.parse(node) >= HARNESS_START) return "<now>";
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
async function observed(settleMs: number, call: () => Promise<any>) {
  realtimeSignals.length = 0;
  const result = await call();
  await sleep(settleMs);
  const notifications = realtimeSignals
    .filter((payload) => {
      try {
        const { topic } = JSON.parse(payload) as { topic: string };
        return topic.startsWith("roster-") || topic.startsWith("space-changes:");
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
  const settle = WRITE_PROCEDURES.has(testCase.procedure) ? 400 : 40;

  let seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  const tsResult = await observed(settle, () => run(testCase, tsCall, input, seeded));
  const tsState = normalize(await databaseState(caseIds));

  seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  const goResult = await observed(settle, () => run(testCase, goCall, input, seeded));
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
