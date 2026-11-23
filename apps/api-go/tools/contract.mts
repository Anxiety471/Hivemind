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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spendingPeriodStart } from "../../../packages/core/src/billing/spending.js";
import { asSystem, contentEncryptionOf } from "../../../packages/db/src/index.js";
import { createApp } from "../../api/src/app.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";
import { laneDCases } from "./contract-lane-d.mts";
import { laneHCases, laneHState } from "./contract-lane-h.mts";
import { laneICases } from "./contract-lane-i.mts";
import { laneJCases, laneJState } from "./contract-lane-j.mts";
import { membershipCases, membershipReset, membershipState } from "./contract-membership.mts";
import { modelsCases } from "./contract-models.mts";
import { spaceRunCases } from "./contract-spaces-runs.mts";
import { routineResumeCases } from "./contract-routine-resume.mts";
import { routineCases } from "./contract-routines.mts";
import { run1Cases } from "./contract-run1.mts";
import { threadAdversarialCases } from "./contract-threads-adversarial.mts";
import { threadGetCases } from "./contract-threads-get.mts";
import { threadMoreCases } from "./contract-threads-more.mts";
import { url1Cases } from "./contract-url1.mts";

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
// Fault-injection only: a second gateway whose table is entirely proxy. One concurrent call in
// CONTRACT_PROXY_ONE_CONCURRENT proves the served_by count rejects a partial proxy window.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const PROXY_PORT = process.env.GO_PROXY_PORT ?? String(Number(GO_PORT) + 2);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
// The gateway's upstream: a bridge to the in-process TypeScript app, so a request Go declines is
// answered the way production's proxy answers it. UPSTREAM_PORT separates runs on one host.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const UPSTREAM_PORT = process.env.UPSTREAM_PORT ?? "3999";
let upstreamHits = 0;
// CONTRACT_EMAIL=1 runs the cases flagged `email` (the server sends email) and skips the others: the two
// sides must agree on whether email delivery is configured, which changes who may accept an invitation.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const EMAIL_ON = process.env.CONTRACT_EMAIL === "1";
/** An email provider that sends nothing: TypeScript only asks whether one is configured. */
const CONTRACT_EMAIL = {
  describe: () => ({ id: "contract-email", transactional: true }),
  send: async () => {},
};

// The inbound address domain bots.emailAddress* read (a server that receives email), and the
// computer quota the restore cases exercise. Test values only; each side sees the same ones.
const INBOUND_EMAIL_DOMAIN = "bots.contract.test";
const INBOUND_EMAIL_SECRET = "contract-inbound-email-secret-0123456789";
// The address a case marked `admin` signs in with; only those cases replace the seeded user's
// email, so me.isAdmin and every other admin gate stay false elsewhere.
const CONTRACT_ADMIN_EMAIL = "contract-admin@example.test";
const MAX_COMPUTERS_PER_USER = "2";
// resolveMaxComputersPerUser reads process.env at call time on the TypeScript side.
process.env.SANDBOX_MAX_COMPUTERS_PER_USER = MAX_COMPUTERS_PER_USER;
// Calls are off unless opted in; the roster's incoming-call read is exercised with them on, on both
// sides (phoneCallSettings reads process.env, and the Go child inherits it).
process.env.PHONE_CALLS_ENABLED = "true";
process.env.PHONE_CALL_RING_SECONDS = "45";

export type Seeded = {
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

export type Case = {
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
  /** The API sets no order on the list (Prisma's findMany without orderBy): compare it by id. */
  unordered?: boolean;
  /**
   * A string result whose concatenated parts have no order either (memory.exportMarkdown joins
   * rows with no ORDER BY): compare the parts as a set, split at the `\n\n# ` boundary.
   */
  unorderedSections?: boolean;
  /** Runs only with CONTRACT_EMAIL=1 (email delivery configured on both sides); otherwise only without it. */
  email?: boolean;
  /** Signs the seeded user in as CONTRACT_ADMIN_EMAIL, for admin-only procedures. */
  admin?: boolean;
  /**
   * Pause between the two sides' windows so a TypeScript background job's Space changes (the
   * in-process wakeup queue may finish a restored routine seconds after the response; the Go
   * side only enqueues its job and nothing executes it here) land in neither window.
   */
  gapMs?: number;
  /**
   * Skip the realtime-signal comparison: a procedure that creates a board or ticket with a
   * database-generated id publishes a frame whose payload necessarily names different ids on
   * the two sides, while the response body is comparable through normalize().
   */
  ignoreSignals?: boolean;
  /**
   * For a procedure that may decline: true when Go must hand the request to TypeScript (the upstream
   * bridge sees it), false when Go must answer it itself. Unset skips the check.
   */
  declines?: boolean;
  /** Run this many identical calls concurrently; results are compared as a sorted list of status/body. */
  concurrent?: number;
  /** Extra evidence checked immediately after each side's request, before the next seed resets rows. */
  check?: (context: {
    seeded: Seeded;
    result: { status: number; headers: unknown; body: any; notifications?: unknown[] };
    side: "ts" | "go";
    gatewayLog: string;
  }) => void | Promise<void>;
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
  encryptionKey: CONTRACT_ENCRYPTION_KEY,
  screenProxySecret: "contract-test-screen-secret-0123456789abcdef",
  webOrigin: WEB_ORIGIN,
  authUrl: WEB_ORIGIN,
  nodeEnv: "test",
  signupsEnabled: "true",
  agentRuntime: "scripted",
  adminEmails: [CONTRACT_ADMIN_EMAIL],
  // The same inbound-email configuration the Go child gets through the environment.
  inboundEmail: { domain: INBOUND_EMAIL_DOMAIN, secret: INBOUND_EMAIL_SECRET },
  sandboxProvider: "fake",
  wakeupDriver: "memory",
  ...(EMAIL_ON ? { email: CONTRACT_EMAIL } : {}),
} as never);
const system = asSystem(handles.prisma);

const upstreamServer = createServer(async (incoming, outgoing) => {
  upstreamHits += 1;
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && name !== "host" && name !== "content-length")
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = Buffer.concat(chunks);
  const response = await handles.app.request(
    incoming.url ?? "/",
    { method: incoming.method, headers, body: body.length > 0 ? body : undefined },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const answer: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    answer[name] = value;
  });
  outgoing.writeHead(response.status, answer);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) =>
  upstreamServer.listen(Number(UPSTREAM_PORT), "127.0.0.1", resolve),
);

let go: ChildProcess | undefined;
let proxyGo: ChildProcess | undefined;
// The Go side's stderr/stdout for the current request window. URL cases use this to prove a share
// token is never logged, while still passing the lines through to the harness output.
let gatewayLog = "";
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
      "threads.get": { mode: "go", readOnly: true },
      "threads.messages": { mode: "go", readOnly: true },
      "threads.markRead": { mode: "go" },
      "threads.markUnread": { mode: "go" },
      "threads.snooze": { mode: "go" },
      "spaces.list": { mode: "go", readOnly: true },
      "runs.list": { mode: "go", readOnly: true },
      "externalConversations.updatePolicy": { mode: "go" },
      "scratchpad.list": { mode: "go", readOnly: true },
      "scratchpad.create": { mode: "go" },
      "scratchpad.update": { mode: "go" },
      "scratchpad.remove": { mode: "go" },
      "approvalRules.list": { mode: "go", readOnly: true },
      "approvalRules.set": { mode: "go" },
      "spaceSettings.overrides": { mode: "go", readOnly: true },
      "connections.list": { mode: "go", readOnly: true },
      "connections.rename": { mode: "go" },
      "capabilities.list": { mode: "go", readOnly: true },
      "usage.list": { mode: "go", readOnly: true },
      "usage.summary": { mode: "go", readOnly: true },
      "computer.updates": { mode: "go", readOnly: true },
      "mcp.assignments.all": { mode: "go", readOnly: true },
      "mcp.assignments.list": { mode: "go", readOnly: true },
      "mcp.assignments.approve": { mode: "go" },
      "models.backups": { mode: "go", readOnly: true },
      "models.role": { mode: "go", readOnly: true },
      "models.setRole": { mode: "go" },
      "spaces.rename": { mode: "go" },
      "spaces.members.list": { mode: "go", readOnly: true },
      "spaces.members.add": { mode: "go" },
      "spaces.invites.preview": { mode: "go", readOnly: true },
      "spaces.invites.accept": { mode: "go" },
      "spaces.invites.cancel": { mode: "go" },
      "organizations.list": { mode: "go", readOnly: true },
      "organizations.rename": { mode: "go" },
      "organizations.members.list": { mode: "go", readOnly: true },
      "organizations.invitations.preview": { mode: "go", readOnly: true },
      "models.rename": { mode: "go" },
      "pages.rename": { mode: "go" },
      "pages.pin": { mode: "go" },
      "artifacts.list": { mode: "go", readOnly: true },
      "artifacts.listSpace": { mode: "go", readOnly: true },
      "artifacts.listVersions": { mode: "go", readOnly: true },
      "bots.list": { mode: "go", readOnly: true },
      "bots.listArchived": { mode: "go", readOnly: true },
      "bots.get": { mode: "go", readOnly: true },
      "groups.list": { mode: "go", readOnly: true },
      "groups.get": { mode: "go", readOnly: true },
      "groups.listArchived": { mode: "go", readOnly: true },
      "bots.reorder": { mode: "go" },
      "bots.restore": { mode: "go" },
      "bots.removePreview": { mode: "go", readOnly: true },
      "bots.emailAddress": { mode: "go", readOnly: true },
      "bots.emailAddresses": { mode: "go", readOnly: true },
      "bots.claimEmailAddress": { mode: "go" },
      "memory.providerConfig": { mode: "go", readOnly: true },
      "memory.setDefaultScope": { mode: "go" },
      "groups.restore": { mode: "go" },
      "routines.listForMentions": { mode: "go", readOnly: true },
      "routines.list": { mode: "go", readOnly: true },
      "routines.testRun": { mode: "go" },
      "routines.history": { mode: "go", readOnly: true },
      "agentSkills.list": { mode: "go", readOnly: true },
      "agentSkills.get": { mode: "go", readOnly: true },
      "agentSkills.remove": { mode: "go" },
      "memory.list": { mode: "go", readOnly: true },
      "memory.budget": { mode: "go", readOnly: true },
      "memory.exportMarkdown": { mode: "go", readOnly: true },
      "memory.update": { mode: "go" },
      "memory.remove": { mode: "go" },
      "onboarding.promptFocus": { mode: "go" },
      "onboarding.dismissFocus": { mode: "go" },
      "computer.commands": { mode: "go", readOnly: true },
      "tickets.move": { mode: "go" },
      "tickets.comment": { mode: "go" },
      "tickets.list": { mode: "go", readOnly: true },
      "tickets.get": { mode: "go", readOnly: true },
      "tickets.create": { mode: "go" },
      "tickets.update": { mode: "go" },
      "tickets.decide": { mode: "go" },
      "skills.updateDraft": { mode: "go" },
      "skills.save": { mode: "go" },
      "organizations.members.setRole": { mode: "go" },
      "organizations.invitations.cancel": { mode: "go" },
      "bots.templates": { mode: "go", readOnly: true },
      "skills.list": { mode: "go", readOnly: true },
      "skills.testRun": { mode: "go" },
      "onboarding.start": { mode: "go", readOnly: true },
      "agentSecrets.list": { mode: "go", readOnly: true },
      "audit.events": { mode: "go", readOnly: true },
      "vault.activity": { mode: "go", readOnly: true },
      "bots.rotateWebhookSecret": { mode: "go" },
      "vault.list": { mode: "go", readOnly: true },
      "botSecrets.list": { mode: "go", readOnly: true },
      "mcp.servers.list": { mode: "go", readOnly: true },
      "models.credentials": { mode: "go", readOnly: true },
      "bots.revealWebhookSecret": { mode: "go", readOnly: true },
      "pages.remove": { mode: "go" },
      "computer.dismissUpdate": { mode: "go" },
      "computer.dismissDiskWarning": { mode: "go" },
      "boards.list": { mode: "go" },
      "boards.get": { mode: "go" },
      "boards.rename": { mode: "go" },
      "integrationSetup.get": { mode: "go", readOnly: true },
      "marketplace.submissions": { mode: "go", readOnly: true },
      "pages.setVisibility": { mode: "go" },
    },
  }),
);
type RouteConfig = { default?: string; routes?: Record<string, { mode?: string }> };
const routeConfig = JSON.parse(await readFile(routesFile, "utf8")) as RouteConfig;
const routeMode = (procedure: string) =>
  routeConfig.routes?.[procedure]?.mode ?? routeConfig.default ?? "proxy";

/** Count this procedure's local answers in the captured gateway log. */
function servedByGoCount(log: string, procedure: string) {
  const procedureField = `"procedure":${JSON.stringify(procedure)}`;
  return log
    .split("\n")
    .filter((line) => line.includes('"served_by":"go"') && line.includes(procedureField)).length;
}
process.on("uncaughtException", (error) => {
  go?.kill("SIGKILL");
  proxyGo?.kill("SIGKILL");
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  go?.kill("SIGKILL");
  proxyGo?.kill("SIGKILL");
  console.error(error);
  process.exit(1);
});
const gatewayEnv = {
  ...process.env,
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: WEB_ORIGIN,
  WEB_ORIGIN,
  // The credential store both sides seal with. The same test key the TypeScript app uses.
  ENCRYPTION_KEY: CONTRACT_ENCRYPTION_KEY,
  CONTENT_ENCRYPTION: "on",
  MAX_UPLOAD_SIZE_MB: "10",
  // Email delivery is configured when SMTP_URL is: the same variables TypeScript reads.
  SMTP_URL: EMAIL_ON ? "smtp://127.0.0.1:2525" : "",
  EMAIL_PROVIDER: "",
  EMAIL_EMULATOR: "",
  // The inbound domain bots.emailAddress* read, and the restore quota, as on the TypeScript side.
  INBOUND_EMAIL_DOMAIN,
  INBOUND_EMAIL_SECRET,
  RAKAZO_ADMIN_EMAILS: CONTRACT_ADMIN_EMAIL,
  SANDBOX_MAX_COMPUTERS_PER_USER: MAX_COMPUTERS_PER_USER,
  PHONE_CALLS_ENABLED: "true",
  PHONE_CALL_RING_SECONDS: "45",
};
go = spawn(
  GO_BINARY,
  [
    "-listen",
    `127.0.0.1:${GO_PORT}`,
    "-upstream",
    `http://127.0.0.1:${UPSTREAM_PORT}`,
    "-routes",
    routesFile,
    "-build-id-file",
    BUILD_ID_FILE,
  ],
  { env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] },
);
const captureGateway = (chunk: Buffer) => {
  gatewayLog += chunk.toString();
  process.stdout.write(chunk);
};
go.stdout?.on("data", captureGateway);
go.stderr?.on("data", captureGateway);
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

// Fault-injection only. A second gateway with an empty route table answers entirely through the
// TypeScript upstream; CONTRACT_PROXY_ONE_CONCURRENT sends one of a concurrent case's Go calls
// here, so the served_by:go count must reject the partially proxied window.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
if (process.env.CONTRACT_PROXY_ONE_CONCURRENT === "1") {
  const proxyRoutesFile = join(dataDir, "routes-proxy.json");
  await writeFile(proxyRoutesFile, JSON.stringify({ default: "proxy", routes: {} }));
  proxyGo = spawn(
    GO_BINARY,
    [
      "-listen",
      `127.0.0.1:${PROXY_PORT}`,
      "-upstream",
      `http://127.0.0.1:${UPSTREAM_PORT}`,
      "-routes",
      proxyRoutesFile,
      "-build-id-file",
      BUILD_ID_FILE,
    ],
    { env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const captureProxyGateway = (chunk: Buffer) => process.stderr.write(chunk);
  proxyGo.stdout?.on("data", captureProxyGateway);
  proxyGo.stderr?.on("data", captureProxyGateway);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${PROXY_URL}/healthz`);
      if (response.ok) break;
    } catch {
      // still starting
    }
    if (attempt === 99) throw new Error("fault proxy gateway did not start");
    await sleep(50);
  }
}

// A listener on the realtime channel: TypeScript and Go must publish identical signals.
const databaseRequire = createRequire(
  new URL("../../../packages/db/package.json", import.meta.url),
);
type PgClientLike = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: { payload?: string }) => void): void;
};
const { Client: PgClient } = databaseRequire("pg") as {
  Client: new (options: { connectionString: string }) => PgClientLike;
};
const realtime = new PgClient({ connectionString: DATABASE_URL });
await realtime.connect();
await realtime.query("LISTEN rakazo_events");
// Declared before the listener: a notification can arrive the moment LISTEN is issued.
const realtimeSignals: string[] = [];
realtime.on("notification", (notification: { payload?: string }) => {
  if (notification.payload) realtimeSignals.push(notification.payload);
});

// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
const OWNER_URL = process.env.DATABASE_MIGRATION_URL;
const owner = OWNER_URL ? new PgClient({ connectionString: OWNER_URL }) : undefined;
await owner?.connect();

// Fixed once per run: both sides of a case must seed identical times.
const THREAD_PAST = new Date(Date.now() - 2 * 3_600_000);
const THREAD_FUTURE = new Date(Date.now() + 30 * 86_400_000);
// Reset at the start of each case (both sides of a case share it, so they seed identical times). It must be
// recent when the case runs: the API's reconciler treats an old queued or running update as abandoned.
let COMPUTER_UPDATE_BASE = Date.now() - 30_000;

/** What the web app reloads right after a read-state change. */
const AFTER = [
  { procedure: "bots.list", input: {} },
  { procedure: "groups.list", input: {} },
  { procedure: "spaces.list", input: {} },
];

const SCRATCH_AFTER = [
  { procedure: "scratchpad.list", input: { botId: "__s-tb1__", includeDone: true } },
];

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
  {
    name: "set-invalid-kind",
    procedure: "availability.set",
    input: { kind: "bogus", id: "__skill__", allSpaces: false, spaceIds: ["__sp1__"] },
  },
  { name: "set-invalid-missing-all", procedure: "availability.set", input: {} },
  {
    name: "set-invalid-types",
    procedure: "availability.set",
    input: { kind: 5, id: 7, allSpaces: "no", spaceIds: "x" },
  },
  {
    name: "set-invalid-empty-id",
    procedure: "availability.set",
    input: { kind: "skill", id: "", allSpaces: false, spaceIds: [""] },
  },
  {
    name: "choose-invalid-kind",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "__sp1__", items: [{ kind: "bogus", id: "x" }] },
  },
  {
    name: "choose-invalid-types",
    procedure: "availability.chooseForSpace",
    input: { spaceId: 5, items: "x" },
  },
  {
    name: "choose-invalid-empty",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "", items: [{ kind: "skill", id: "" }] },
  },
  { name: "set-invalid-array-input", procedure: "availability.set", input: [] },
  { name: "set-invalid-null-input", procedure: "availability.set", input: null },
  { name: "set-invalid-no-input", procedure: "availability.set", input: undefined },
  {
    name: "set-invalid-spaceids-mixed",
    procedure: "availability.set",
    input: { kind: "skill", id: "__skill__", allSpaces: false, spaceIds: [1, "", null, "ok"] },
  },
  {
    name: "set-invalid-spaceids-empty-and-id",
    procedure: "availability.set",
    input: { kind: "skill", id: "", allSpaces: true, spaceIds: [] },
  },
  {
    name: "set-invalid-id-array",
    procedure: "availability.set",
    input: { kind: "skill", id: [], allSpaces: true, spaceIds: ["__sp1__"] },
  },
  {
    name: "set-invalid-extra-keys-ok",
    procedure: "availability.set",
    input: { kind: "skill", id: "missing", allSpaces: true, spaceIds: ["__sp1__"], more: 1 },
  },
  { name: "choose-invalid-array-input", procedure: "availability.chooseForSpace", input: [] },
  { name: "choose-invalid-no-input", procedure: "availability.chooseForSpace", input: undefined },
  {
    name: "choose-invalid-items-mixed",
    procedure: "availability.chooseForSpace",
    input: {
      spaceId: "__sp1__",
      items: [1, null, [], {}, { kind: "skill" }, { kind: "skill", id: "x" }],
    },
  },
  {
    name: "choose-invalid-too-many",
    procedure: "availability.chooseForSpace",
    input: {
      spaceId: "__sp1__",
      items: Array.from({ length: 501 }, () => ({ kind: "skill", id: "x" })),
    },
  },
  {
    name: "choose-invalid-too-many-and-bad",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "", items: Array.from({ length: 501 }, () => ({ kind: "bogus", id: "" })) },
  },
  {
    name: "choose-invalid-items-missing",
    procedure: "availability.chooseForSpace",
    input: { spaceId: "__sp1__" },
  },
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
  ...connectionCases(),
  ...capabilityCases(),
  ...usageCases(),
  ...computerUpdateCases(),
  ...mcpAssignmentCases(),
  ...modelBackupCases(),
  ...membershipCases(system),
  ...pageWriteCases(),
  ...url1Cases(system),
  ...modelRenameCases(),
  ...artifactCases(),
  ...laneDCases(system),
  ...routineResumeCases(system),
  ...routineCases(system),
  ...run1Cases(system),
  ...memoryCases(),
  ...laneGCases(),
  ...laneGCases2(),
  ...laneHCases(system),
  ...laneICases(system),
  ...laneJCases(system),
  ...modelsCases(system),
  ...threadGetCases(system),
  ...spaceRunCases(system),
  ...threadAdversarialCases(system),
  ...threadMoreCases(system),
];

// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
if (process.env.CONTRACT_ROUTE_AUDIT === "1") {
  const silentlyProxied = cases.filter((testCase) => {
    const mode = routeMode(testCase.procedure);
    return mode !== "go" && mode !== "shadow";
  });
  console.log(
    `route audit: ${cases.length} cases; ${silentlyProxied.length} not routed go/shadow`,
  );
  for (const testCase of silentlyProxied)
    console.log(
      `route audit: ${testCase.name} (${testCase.procedure}) -> ${routeMode(testCase.procedure)}`,
    );
  go?.kill("SIGKILL");
  proxyGo?.kill("SIGKILL");
  upstreamServer.close();
  await handles.stop();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(silentlyProxied.length > 0 ? 1 : 0);
}

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
    {
      name: "sites-list-no-input",
      procedure: "trustedLinkSites.list",
      input: undefined,
      seed: seedSites,
    },
    {
      name: "sites-list-anonymous",
      procedure: "trustedLinkSites.list",
      input: {},
      anonymous: true,
    },
    remove("sites-remove", { site: "alpha.example" }, { seed: seedSites }),
    remove("sites-remove-other-users-only", { site: "other-only.example" }, { seed: seedSites }),
    remove("sites-remove-absent", { site: "absent.example" }, { seed: seedSites }),
    remove(
      "sites-remove-ignores-extra-keys",
      { site: "zeta.example", more: 1 },
      { seed: seedSites },
    ),
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
    remove(
      "sites-remove-anonymous",
      { site: "alpha.example" },
      { seed: seedSites, anonymous: true },
    ),
  ];
}

function ids(caseName: string) {
  const suffix = caseName.replace(/[^a-z0-9]/g, "");
  return {
    userId: `ct${RUN_TAG}-${suffix}-u`,
    orgId: `ct${RUN_TAG}-${suffix}-o`,
    spaces: [
      `ct${RUN_TAG}-${suffix}-s1`,
      `ct${RUN_TAG}-${suffix}-s2`,
      `ct${RUN_TAG}-${suffix}-s3`,
    ] as [string, string, string],
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
type SpendingContext = {
  seeded: Seeded;
  now: Date;
  startOf: (period: "day" | "week" | "month") => Date;
};

function seedSpending(config: SpendingSeed = {}) {
  return async (seeded: Seeded) => {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    if (config.timezone) {
      await system.user.update({
        where: { id: seeded.userId },
        data: { timezone: config.timezone },
      });
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
        data: {
          id: `${seeded.userId}-own-bot`,
          spaceId: seeded.spaces[1],
          userId: seeded.userId,
          name: "Own bot",
          color: "blue",
        },
      });
      await system.bot.create({
        data: {
          id: `${seeded.userId}-foreign-bot`,
          spaceId: foreignSpace,
          userId: other,
          name: "Foreign bot",
          color: "red",
        },
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
        // Ids are per case, not the short literals the configs name: a pass aborted mid-case leaves
        // an earlier run's row behind, and reset can only delete rows it knows this case owns.
        const id = `${seeded.userId}-${payment.id}`;
        await system.payment.create({
          data: {
            id,
            operationKey: id,
            userId: payment.owner === "other" ? other : seeded.userId,
            spaceId: seeded.spaces[0],
            botId: payment.botId,
            threadId: "thread",
            site: `shop-${id}.example`,
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
      {
        id: "in2",
        botId: "b",
        currency: "usd",
        amount: 30,
        createdAt: new Date(ctx.now.getTime() - 1000),
      },
      { id: "out", botId: "b", currency: "usd", amount: 7, createdAt: new Date(start - 1000) },
      { id: "eur", botId: "b", currency: "eur", amount: 55, createdAt: new Date(start + 1000) },
      {
        id: "rel",
        botId: "b",
        currency: "usd",
        amount: 9,
        createdAt: new Date(start + 1000),
        released: true,
      },
      {
        id: "oth",
        owner: "other" as const,
        botId: "b",
        currency: "usd",
        amount: 11,
        createdAt: new Date(start + 1000),
      },
    ];
  };
  return [
    {
      name: "spend-pay-empty",
      procedure: "spendingLimit.payments",
      input: {},
      seed: seedSpending({
        bots: true,
        payments: () => [
          {
            id: "x",
            owner: "other",
            botId: "b",
            currency: "usd",
            amount: 1,
            createdAt: new Date(0),
          },
        ],
      }),
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
            {
              id: "p1",
              botId: `${seeded.userId}-own-bot`,
              currency: "usd",
              amount: 500,
              createdAt: new Date(t),
            },
            {
              id: "p2",
              botId: `${seeded.userId}-foreign-bot`,
              currency: "eur",
              amount: 700,
              createdAt: new Date(t + hour),
            },
            {
              id: "p3",
              botId: "gone",
              currency: "usd",
              amount: 900,
              createdAt: new Date(t + 2 * hour),
            },
            {
              id: "p4",
              botId: `${seeded.userId}-own-bot`,
              currency: "usd",
              amount: 100,
              createdAt: new Date(t + 3 * hour),
              released: true,
            },
            {
              id: "p5",
              botId: `${seeded.userId}-own-bot`,
              currency: "ils",
              amount: 300,
              createdAt: new Date(t + hour),
            },
            {
              id: "px",
              owner: "other",
              botId: `${seeded.userId}-own-bot`,
              currency: "usd",
              amount: 111,
              createdAt: new Date(t),
            },
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
    {
      name: "spend-pay-no-input",
      procedure: "spendingLimit.payments",
      input: undefined,
      seed: seedSpending({ bots: true }),
    },
    {
      name: "spend-pay-zero-amount-fails-the-output-check",
      procedure: "spendingLimit.payments",
      input: {},
      seed: seedSpending({
        bots: true,
        payments: ({ now }) => [
          { id: "zero", botId: "b", currency: "usd", amount: 0, createdAt: now },
        ],
      }),
    },
    {
      name: "spend-pay-anonymous",
      procedure: "spendingLimit.payments",
      input: {},
      anonymous: true,
    },
    get("nothing", seedSpending()),
    get("no-input", seedSpending(), { input: undefined }),
    get("anonymous", seedSpending(), { anonymous: true }),
    get("card-account", seedSpending({ card: "account" })),
    get("card-other-space", seedSpending({ card: "other-space" })),
    get("login-only", seedSpending({ card: "login" })),
    get("wallet-pending", seedSpending({ wallet: "pending" })),
    get("wallet-connected", seedSpending({ wallet: "connected" })),
    get(
      "paid-no-limit",
      seedSpending({
        payments: ({ now }) => [
          { id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now },
        ],
      }),
    ),
    get(
      "paid-released-only",
      seedSpending({
        payments: ({ now }) => [
          { id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now, released: true },
        ],
      }),
    ),
    get(
      "day-utc",
      seedSpending({
        limit: { amount: 1000, currency: "usd", period: "day" },
        payments: around("day"),
      }),
    ),
    get(
      "day-no-payments",
      seedSpending({ limit: { amount: 1000, currency: "usd", period: "day" } }),
    ),
    get(
      "week-auckland",
      seedSpending({
        timezone: "Pacific/Auckland",
        limit: { amount: 2000, currency: "usd", period: "week" },
        payments: around("week"),
      }),
    ),
    get(
      "month-new-york-lowercase",
      seedSpending({
        timezone: "america/new_york",
        limit: { amount: 3000, currency: "usd", period: "month" },
        payments: around("month"),
      }),
    ),
    get(
      "day-kiritimati",
      seedSpending({
        timezone: "Pacific/Kiritimati",
        limit: { amount: 1000, currency: "eur", period: "day" },
        payments: around("day"),
      }),
    ),
    get(
      "day-unknown-timezone",
      seedSpending({
        timezone: "No/Such_Zone",
        limit: { amount: 1000, currency: "usd", period: "day" },
        payments: around("day"),
      }),
    ),
    get(
      "none-since-start",
      seedSpending({
        limit: {
          amount: 1000,
          currency: "usd",
          period: "none",
          startsAt: new Date(Date.now() - 48 * hour),
        },
        payments: ({ now }) => [
          {
            id: "old",
            botId: "b",
            currency: "usd",
            amount: 3,
            createdAt: new Date(now.getTime() - 72 * hour),
          },
          {
            id: "new",
            botId: "b",
            currency: "usd",
            amount: 4,
            createdAt: new Date(now.getTime() - 24 * hour),
          },
        ],
      }),
    ),
    get(
      "invalid-stored-limit",
      seedSpending({
        limit: { amount: 0, currency: "jpy", period: "hourly" },
        payments: ({ now }) => [
          { id: "a", botId: "b", currency: "usd", amount: 5, createdAt: now },
        ],
      }),
    ),
    get(
      "oversized-stored-limit",
      seedSpending({
        limit: { amount: 2_000_000_000, currency: "gbp", period: "day" },
        payments: around("day"),
      }),
    ),
    get(
      "limit-with-card",
      seedSpending({ card: "account", limit: { amount: 100, currency: "ils", period: "week" } }),
    ),
    get(
      "negative-spent-fails-the-output-check",
      seedSpending({
        limit: { amount: 1000, currency: "usd", period: "week" },
        payments: ({ now }) => [
          { id: "neg", botId: "b", currency: "usd", amount: -7, createdAt: now },
        ],
      }),
    ),
  ];
}

function botSectionCases(): Case[] {
  const base = Date.UTC(2026, 4, 1, 12, 0, 0, 456);
  const seedSections = (extra?: Case["seed"]) => async (seeded: Seeded) => {
    const other = `${seeded.userId}-other`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    const make = (
      id: string,
      spaceId: string,
      userId: string,
      name: string,
      position: number,
      offset: number,
    ) =>
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
    {
      name: "sections-list-no-input",
      procedure: "botSections.list",
      input: undefined,
      seed: seedSections(),
    },
    {
      name: "sections-list-ignores-input",
      procedure: "botSections.list",
      input: { anything: 1 },
      seed: seedSections(),
    },
    {
      name: "sections-list-negative-position-fails-the-output-check",
      procedure: "botSections.list",
      input: {},
      seed: seedSections(async (seeded) => {
        await system.botSection.create({
          data: {
            id: `${seeded.userId}-neg`,
            spaceId: seeded.spaces[0],
            userId: seeded.userId,
            name: "Negative",
            position: -1,
            createdAt: new Date(base),
            updatedAt: new Date(base),
          },
        });
      }),
    },
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
    extra: {
      pinned?: number;
      botId?: string;
      groupId?: string;
      spaceId?: string;
      userId?: string;
      visibility?: string;
      version?: number;
    } = {},
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
  await page("pb", "Beta pinned", PAGE_BASE - 48 * hour, {
    pinned: PAGE_BASE - 2 * hour,
    visibility: "link",
    version: 3,
  });
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
    const section = (
      id: string,
      spaceId: string,
      userId: string,
      name: string,
      position: number,
      offset: number,
    ) =>
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
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: user,
          name,
          color: "blue",
          updatedAt: old,
          ...extra,
        },
      });
    await bot("ba", seeded.spaces[0], "Bot A");
    await bot(
      "bb",
      seeded.spaces[0],
      "Bot B",
      config.noSections ? {} : { sectionId: `${user}-s2` },
    );
    await bot("bx", seeded.spaces[1], "Bot X");
    await bot("barch", seeded.spaces[0], "Bot archived", { archivedAt: old });
    const group = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      system.chatGroup.create({
        data: {
          id: `${user}-${id}`,
          spaceId: seeded.spaces[0],
          userId: user,
          name,
          updatedAt: old,
          ...extra,
        },
      });
    await group("grp", "Group", config.noSections ? {} : { sectionId: `${user}-s2` });
    await group("garch", "Group archived", { archivedAt: old });
    if (config.deleting) {
      await system.space.update({
        where: { id: seeded.spaces[0] },
        data: { deletingAt: new Date() },
      });
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
    create(
      "bot-new-empty-space",
      { botId: "__ba__", name: "Fresh" },
      { seed: seedWrites({ noSections: true }) },
    ),
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
    create(
      "space-deleting",
      { botId: "__ba__", name: "x" },
      { seed: seedWrites({ deleting: true }) },
    ),
    create(
      "space-deleting-unknown-bot",
      { botId: "nope", name: "x" },
      { seed: seedWrites({ deleting: true }) },
    ),
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
    update(
      "space-deleting-rename",
      { sectionId: "__s1__", name: "Office" },
      { seed: seedWrites({ deleting: true }) },
    ),
    update(
      "space-deleting-same-name",
      { sectionId: "__s1__", name: "Work" },
      { seed: seedWrites({ deleting: true }) },
    ),
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
  const set = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `sls-${name}`,
    procedure: "spendingLimit.set",
    input,
    seed: seed ?? seedSpending(),
    ...extra,
  });
  const long = new Date(Date.UTC(2020, 0, 1));
  const limit = (amount: number, currency: string, period: string) => ({
    limit: { amount, currency, period },
  });
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
        payments: ({ now }) => [
          {
            id: "a",
            botId: "b",
            currency: "usd",
            amount: 70,
            createdAt: new Date(now.getTime() - 1000),
          },
        ],
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
    set("amount-unsafe", limit(Number.MAX_SAFE_INTEGER + 1, "usd", "day")),
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
    set("both-extra-keys", {
      limit: { amount: 0, currency: "usd", period: "day", more: 1 },
      other: 1,
    }),
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
  /** A membership or connection whose stored status sits outside the output schema. */
  oddMembership?: boolean;
  oddConnection?: boolean;
};

function seedMessaging(config: MessagingSeed = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = `${user}-other`;
    await system.user.create({
      data: {
        id: other,
        name: config.ownerName ?? "Jane Quinn",
        email: `${other}@example.test`,
        emailVerified: true,
      },
    });
    const old = new Date(Date.UTC(2020, 0, 1));
    const base = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
    const bot = (
      id: string,
      spaceId: string,
      owner: string,
      name: string,
      extra: Record<string, unknown> = {},
    ) =>
      system.bot.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: owner,
          name,
          color: "blue",
          updatedAt: old,
          ...extra,
        },
      });
    await bot("mb1", seeded.spaces[0], user, "My bot one");
    await bot("mb2", seeded.spaces[0], user, "My bot two");
    await bot("mbx", seeded.spaces[1], user, "My bot in space two");
    await bot("march", seeded.spaces[0], user, "My archived bot", { archivedAt: old });
    await bot("pb1", seeded.spaces[1], other, "Peer bot one");
    await bot("pb2", seeded.spaces[1], other, "Peer bot two");
    await bot("pb3", seeded.spaces[1], other, "Peer bot three");
    await bot("pb4", seeded.spaces[0], other, "Peer bot in space one");
    const identity = (
      id: string,
      owner: string,
      spaceId: string,
      botId: string,
      extra: Record<string, unknown> = {},
    ) =>
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
        data: {
          id: `${user}-mb5`,
          spaceId: seeded.spaces[1],
          userId: user,
          name: "Slack bot",
          color: "blue",
          updatedAt: old,
        },
      });
      await identity("idsl", user, seeded.spaces[1], "mb5", { installationId: installation.id });
    }
    if (config.existingCode) {
      await system.messagingLinkCode.create({
        data: {
          id: `${user}-oldcode`,
          code: "AAAAAAAA",
          userId: user,
          spaceId: seeded.spaces[0],
          botId: `${user}-mb2`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    if (!config.noChannels) {
      const channel = (id: string, name: string | null, threadId: string) =>
        system.messagingChannel.create({
          data: {
            id: `${user}-${id}`,
            provider: "telegram",
            name,
            threadId: `${user}-${threadId}`,
          },
        });
      await channel("cn1", "Team", "th1");
      await channel("cn2", null, "th2");
      await channel("cn3", "Other people", "th3");
      const member = (
        id: string,
        channelId: string,
        address: string,
        identityId: string | null,
        status: string,
        offset: number,
      ) =>
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
      if (config.oddMembership) await member("mm8", "cn2", "a8", "id1", "weird", 8000);
    }
    if (!config.noConnections) {
      const connection = (
        id: string,
        requester: string,
        target: string,
        status: string,
        offset: number,
      ) =>
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
      if (config.oddConnection) await connection("cn11", "mb2", "pb1", "weird", 8000);
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
        data: {
          id: `${user}-ob2`,
          idempotencyKey: `connect:other:${user}`,
          kind: "dm",
          body: "unrelated",
          status: "pending",
        },
      });
    }
  };
}

function messagingCases(): Case[] {
  const mk =
    (procedure: string, label: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
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
  const outbound = (status: string, providerHandle?: string) =>
    seedMessaging({ outbound: { status, providerHandle } });
  return [
    link("new", { botId: "__mb1__" }),
    link(
      "second-bot-supersedes",
      { botId: "__mb2__" },
      { seed: seedMessaging({ existingCode: true }) },
    ),
    link("bot-in-shared-space", { botId: "__mbx__" }),
    link("already-linked", { botId: "__mb1__" }),
    link("unknown-bot", { botId: "nope" }),
    link("archived-bot", { botId: "__march__" }),
    link("peer-bot-not-mine", { botId: "__pb1__" }),
    link(
      "no-identities-new",
      { botId: "__mb1__" },
      { seed: seedMessaging({ noIdentities: true }) },
    ),
    link("missing", {}),
    link("empty", { botId: "" }),
    link("number", { botId: 5 }),
    link("array", { botId: [] }),
    link("extra-keys", { botId: "__mb1__", more: 1 }),
    link("no-input", undefined),
    link("null-input", null),
    link("anonymous", { botId: "__mb1__" }, { anonymous: true }),
    setBot(
      "to-free-bot",
      { identityId: "__id1__", botId: "__mb2__" },
      { seed: seedMessaging({ noChannels: true }) },
    ),
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
    channels(
      "odd-membership-status-fails-the-output-check",
      {},
      { seed: seedMessaging({ oddMembership: true }) },
    ),
    channels("no-input", undefined),
    channels("anonymous", {}, { anonymous: true }),
    respond("accept", { membershipId: "__mm1__", accept: true }),
    respond("decline", { membershipId: "__mm1__", accept: false }),
    respond("invited-on-second-identity", { membershipId: "__mm6__", accept: true }),
    respond("already-approved", { membershipId: "__mm2__", accept: true }),
    respond("left", { membershipId: "__mm5__", accept: true }),
    respond(
      "odd-status-is-not-found-accept",
      { membershipId: "__s-mm8__", accept: true },
      { seed: seedMessaging({ oddMembership: true }) },
    ),
    respond(
      "odd-status-is-not-found-decline",
      { membershipId: "__s-mm8__", accept: false },
      { seed: seedMessaging({ oddMembership: true }) },
    ),
    leave(
      "odd-status",
      { membershipId: "__s-mm8__" },
      { seed: seedMessaging({ oddMembership: true }) },
    ),
    respond("someone-elses", { membershipId: "__mm7__", accept: true }),
    respond("unknown", { membershipId: "nope", accept: true }),
    respond(
      "no-identities",
      { membershipId: "__mm1__", accept: true },
      { seed: seedMessaging({ noIdentities: true }) },
    ),
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
    leave(
      "no-identities",
      { membershipId: "__mm1__" },
      { seed: seedMessaging({ noIdentities: true }) },
    ),
    leave("missing", {}),
    leave("empty", { membershipId: "" }),
    leave("anonymous", { membershipId: "__mm1__" }, { anonymous: true }),
    connections("mixed", {}),
    connections("no-identities", {}, { seed: seedMessaging({ noIdentities: true }) }),
    connections("none", {}, { seed: seedMessaging({ noConnections: true }) }),
    connections(
      "odd-connection-status-fails-the-output-check",
      {},
      { seed: seedMessaging({ oddConnection: true }) },
    ),
    connections(
      "owner-name-multiword",
      {},
      { seed: seedMessaging({ ownerName: "  \u00a0Mary-Jane  Smith" }) },
    ),
    connections(
      "owner-name-opaque",
      {},
      { seed: seedMessaging({ ownerName: "ck1234567890123456789abcd" }) },
    ),
    connections(
      "owner-name-uuid",
      {},
      { seed: seedMessaging({ ownerName: "123e4567-e89b-12d3-a456-426614174000" }) },
    ),
    connections("owner-name-symbols", {}, { seed: seedMessaging({ ownerName: "😀 ✨" }) }),
    connections(
      "owner-name-unicode-space",
      {},
      { seed: seedMessaging({ ownerName: "Zoë\u2003Ünï" }) },
    ),
    connections(
      "owner-name-dunder",
      {},
      { seed: seedMessaging({ ownerName: "__Placeholder_1__" }) },
    ),
    connections(
      "owner-name-camel",
      {},
      { seed: seedMessaging({ ownerName: "AliceSmith1234567890Longname" }) },
    ),
    connections(
      "owner-name-mixed-long",
      {},
      { seed: seedMessaging({ ownerName: "aB3dE6gH9jK2mN5pQ8sT" }) },
    ),
    connections("no-input", undefined),
    connections("anonymous", {}, { anonymous: true }),
    revoke("pending-outgoing", { connectionId: "__cn4__" }, { seed: outbound("pending") }),
    revoke("pending-outgoing-retry", { connectionId: "__cn4__" }, { seed: outbound("retry") }),
    revoke("sent-without-handle", { connectionId: "__cn4__" }, { seed: outbound("sent") }),
    revoke(
      "sent-with-handle",
      { connectionId: "__cn4__" },
      { seed: outbound("sent", "provider-1") },
    ),
    revoke("failed-invite-kept", { connectionId: "__cn4__" }, { seed: outbound("failed") }),
    revoke("incoming-pending", { connectionId: "__cn5__" }),
    revoke("approved", { connectionId: "__cn6__" }),
    revoke("declined", { connectionId: "__cn7__" }),
    revoke("already-revoked", { connectionId: "__cn8__" }),
    revoke("between-strangers", { connectionId: "__cn9__" }),
    revoke("unknown", { connectionId: "nope" }),
    revoke(
      "no-identities",
      { connectionId: "__cn4__" },
      { seed: seedMessaging({ noIdentities: true }) },
    ),
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
    list(
      "long-title-fails-the-output-check",
      {},
      {
        seed: async (seeded) => {
          await seedPages(seeded);
          await system.page.create({
            data: {
              id: `${seeded.userId}-bad`,
              spaceId: seeded.spaces[0],
              userId: seeded.userId,
              title: "t".repeat(201),
              visibility: "private",
              currentVersion: 1,
              pinnedAt: null,
              createdAt: new Date(PAGE_BASE),
              updatedAt: new Date(PAGE_BASE),
            },
          });
        },
      },
    ),
    list(
      "zero-version-fails-the-output-check",
      {},
      {
        seed: async (seeded) => {
          await seedPages(seeded);
          await system.page.create({
            data: {
              id: `${seeded.userId}-bad`,
              spaceId: seeded.spaces[0],
              userId: seeded.userId,
              title: "Zero version",
              visibility: "private",
              currentVersion: 0,
              pinnedAt: null,
              createdAt: new Date(PAGE_BASE),
              updatedAt: new Date(PAGE_BASE),
            },
          });
        },
      },
    ),
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
    // The list parses the output, which holds the page and not the extra row read to know whether another follows.
    list("bad-row-just-past-the-page-is-not-parsed", { limit: 12 }, { seed: seedOldestBadPage }),
    list("bad-row-last-in-the-page-fails", { limit: 13 }, { seed: seedOldestBadPage }),
    list("limit-string", { limit: "5" }),
    list("limit-null", { limit: null }),
    list("limit-bool", { limit: true }),
    list("limit-huge", { limit: 1e300 }),
    list("limit-unsafe", { limit: Number.MAX_SAFE_INTEGER + 1 }),
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
    list("cursor-pinned-tie", {
      cursor: cursorOf("2026-04-21T02:00:00.000Z", "2026-05-01T11:00:00.000Z", "~"),
    }),
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
    list("cursor-standard-base64", {
      cursor: Buffer.from(JSON.stringify({ pinnedAt: null, updatedAt: T, id: "zzz??" })).toString(
        "base64",
      ),
    }),
    list("cursor-padded", { cursor: `${cursorOf(T, null, "zzz")}==` }),
    list("cursor-whitespace", {
      cursor: ` ${cursorOf(T, null, "zzz").slice(0, 10)}\n ${cursorOf(T, null, "zzz").slice(10)}`,
    }),
    list("cursor-junk-chars", {
      cursor: `${cursorOf(T, null, "zzz").slice(0, 10)}*.${cursorOf(T, null, "zzz").slice(10)}`,
    }),
    list("cursor-extra-keys", {
      cursor: b64(JSON.stringify({ pinnedAt: null, updatedAt: T, id: "zzz", more: [1] })),
    }),
    list("cursor-key-case-id", {
      cursor: b64(JSON.stringify({ pinnedAt: null, updatedAt: T, ID: "zzz" })),
    }),
    list("cursor-key-case-updated", {
      cursor: b64(JSON.stringify({ pinnedAt: null, UpdatedAt: T, id: "zzz" })),
    }),
    list("cursor-key-case-pinned", {
      cursor: b64(JSON.stringify({ PINNEDAT: null, updatedAt: T, id: "zzz" })),
    }),
    list("cursor-key-case-extra-valid", {
      cursor: b64(JSON.stringify({ pinnedAt: null, updatedAt: T, id: "zzz", ID: "other" })),
    }),
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
    // ECMAScript TimeClip: one millisecond outside the range Date can represent is Invalid Date.
    list("cursor-just-past-max-time", { cursor: cursorOf("+275760-09-13T00:00:00.001Z", null) }),
    list("cursor-just-below-min-time", { cursor: cursorOf("-271821-04-19T23:59:59.999Z", null) }),
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
  call: (
    procedure: string,
    input: unknown,
    seeded: Seeded,
  ) => Promise<{ status: number; headers: unknown; body: any }>,
  input: unknown,
  seeded: Seeded,
) {
  if (testCase.concurrent) {
    const results = await Promise.all(
      Array.from({ length: testCase.concurrent }, () =>
        call(testCase.procedure, input, called(seeded, testCase)),
      ),
    );
    const combined = results
      .map((result) => ({ status: result.status, json: result.body?.json }))
      .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
    return {
      status: results[0]!.status,
      headers: results[0]!.headers,
      body: { json: combined },
      calls: testCase.concurrent,
    };
  }
  if (!testCase.paginate) {
    const raw = await call(testCase.procedure, input, called(seeded, testCase));
    const result = testCase.unordered ? sortedById(raw) : raw;
    const settled = testCase.unorderedSections ? sortedSections(result) : result;
    return {
      ...(testCase.after ? { ...settled, followUps: await followUps(testCase, seeded) } : settled),
      calls: 1,
    };
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
  return {
    status: pages[0]!.status,
    headers: pages[0]!.headers,
    body: pages.map((page) => page.body),
    calls: pages.length,
  };
}

/** What the web app does right after a read-state change: it reloads the chat lists (through TypeScript). */
async function followUps(testCase: Case, seeded: Seeded) {
  const results = [];
  for (const step of testCase.after ?? []) {
    const result = await tsCall(
      step.procedure,
      withIds(step.input, seeded),
      called(seeded, testCase),
    );
    results.push(testCase.unordered ? sortedById(result) : result);
  }
  return results;
}

/** An unordered concatenation is compared by part: the order the rows arrive in is not a contract. */
function sortedSections<T extends { body: any }>(result: T): T {
  const text = result.body?.json;
  if (typeof text !== "string" || text === "") return result;
  const sections = text.split(/\n\n(?=# )/).sort();
  return { ...result, body: { ...result.body, json: sections.join("\n\n") } };
}

/** A list the API does not order is compared by id: the order Postgres returns it in is not a contract. */
function sortedById<T extends { body: any }>(result: T): T {
  const json = result.body?.json;
  if (!Array.isArray(json)) return result;
  const key = (item: { id?: unknown } | null) => String(item?.id);
  return {
    ...result,
    body: {
      ...result.body,
      json: [...json].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
    },
  };
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
      data: {
        id: `${seeded.orgId}-mo`,
        organizationId: seeded.orgId,
        userId: other,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Creating a member also adds them to the organization's default Space (space one).
    const old = new Date(Date.UTC(2020, 0, 1));
    const bot = (id: string, spaceId: string, name: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: user,
          name,
          color: "blue",
          updatedAt: old,
          ...extra,
        },
      });
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
      system.thread.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: user,
          nextMessageSeq: next,
          nextEventSeq: next,
          ...extra,
        },
      });
    await thread("th-tb1", seeded.spaces[0], { botId: `${user}-tb1` }, 10);
    await thread("th-tb2", seeded.spaces[0], { botId: `${user}-tb2` }, 10);
    await thread("th-tb3", seeded.spaces[0], { botId: `${user}-tb3` }, 10);
    await thread("th-tb4", seeded.spaces[0], { botId: `${user}-tb4` }, 0);
    await thread("th-tb5", seeded.spaces[0], { botId: `${user}-tb5` }, 10);
    await thread("th-tbfresh", seeded.spaces[0], { botId: `${user}-tbfresh` }, 10);
    await thread("th-tbarch", seeded.spaces[0], { botId: `${user}-tbarch` }, 10);
    await thread("th-tbx", seeded.spaces[1], { botId: `${user}-tbx` }, 10);
    const group = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      system.chatGroup.create({
        data: {
          id: `${user}-${id}`,
          spaceId: seeded.spaces[0],
          userId: user,
          name,
          updatedAt: old,
          ...extra,
        },
      });
    await group("tg1", "Group one");
    await group("tg2", "Group two");
    await group("tgone", "Group of one");
    await group("tgarch", "Group archived", { archivedAt: old });
    await group("tgnone", "Group without a thread");
    const member = (groupId: string, botId: string) =>
      system.chatGroupMember.create({
        data: {
          id: `${user}-gm-${groupId}-${botId}`,
          groupId: `${user}-${groupId}`,
          botId: `${user}-${botId}`,
        },
      });
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
        data: {
          id: `${user}-ev-${threadId}-${seq}`,
          spaceId: seeded.spaces[0],
          threadId: `${user}-${threadId}`,
          botId: `${user}-tb1`,
          seq,
          type: "note",
          payload: { n: seq },
        },
      });
    for (const seq of [0, 3, 7]) await event("th-tb1", seq);
    await event("th-tg1", 2);
    const message = (id: string, threadId: string, seq: number) =>
      system.message.create({
        data: {
          id: `${user}-${id}`,
          threadId: `${user}-${threadId}`,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: "hi" }],
        },
      });
    await message("msg5", "th-tb1", 5);
    await message("msg0", "th-tb1", 0);
    await message("msgother", "th-tb2", 4);
    if (config.noReads) return;
    const read = (threadId: string, data: Record<string, unknown>, userId = user) =>
      system.threadRead.create({
        data: { threadId: `${user}-${threadId}`, userId, spaceId: seeded.spaces[0], ...data },
      });
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
  const mk =
    (procedure: string, label: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
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
  const days = (n: number) =>
    new Date(THREAD_FUTURE.getTime() + (n - 30) * 86_400_000).toISOString();
  // The same instant written with an offset, as a phone in another zone might.
  const wire = (n: number) =>
    new Date(THREAD_FUTURE.getTime() + (n - 30) * 86_400_000 + 19_800_000)
      .toISOString()
      .replace("Z", "+05:30");
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
    snooze(
      "bot-no-reads-at-all",
      { botId: "__tb1__", until: days(2) },
      { seed: seedThreads({ noReads: true }) },
    ),
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
      data: {
        id: `${seeded.orgId}-mo`,
        organizationId: seeded.orgId,
        userId: other,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Creating a member also adds them to the organization's default Space (space one).
    const old = new Date(Date.UTC(2020, 0, 1));
    await system.bot.create({
      data: {
        id: `${user}-tb1`,
        spaceId: seeded.spaces[0],
        userId: user,
        name: "Bot",
        color: "blue",
        updatedAt: old,
      },
    });
    await system.bot.create({
      data: {
        id: `${user}-tbx`,
        spaceId: seeded.spaces[1],
        userId: user,
        name: "Bot x",
        color: "blue",
        updatedAt: old,
      },
    });
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
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `sender-${String(i).padStart(3, "0")}`,
        { name: `Sender ${i}`, mode: "ignore" },
      ]),
    );
  return [
    // The web client sends the whole form.
    update(
      "client-shape",
      policy({
        "bot-1": { name: "CI bot", mode: "rollup", rollupHours: 24 },
        "bot-2": { name: "Alerts", mode: "action" },
      }),
    ),
    update("empty-policies", policy({})),
    update(
      "ambient-null-rules-null",
      policy({}, { teamChatAmbientEnabled: null, teamChatRules: null }),
    ),
    update("ambient-false", policy({}, { teamChatAmbientEnabled: false, teamChatRules: "" })),
    update(
      "all-modes",
      policy({
        a: { name: "A", mode: "ignore" },
        b: { name: "B", mode: "rollup", rollupHours: 1 },
        c: { name: "C", mode: "action" },
        d: { name: "D", mode: "user" },
      }),
    ),
    update("rollup-hours-720", policy({ a: { name: "A", mode: "rollup", rollupHours: 720 } })),
    update("hours-with-other-mode", policy({ a: { name: "A", mode: "user", rollupHours: 5 } })),
    update("keys-trimmed", policy({ "  padded \t": { name: "  Padded name  ", mode: "ignore" } })),
    update(
      "keys-collide-after-trim",
      policy({ " a ": { name: "first", mode: "ignore" }, a: { name: "second", mode: "user" } }),
    ),
    update(
      "numeric-keys-order",
      policy({
        b: { name: "b", mode: "ignore" },
        10: { name: "ten", mode: "ignore" },
        2: { name: "two", mode: "ignore" },
        a: { name: "a", mode: "ignore" },
      }),
    ),
    update(
      "proto-key-dropped",
      JSON.parse(
        `{"externalConversationId":"__ec1__","teamChatAmbientEnabled":true,"teamChatRules":"r","automatedSenderPolicies":{"__proto__":{"name":"x","mode":"ignore"},"ok":{"name":"y","mode":"ignore"}}}`,
      ),
    ),
    update(
      "unknown-keys-stripped",
      policy({ a: { name: "A", mode: "ignore", extra: [1], deep: { x: 1 } } }, { more: true }),
    ),
    update(
      "unicode",
      policy(
        { "ключ-😀": { name: "Имя ✨", mode: "ignore" } },
        { teamChatRules: "règles — 日本語 😀" },
      ),
    ),
    update(
      "line-separators-in-text",
      policy(
        { a: { name: "A\u2028B", mode: "ignore" } },
        { teamChatRules: 'x\u2028y\u2029z <b> & "q" \\ /' },
      ),
    ),
    update(
      "nul-in-rules-and-names",
      policy({ "k\u0000": { name: "n\u0000m", mode: "ignore" } }, { teamChatRules: "a\u0000b" }),
    ),
    update(
      "controls-and-escapes",
      policy(
        { a: { name: "tab\there", mode: "ignore" } },
        { teamChatRules: "line1\nline2\r\n\u0007\u007f" },
      ),
    ),
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
    update(
      "entries-51-with-bad-value",
      policy({ ...entries(51), bad: { name: "", mode: "ignore" } }),
    ),
    update("entries-51-with-type-error", policy({ ...entries(51), bad: 5 })),
    update(
      "entries-51-with-key-error",
      policy({ ...entries(51), "": { name: "A", mode: "ignore" } }),
    ),
    update(
      "entries-51-collapse-to-50",
      policy({ ...entries(50), " sender-000 ": { name: "dup", mode: "user" } }),
    ),
    update("rollup-without-hours", policy({ a: { name: "A", mode: "rollup" } })),
    update(
      "rollup-without-hours-two-keys",
      policy({ a: { name: "A", mode: "rollup" }, b: { name: "B", mode: "rollup" } }),
    ),
    update("rollup-blank-name-no-hours", policy({ a: { name: " ", mode: "rollup" } })),
    update("rollup-wrong-name-type-no-hours", policy({ a: { name: 5, mode: "rollup" } })),
    update("rollup-bad-hours-type", policy({ a: { name: "A", mode: "rollup", rollupHours: "3" } })),
    update("hours-0", policy({ a: { name: "A", mode: "ignore", rollupHours: 0 } })),
    update("hours-721", policy({ a: { name: "A", mode: "ignore", rollupHours: 721 } })),
    update("hours-fraction", policy({ a: { name: "A", mode: "ignore", rollupHours: 1.5 } })),
    update("hours-null", policy({ a: { name: "A", mode: "ignore", rollupHours: null } })),
    update(
      "hours-negative-huge",
      policy({ a: { name: "A", mode: "ignore", rollupHours: -1e300 } }),
    ),
    update("mode-unknown", policy({ a: { name: "A", mode: "block" } })),
    update("mode-missing", policy({ a: { name: "A" } })),
    update("mode-number", policy({ a: { name: "A", mode: 1 } })),
    update("name-missing", policy({ a: { mode: "ignore" } })),
    update("name-null", policy({ a: { name: null, mode: "ignore" } })),
    update("value-not-object", policy({ a: 5, b: "x", c: null, d: [], e: true })),
    update("policies-array", policy([])),
    update("policies-null", policy(null)),
    update("policies-string", policy("x")),
    update("policies-missing", {
      externalConversationId: "__ec1__",
      teamChatAmbientEnabled: true,
      teamChatRules: "r",
    }),
    update("ambient-string", policy({}, { teamChatAmbientEnabled: "yes" })),
    update("ambient-missing", {
      externalConversationId: "__ec1__",
      teamChatRules: "r",
      automatedSenderPolicies: {},
    }),
    update("rules-number", policy({}, { teamChatRules: 5 })),
    update("rules-array", policy({}, { teamChatRules: [] })),
    update("rules-missing", {
      externalConversationId: "__ec1__",
      teamChatAmbientEnabled: true,
      automatedSenderPolicies: {},
    }),
    update("id-empty", policy({}, { externalConversationId: "" })),
    update("id-number", policy({}, { externalConversationId: 5 })),
    update("id-missing", {
      teamChatAmbientEnabled: true,
      teamChatRules: "r",
      automatedSenderPolicies: {},
    }),
    update("everything-wrong", {
      externalConversationId: "",
      teamChatAmbientEnabled: "y",
      teamChatRules: 5,
      automatedSenderPolicies: [],
    }),
    update("empty-object", {}),
    update("no-input", undefined),
    update("null-input", null),
    update("array-input", []),
    update("someone-elses-conversation", policy({}, { externalConversationId: "__ec2__" })),
    update("other-space-conversation", policy({}, { externalConversationId: "__ec3__" })),
    update(
      "other-space-conversation-own-header",
      policy({}, { externalConversationId: "__ec3__" }),
      { space: 1 },
    ),
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
    data: {
      id: `${seeded.orgId}-mo`,
      organizationId: seeded.orgId,
      userId: other,
      role: "member",
      createdAt: new Date(),
    },
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
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: user, name: id, color: "blue", ...extra },
      });
    await bot("tb1", seeded.spaces[0]);
    await bot("tb2", seeded.spaces[0]);
    await bot("tbarch", seeded.spaces[0], { archivedAt: new Date(SETTINGS_BASE) });
    await bot("tbx", seeded.spaces[1]);
    const item = (
      id: string,
      botId: string,
      spaceId: string,
      title: string,
      status: string,
      updated: number,
      created: number,
      userId = user,
    ) =>
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
  const mk =
    (procedure: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
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
    list("status-wins-over-include-done", {
      botId: "__s-tb1__",
      status: "open",
      includeDone: true,
    }),
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

    create("client-shape", {
      botId: "__s-tb1__",
      title: "Call the bank",
      status: "open",
      notes: "",
    }),
    create("defaults", { botId: "__s-tb1__", title: "Only a title" }),
    create("trimmed", {
      botId: "__s-tb1__",
      title: "  Padded\t",
      notes: "\n  padded notes \u00a0\ufeff",
    }),
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
    create("unicode-and-separators", {
      botId: "__s-tb1__",
      title: 'Ключ 日本語 \u2028 <b> & "q" \\ /',
      notes: "line1\nline2\r\n\u2029 ✨",
    }),
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
  /** A legacy rule whose stored kind or effect sits outside the output schema. */
  badKind?: boolean;
  badEffect?: boolean;
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
    const rule = (
      id: string,
      effect: string,
      matchKind: string,
      matchValue: string,
      offset: number,
    ) =>
      system.userActionApprovalRule.create({
        data: {
          id: `${user}-${id}`,
          userId: user,
          effect,
          matchKind,
          matchValue,
          createdAt: at(offset),
        },
      });
    const spaceRule = (
      id: string,
      spaceId: string,
      effect: string,
      matchKind: string,
      matchValue: string,
      offset: number,
      userId = user,
    ) =>
      system.actionApprovalRule.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          createdByUserId: userId,
          effect,
          matchKind,
          matchValue,
          createdAt: at(offset),
        },
      });
    if (!config.bare) {
      await rule("ra1", "always_allow", "tool", "bash", 1);
      await rule("ra2", "deny", "site", "Example.com", 2);
      await rule("ra3", "require_approval", "connector", "github", 3);
      await rule("ra4", "deny", "category", "web", 4);
      await rule("ra5", "always_allow", "tool", "Under_score", 5);
      await rule("ra6", "always_allow", "tool", "i\u0307x", 6);
      await rule("ra7", "always_allow", "tool", "ΑΣ", 7);
      await rule("ra8", "always_allow", "tool", "MiXed", 8);
      if (config.badKind) await rule("rbk", "deny", "regex", "legacy", 20);
      if (config.badEffect) await rule("rbe", "block", "tool", "legacy", 21);
      await system.userActionAutoReviewPreference.create({
        data: { userId: user, enabled: true, skipApprovals: true },
      });
      for (const id of ["mc1", "vc1", "vc2"]) {
        await system.secret.create({
          data: {
            id: `${user}-sec-${id}`,
            userId: user,
            spaceId: null,
            kind: id.startsWith("vc") ? "voice" : "model",
            ciphertext: "sealed",
          },
        });
      }
      await system.userModelCredential.create({
        data: {
          id: `${user}-mc1`,
          userId: user,
          provider: "openai",
          label: "Key",
          secretId: `${user}-sec-mc1`,
        },
      });
      const choice = (
        role: string,
        position: number,
        provider: string,
        modelId: string,
        thinkingLevel: string | null,
        credentialId: string | null,
      ) =>
        system.userModelRoleChoice.create({
          data: { userId: user, role, position, provider, modelId, thinkingLevel, credentialId },
        });
      await choice("chat", 0, "openai", "gpt-a", "high", `${user}-mc1`);
      await choice("chat", 1, "anthropic", "claude-b", null, null);
      await choice("summary", 0, "openai", "gpt-c", null, `${user}-mc1`);
      for (const id of ["vc1", "vc2"]) {
        await system.userVoiceCredential.create({
          data: {
            id: `${user}-${id}`,
            userId: user,
            provider: "fish",
            secretId: `${user}-sec-${id}`,
          },
        });
      }
      await system.userVoicePreference.create({
        data: {
          userId: user,
          credentialId: `${user}-vc1`,
          voiceId: "voice-one",
          speechModel: "s1",
          isDefault: true,
        },
      });
      await system.userVoicePreference.create({
        data: {
          userId: user,
          credentialId: `${user}-vc2`,
          voiceId: "voice-two",
          speechModel: null,
          isDefault: false,
        },
      });
    }
    const vault = (id: string, spaceId: string | null, userId = user) =>
      system.vaultCredential.create({
        data: {
          id: `${user}-${id}`,
          userId,
          spaceId,
          name: id,
          origin: "https://example.test",
          auth: {},
          ciphertext: "sealed",
        },
      });
    await vault("v1", one);
    await vault("v2", two);
    await vault("v3", null);
    await vault("vo", one, other);
    await spaceRule("rs1", one, "deny", "tool", "bash", 11);
    await spaceRule("rs2", one, "always_allow", "site", "space.example", 12);
    await spaceRule("rs3", one, "deny", "tool", "SPACE", 13);
    await spaceRule("rt1", two, "deny", "tool", "bash", 14);
    await system.userActionApprovalRule.create({
      data: {
        id: `${user}-rao`,
        userId: other,
        effect: "deny",
        matchKind: "tool",
        matchValue: "bash",
        createdAt: at(15),
      },
    });
    await spaceRule("rso", one, "deny", "tool", "bash", 16, other);
    await system.spaceSettingOverride.create({
      data: { spaceId: one, userId: other, setting: "confirmations" },
    });
    for (const setting of config.overrides ?? []) {
      await system.spaceSettingOverride.create({ data: { spaceId: one, userId: user, setting } });
    }
    const copies = new Set(config.overrides ?? []);
    if (config.strayCopy)
      for (const setting of ["models", "voice", "confirmations"]) copies.add(setting);
    if (copies.has("models")) {
      await system.spaceModelRoleChoice.create({
        data: {
          spaceId: one,
          userId: user,
          role: "chat",
          position: 0,
          provider: "stale",
          modelId: "stale-model",
          thinkingLevel: null,
          credentialId: null,
        },
      });
    }
    if (copies.has("voice") && !config.bare) {
      await system.spaceVoicePreference.create({
        data: {
          id: `${user}-svp`,
          spaceId: one,
          userId: user,
          credentialId: `${user}-vc1`,
          voiceId: "stale-voice",
          isDefault: true,
        },
      });
    }
    if (copies.has("confirmations")) {
      await system.actionAutoReviewPreference.create({
        data: {
          id: `${user}-sar`,
          spaceId: one,
          userId: user,
          enabled: false,
          skipApprovals: false,
        },
      });
    }
    await system.actionAutoReviewPreference.create({
      data: { id: `${user}-saro`, spaceId: one, userId: other, enabled: true, skipApprovals: true },
    });
    await system.actionAutoReviewPreference.create({
      data: { id: `${user}-sar2`, spaceId: two, userId: user, enabled: true, skipApprovals: false },
    });
  };
}

function approvalRuleCases(): Case[] {
  const mk =
    (procedure: string, seed = seedSettings()) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
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
  const rule = (
    matchValue: string,
    effect: string | null = "deny",
    matchKind = "tool",
    more: Record<string, unknown> = {},
  ) => ({ effect, matchKind, matchValue, ...more });
  return [
    list("account-copy-by-default", undefined),
    list("stored-kind-outside-the-enum-fails-the-output-check", undefined, {
      seed: seedSettings({ badKind: true }),
    }),
    list("stored-effect-outside-the-enum-fails-the-output-check", undefined, {
      seed: seedSettings({ badEffect: true }),
    }),
    list("empty-object", {}),
    list("space-copy-when-overridden", undefined, overridden),
    list("scope-account-while-overridden", { scope: "account" }, overridden),
    list("scope-space-while-overridden", { scope: "space" }, overridden),
    list("scope-space-without-override", { scope: "space" }),
    list("scope-account", { scope: "account" }),
    list("other-settings-override-does-not-switch", undefined, {
      seed: seedSettings({ overrides: ["models", "voice", "credentials"] }),
    }),
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
    set("line-separators-in-value", rule('a\u2028b <x> & "q" \\ /', "deny")),
    set("nul-in-value", rule("a\u0000b", "deny")),
    set("long-value", rule("v".repeat(5000), "deny")),
    set("scope-account-explicit", rule("git", "deny", "tool", { scope: "account" })),
    set("scope-space-explicit", rule("git", "deny", "tool", { scope: "space" })),
    set("space-copy-when-overridden", rule("git", "deny"), overridden),
    set("space-copy-replaces-other-effect", rule("bash", "always_allow"), overridden),
    set("space-copy-same-rule-again", rule("bash", "deny"), overridden),
    set(
      "scope-account-while-overridden",
      rule("git", "deny", "tool", { scope: "account" }),
      overridden,
    ),
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
  const mk =
    (procedure: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
      name: `sso-${procedure}-${name}`,
      procedure: `spaceSettings.${procedure}`,
      input,
      seed: seedSettings(),
      after: undefined,
      ...extra,
    });
  const overrides = mk("overrides");
  const all = ["models", "voice", "confirmations", "credentials"];
  const some = (...overrides: string[]) => ({ seed: seedSettings({ overrides }) });
  return [
    overrides("none", undefined),
    overrides("some-in-enum-order", undefined, some("credentials", "voice")),
    overrides("all", undefined, some(...all)),
    overrides("space-two-header", undefined, { space: 1, ...some("models") }),
    overrides("junk-input-is-ignored", { anything: 1 }),
    overrides("anonymous", undefined, { anonymous: true }),
  ];
}

// ---- Slice 7c: connections, capabilities, usage, computer updates, MCP assignments, model backups ----

function seedConnections(config: { none?: boolean; odd?: boolean } = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    if (config.none) return;
    const connection = (
      id: string,
      spaceId: string,
      userId: string,
      provider: string,
      displayName: string,
      status: string,
      offset: number,
    ) =>
      system.connection.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId,
          provider,
          displayName,
          status,
          connectorId: "managed",
          providerRef: "provider-ref",
          metadata: { note: "kept" },
          createdAt: new Date(SETTINGS_BASE + offset * 1000),
        },
      });
    await connection("c1", seeded.spaces[0], user, "github", "GitHub work", "connected", 1);
    await connection("c2", seeded.spaces[0], user, "slack", "Slack", "pending", 2);
    await connection("c3", seeded.spaces[0], user, "notion", "Notion old", "revoked", 3);
    await connection("c4", seeded.spaces[0], user, "linear", "Linear", "error", 4);
    if (config.odd)
      await connection("c5", seeded.spaces[0], user, "odd", "Odd status \u2028 <b>", "weird", 5);
    await connection("co", seeded.spaces[0], other, "github", "Someone else's", "connected", 6);
    await connection("cx", seeded.spaces[1], user, "github", "In space two", "connected", 7);
  };
}

function connectionCases(): Case[] {
  const mk =
    (procedure: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
      name: `cn-${procedure}-${name}`,
      procedure: `connections.${procedure}`,
      input,
      seed: seedConnections(),
      after:
        procedure === "rename" ? [{ procedure: "connections.list", input: undefined }] : undefined,
      unordered: true,
      ...extra,
    });
  const list = mk("list");
  const rename = mk("rename");
  const long = (count: number, character = "n") => character.repeat(count);
  return [
    list("default", undefined),
    list("odd-status-fails-the-output-check", undefined, { seed: seedConnections({ odd: true }) }),
    list("none", undefined, { seed: seedConnections({ none: true }) }),
    list("space-two-header", undefined, { space: 1 }),
    list("space-three-header", undefined, { space: 2 }),
    list("junk-input-is-ignored", { anything: 1 }),
    list("anonymous", undefined, { anonymous: true }),

    rename("client-shape", { connectionId: "__s-c1__", displayName: "Renamed" }),
    rename("trimmed", { connectionId: "__s-c1__", displayName: "  Padded \t\u00a0" }),
    rename("same-name", { connectionId: "__s-c1__", displayName: "GitHub work" }),
    rename("revoked-connection", { connectionId: "__s-c3__", displayName: "Still renamable" }),
    rename("pending-connection", { connectionId: "__s-c2__", displayName: "P" }),
    rename(
      "odd-status-fails-the-output-check",
      { connectionId: "__s-c5__", displayName: "Odd" },
      { seed: seedConnections({ odd: true }) },
    ),
    rename(
      "other-connection-while-one-has-an-odd-status",
      { connectionId: "__s-c1__", displayName: "Fine" },
      { seed: seedConnections({ odd: true }) },
    ),
    rename("name-80", { connectionId: "__s-c1__", displayName: long(80) }),
    rename("name-81", { connectionId: "__s-c1__", displayName: long(81) }),
    rename("name-astral-80", { connectionId: "__s-c1__", displayName: long(80, "😀") }),
    rename("name-astral-81", { connectionId: "__s-c1__", displayName: long(81, "😀") }),
    rename("name-padded-81", { connectionId: "__s-c1__", displayName: ` ${long(81)} ` }),
    rename("unicode-and-separators", {
      connectionId: "__s-c1__",
      displayName: 'Ключ 日本語 \u2028\u2029 <b> & "q" \\ /',
    }),
    rename("nul", { connectionId: "__s-c1__", displayName: "a\u0000b" }),
    rename(
      "lone-surrogate-escape",
      JSON.parse(`{"connectionId":"__s-c1__","displayName":"a\\ud800b"}`),
    ),
    rename("blank", { connectionId: "__s-c1__", displayName: "   " }),
    rename("empty", { connectionId: "__s-c1__", displayName: "" }),
    rename("name-missing", { connectionId: "__s-c1__" }),
    rename("name-null", { connectionId: "__s-c1__", displayName: null }),
    rename("name-number", { connectionId: "__s-c1__", displayName: 5 }),
    rename("name-array", { connectionId: "__s-c1__", displayName: [] }),
    rename("id-missing", { displayName: "X" }),
    rename("id-empty", { connectionId: "", displayName: "X" }),
    rename("id-number", { connectionId: 5, displayName: "X" }),
    rename("everything-wrong", { connectionId: "", displayName: "" }),
    rename("someone-elses-connection", { connectionId: "__s-co__", displayName: "X" }),
    rename("other-space-connection", { connectionId: "__s-cx__", displayName: "X" }),
    rename(
      "other-space-connection-own-header",
      { connectionId: "__s-cx__", displayName: "X" },
      { space: 1 },
    ),
    rename("unknown", { connectionId: "nope", displayName: "X" }),
    rename("invalid-name-before-unknown-id", { connectionId: "nope", displayName: "" }),
    rename("extra-keys-ignored", { connectionId: "__s-c1__", displayName: "X", status: "revoked" }),
    rename("no-input", undefined),
    rename("null-input", null),
    rename("array-input", []),
    rename("anonymous", { connectionId: "__s-c1__", displayName: "X" }, { anonymous: true }),
  ];
}

/** The member's installs in several shapes of availability and stored settings. */
function seedCapabilities(
  config: { config?: string; secretId?: string | null; version?: string | null } = {},
) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const [one, two, three] = seeded.spaces;
    const install = (
      id: string,
      spaceId: string,
      extra: Record<string, unknown>,
      offset: number,
      userId = user,
    ) =>
      system.capabilityInstall.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId,
          kind: "plugin",
          name: `Install ${id}`,
          source: `https://example.test/${id}`,
          config: {},
          createdAt: new Date(SETTINGS_BASE + offset * 1000),
          ...extra,
        },
      });
    await install(
      "k1",
      one,
      {
        version: config.version === undefined ? "1.2.3" : config.version,
        digest: "sha256:abc",
        secretId: config.secretId === undefined ? `${user}-sec` : config.secretId,
      },
      1,
    );
    await install("k2", two, { allSpaces: true, kind: "mcp" }, 2);
    await install("k3", two, { kind: "api" }, 3);
    await system.capabilityInstallSpace.create({
      data: { installId: `${user}-k3`, spaceId: one, userId: user },
    });
    await system.capabilityInstallSpace.create({
      data: { installId: `${user}-k3`, spaceId: three, userId: user },
    });
    await install("k4", two, { kind: "connection" }, 4);
    await install("k5", one, { kind: "skill" }, 5);
    await system.capabilityInstallSpace.create({
      data: { installId: `${user}-k5`, spaceId: one, userId: user },
    });
    await system.capabilityInstallSpace.create({
      data: { installId: `${user}-k5`, spaceId: two, userId: user },
    });
    await install("ko", one, { allSpaces: true }, 6, other);
    if (config.config !== undefined) {
      await system.$executeRaw`UPDATE capability_installs SET config = ${config.config}::jsonb WHERE id = ${`${user}-k1`}`;
    }
  };
}

function capabilityCases(): Case[] {
  const list = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `cap-list-${name}`,
    procedure: "capabilities.list",
    input: undefined,
    unordered: true,
    seed: seedCapabilities(),
    ...extra,
  });
  const withConfig = (name: string, config: string) =>
    list(`config-${name}`, { seed: seedCapabilities({ config }) });
  return [
    list("default"),
    list("space-two-header", { space: 1 }),
    list("space-three-header", { space: 2 }),
    list("junk-input-is-ignored", { input: { anything: 1 } }),
    list("anonymous", { anonymous: true }),
    list("no-version-and-null-secret", {
      seed: seedCapabilities({ version: null, secretId: null }),
    }),
    list("empty-string-secret-is-not-configured", { seed: seedCapabilities({ secretId: "" }) }),
    withConfig(
      "nested-object",
      '{"b": 1, "a": [1.0, 2.50, 1e3, -0, 1e21, 1E-7, 123456789012345678901234567890, 0.1], "10": "x", "2": "y", "z": {"é": "ü", "\\u2028": "<>&\\u0007\\u007f"}}',
    ),
    withConfig(
      "integer-like-keys-first",
      '{"b": 1, "2": 2, "1": 3, "a": 4, "-1": 5, "01": 6, "4294967295": 7, "4294967294": 8}',
    ),
    withConfig("proto-key", '{"__proto__": {"x": 1}, "a": 1}'),
    withConfig("proto-key-nested", '{"a": {"__proto__": {"x": 1}}, "__proto__": {"y": 2}, "b": 1}'),
    withConfig("proto-key-in-arrays", '{"l": [{"__proto__": 1, "k": 2}, [{"__proto__": 3}], 4]}'),
    withConfig(
      "escapes",
      '{"quote\\"": "tab\\t newline\\n bs\\\\ slash\\/ \\b\\f \\u0001 \\u001f \\u2029 \\ud83d\\ude00"}',
    ),
    withConfig("array", "[1, 2]"),
    withConfig("string", '"x"'),
    withConfig("number", "5"),
    withConfig("null", "null"),
    withConfig("true", "true"),
    withConfig("empty-object", "{}"),
    withConfig(
      "big-exponent",
      '{"n": 1e400, "m": -1e400, "s": 5e-324, "t": 1.7976931348623157e308}',
    ),
    withConfig("deep", '{"a": {"b": {"c": {"d": [[], {}, [{"e": null}]]}}}}'),
  ];
}

/**
 * Usage records for the member in space one, with the shapes the summary treats specially:
 * null figures, a subagent run, an empty run id, floats, sums beyond 32 bits, and rows that
 * belong to someone else or to another Space.
 */
function seedUsage(
  config: {
    none?: boolean;
    many?: boolean;
    orderSensitive?: boolean;
    tiedTimes?: boolean;
    emptyRun?: boolean;
    badCost?: boolean;
    weirdCost?: number;
    badKind?: boolean;
  } = {},
) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const [one, two] = seeded.spaces;
    if (config.none) return;
    const row = (
      id: string,
      data: Record<string, unknown>,
      offset: number,
      spaceId = one,
      userId = user,
    ) =>
      system.usageRecord.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId,
          provider: "openai",
          model: "gpt-a",
          createdAt: new Date(SETTINGS_BASE + offset * 1000),
          ...data,
        },
      });
    if (config.many) {
      // Mixed magnitudes and (optionally) one shared createdAt: the cost total is then sensitive to
      // the order Postgres sums in, so the case only matches when both sides read the same heap
      // layout. reset() truncates usage_records, as production never deletes a usage row.
      for (let index = 0; index < 120; index += 1) {
        const at = config.tiedTimes ? 0 : index;
        const costUsd = config.orderSensitive
          ? index % 2 === 0
            ? 1e6 * (index + 1)
            : 1e-6 * (index + 1)
          : index / 1000;
        await row(
          `m${String(index).padStart(3, "0")}`,
          {
            inputTokens: index,
            outputTokens: 1,
            totalTokens: index + 1,
            costUsd,
            runId: `${user}-run${index % 7}`,
          },
          at,
        );
      }
      await row("mx", { inputTokens: 1 }, config.tiedTimes ? 0 : 500, two);
      return;
    }
    // The summary's per-group cost is Postgres sum(float8), which accumulates in scan order, and each
    // side reads its own freshly reseeded heap: 0.0000123 + 1e-7 + (-1) came out as -0.9999876 and
    // -0.9999876000000001 depending on that order (usg-summary-negative-cost, pass 6), and 0.1 + 0.2 +
    // (0.1 + 0.2) was 0.6 or 0.6000000000000001. Dyadic costs whose partial sums need at most 25
    // significand bits (2^-16, 2^-24, -1) sum identically in every order, and 0.01 + 0.2 + (0.1 + 0.2)
    // is 0.51 in every order; u6 still carries the long expansion for usage.list.
    await row(
      "u1",
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 2 ** -16,
        runId: `${user}-r1`,
        botId: null,
        callId: `${user}-call1`,
        costSource: "provider",
        pricingVersion: "v1",
        usageSource: "api",
        operationId: "op1",
        agentId: "agent",
      },
      1,
    );
    await row(
      "u2",
      {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        costUsd: 2 ** -24,
        runId: `${user}-r1`,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        cacheWrite1hTokens: 5,
        reasoningTokens: 6,
      },
      2,
    );
    await row("u3", { model: "gpt-b", runId: `${user}-r2`, operationKind: "setup" }, 3);
    await row(
      "u4",
      {
        provider: "anthropic",
        model: "claude",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.01,
        runId: `${user}-r3`,
        parentRunId: `${user}-r1`,
        operationKind: "subagent",
      },
      4,
    );
    await row(
      "u5",
      {
        provider: "anthropic",
        model: "claude",
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        costUsd: 0.2,
        runId: config.emptyRun ? "" : null,
      },
      5,
    );
    await row(
      "u6",
      {
        provider: "anthropic",
        model: "claude",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0.1 + 0.2,
        parentRunId: `${user}-r9`,
        operationKind: "compaction",
      },
      6,
    );
    await row(
      "u7",
      {
        provider: "local",
        model: "m",
        inputTokens: 2_000_000_000,
        outputTokens: 2_000_000_000,
        totalTokens: 2_147_483_647,
        costUsd: 1e21,
      },
      7,
    );
    await row(
      "u8",
      {
        provider: "local",
        model: "m",
        inputTokens: 2_000_000_000,
        outputTokens: 1,
        totalTokens: 2_147_483_647,
        costUsd: 123456789.123,
      },
      8,
    );
    await row("u9", { provider: "zeta", model: "z", runId: `${user}-r4` }, 9);
    await row(
      "u10",
      { provider: "zeta", model: "z", runId: `${user}-r4`, operationKind: "retrieval" },
      10,
    );
    await row("u11", { provider: "zeta", model: "y", runId: `${user}-r5` }, 11);
    await row("u12", { provider: "zeta", model: "z", runId: `${user}-r6` }, 15);
    await row("u13", { provider: "zeta", model: "y", runId: `${user}-r5` }, 16);
    // The summary reports a group's token sum only when every row has the column, so these
    // rows carry totalTokens: 0 and keep openai/gpt-a's weight distinct from zeta/z instead of
    // tying it, whose group order the database does not contract.
    if (config.badCost) await row("bad", { costUsd: -1, totalTokens: 0 }, 20);
    if (config.weirdCost !== undefined)
      await row("bad", { costUsd: config.weirdCost, totalTokens: 0 }, 20);
    // Still "unknown kind": the case only proves the summary does not check the column.
    if (config.badKind) await row("bad", { operationKind: "weird", totalTokens: 0 }, 20);
    await row("o1", { inputTokens: 999, totalTokens: 999 }, 12, one, other);
    await row("x1", { inputTokens: 888, totalTokens: 888, runId: `${user}-r8` }, 13, two);
    await row("x2", { provider: "elsewhere", model: "e", inputTokens: 7, totalTokens: 7 }, 14, two);
  };
}

function usageCases(): Case[] {
  const mk =
    (procedure: string) =>
    (name: string, extra: Partial<Case> = {}): Case => ({
      name: `usg-${procedure}-${name}`,
      procedure: `usage.${procedure}`,
      input: undefined,
      seed: seedUsage(),
      ...extra,
    });
  const list = mk("list");
  const summary = mk("summary");
  return [
    list("default"),
    list("empty-run-id-fails-the-output-check", { seed: seedUsage({ emptyRun: true }) }),
    list("negative-cost-fails-the-output-check", { seed: seedUsage({ badCost: true }) }),
    list("infinite-cost-fails-the-output-check", {
      seed: seedUsage({ weirdCost: Number.POSITIVE_INFINITY }),
    }),
    list("negative-infinite-cost-fails-the-output-check", {
      seed: seedUsage({ weirdCost: Number.NEGATIVE_INFINITY }),
    }),
    list("nan-cost-fails-the-output-check", { seed: seedUsage({ weirdCost: Number.NaN }) }),
    list("unknown-operation-kind-fails-the-output-check", { seed: seedUsage({ badKind: true }) }),
    list("none", { seed: seedUsage({ none: true }) }),
    // No case ties every createdAt here: with more rows than the limit, which equal-keyed rows
    // survive is up to the plan, so the returned set is not a contract. summary has one, where the
    // total over all rows is well defined once both sides read the same heap.
    list("limit-100-newest-first", { seed: seedUsage({ many: true }) }),
    list("limit-100-order-sensitive", { seed: seedUsage({ many: true, orderSensitive: true }) }),
    list("space-two-header", { space: 1 }),
    list("junk-input-is-ignored", { input: { anything: 1 } }),
    list("anonymous", { anonymous: true }),
    summary("default"),
    summary("empty-run-id-is-no-run", { seed: seedUsage({ emptyRun: true }) }),
    summary("negative-cost-is-not-checked", { seed: seedUsage({ badCost: true }) }),
    summary("infinite-cost-fails-the-output-check", {
      seed: seedUsage({ weirdCost: Number.POSITIVE_INFINITY }),
    }),
    summary("negative-infinite-cost", { seed: seedUsage({ weirdCost: Number.NEGATIVE_INFINITY }) }),
    summary("nan-cost-fails-the-output-check", { seed: seedUsage({ weirdCost: Number.NaN }) }),
    summary("unknown-operation-kind-is-not-checked", { seed: seedUsage({ badKind: true }) }),
    summary("none", { seed: seedUsage({ none: true }) }),
    summary("many-rows-no-limit", { seed: seedUsage({ many: true }) }),
    summary("many-rows-order-sensitive", { seed: seedUsage({ many: true, orderSensitive: true }) }),
    summary("many-rows-order-sensitive-tied-times", {
      seed: seedUsage({ many: true, orderSensitive: true, tiedTimes: true }),
    }),
    summary("space-two-header", { space: 1 }),
    summary("junk-input-is-ignored", { input: { anything: 1 } }),
    summary("anonymous", { anonymous: true }),
  ];
}

/** Computers with updates in every status, bots archived or missing, and one malformed row. */
function seedComputerUpdates(
  config: { badAction?: boolean; badStage?: boolean; none?: boolean } = {},
) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    await seedOtherMember(seeded);
    const [one, two] = seeded.spaces;
    if (config.none) return;
    const computer = (id: string, spaceId: string, scope: string) =>
      system.computer.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: user,
          kind: "local",
          scope,
          scopeKey: `${user}-${id}-sk`,
          homeKey: `${user}-${id}-hk`,
        },
      });
    const bot = (
      id: string,
      spaceId: string,
      computerId: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      system.bot.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId: user,
          name: `Bot ${id}`,
          color: "blue",
          computerId: computerId && `${user}-${computerId}`,
          ...extra,
        },
      });
    const update = (
      id: string,
      computerId: string,
      botId: string,
      action: string,
      status: string,
      stage: string,
      offset: number,
    ) =>
      system.computerUpdate.create({
        // Recent, not 2020: the API's own reconciler treats an old queued or running update as abandoned and
        // announces a Space change for it, which would land in whichever side's signal window it falls in.
        data: {
          id: `${user}-${id}`,
          computerId: `${user}-${computerId}`,
          botId: `${user}-${botId}`,
          action,
          status,
          stage,
          createdAt: new Date(COMPUTER_UPDATE_BASE + offset * 1000),
        },
      });
    await computer("cp1", one, "team");
    await computer("cp2", one, "dedicated");
    await computer("cp3", one, "team");
    await computer("cp4", one, "team");
    await computer("cpx", two, "team");
    await bot("b1", one, "cp1");
    await bot("b2", one, "cp1");
    await bot("b3", one, "cp2");
    await bot("b4", one, "cp3", { archivedAt: new Date(SETTINGS_BASE) });
    await bot("b5", one, "cp4");
    await bot("b5a", one, "cp4", { archivedAt: new Date(SETTINGS_BASE) });
    await bot("bx", two, "cpx");
    await update("up1", "cp1", "b1", "update", "queued", "preparing", 1);
    await update("up2", "cp1", "b2", "update", "running", "saving", 2);
    await update("up3", "cp1", "b1", "recover", "interrupted", "recreating", 3);
    await update("up4", "cp2", "b3", "update", "failed", "restoring", 4);
    await update("up5", "cp1", "b2", "update", "completed", "reconnecting", 5);
    await update("up6", "cp3", "b4", "update", "queued", "preparing", 6);
    await update("up7", "cp4", "b5a", "update", "running", "saving", 7);
    await update("up8", "cp4", "b5", "update", "queued", "preparing", 8);
    await update("up9", "cpx", "bx", "update", "queued", "preparing", 9);
    await update("up10", "cp1", "nobot", "update", "failed", "preparing", 10);
    if (config.badAction) await update("up11", "cp2", "b3", "reinstall", "queued", "preparing", 11);
    if (config.badStage) await update("up12", "cp2", "b3", "update", "queued", "rebooting", 12);
  };
}

function computerUpdateCases(): Case[] {
  const updates = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `cu-updates-${name}`,
    procedure: "computer.updates",
    input: undefined,
    seed: seedComputerUpdates(),
    ...extra,
  });
  return [
    updates("default"),
    updates("none", { seed: seedComputerUpdates({ none: true }) }),
    updates("space-two-header", { space: 1 }),
    updates("space-three-header", { space: 2 }),
    updates("unknown-action-fails-the-call", { seed: seedComputerUpdates({ badAction: true }) }),
    updates("unknown-stage-fails-the-call", { seed: seedComputerUpdates({ badStage: true }) }),
    updates("junk-input-is-ignored", { input: { anything: 1 } }),
    updates("anonymous", { anonymous: true }),
  ];
}

/** MCP servers (own, everywhere, shared, elsewhere, someone else's) and bot assignments of them. */
function seedMcp(config: { none?: boolean; tools?: string } = {}) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const [one, two, three] = seeded.spaces;
    const server = (
      id: string,
      spaceId: string,
      extra: Record<string, unknown> = {},
      userId = user,
    ) =>
      system.mcpServer.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          userId,
          slug: `${id}`,
          name: `Server ${id}`,
          transport: "stdio",
          command: "true",
          ...extra,
        },
      });
    const bot = (id: string, spaceId: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: user, name: id, color: "blue", ...extra },
      });
    await bot("b1", one);
    await bot("b2", one);
    await bot("barch", one, { archivedAt: new Date(SETTINGS_BASE) });
    await bot("bx", two);
    if (config.none) return;
    await server("m1", one);
    await server("m2", two, { allSpaces: true });
    await server("m3", two);
    await system.mcpServerSpace.create({
      data: { serverId: `${user}-m3`, spaceId: one, userId: user },
    });
    await server("m4", two);
    await server("m5", one, {}, other);
    await server("m6", three, { allSpaces: false });
    const assign = (
      id: string,
      botId: string,
      serverId: string,
      spaceId: string,
      offset: number,
      extra: Record<string, unknown> = {},
      userId = user,
    ) =>
      system.botMcpServer.create({
        data: {
          id: `${user}-${id}`,
          spaceId,
          botId: `${user}-${botId}`,
          serverId: `${user}-${serverId}`,
          userId,
          createdAt: new Date(SETTINGS_BASE + offset * 1000),
          ...extra,
        },
      });
    await assign("a1", "b1", "m1", one, 3, {
      allowAllTools: false,
      allowedTools: ["read", "write"],
    });
    await assign("a2", "b1", "m2", one, 1, { allowedTools: [] });
    await assign("a3", "b1", "m3", one, 2, {
      allowAllTools: false,
      allowedTools: ["a", 1, null, "c", { x: 1 }, ["d"], true],
    });
    await assign("a4", "b2", "m1", one, 4, { allowedTools: ["only-b2"] });
    await assign("a5", "b1", "m4", one, 5);
    await assign("a6", "b1", "m5", one, 6);
    await assign("a7", "barch", "m1", one, 7);
    await assign("a8", "bx", "m2", two, 8);
    await assign("a9", "b2", "m2", one, 9, {}, other);
    await assign("a10", "b2", "m3", one, 9);
    if (config.tools !== undefined) {
      await system.$executeRaw`UPDATE bot_mcp_servers SET "allowedTools" = ${config.tools}::jsonb WHERE id = ${`${user}-a1`}`;
    }
  };
}

function mcpAssignmentCases(): Case[] {
  const mk =
    (procedure: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
      name: `mcp-${procedure}-${name}`,
      procedure: `mcp.assignments.${procedure}`,
      input,
      seed: seedMcp(),
      ...extra,
    });
  const all = mk("all");
  const list = mk("list");
  const tools = (name: string, text: string) =>
    list(`tools-${name}`, { botId: "__s-b1__" }, { seed: seedMcp({ tools: text }) });
  return [
    all("default", undefined),
    all("none", undefined, { seed: seedMcp({ none: true }) }),
    all("space-two-header", undefined, { space: 1 }),
    all("space-three-header", undefined, { space: 2 }),
    all("junk-input-is-ignored", { anything: 1 }),
    all("anonymous", undefined, { anonymous: true }),
    list("bot-with-shared-and-everywhere-servers", { botId: "__s-b1__" }),
    list("second-bot", { botId: "__s-b2__" }),
    list("archived-bot-is-allowed", { botId: "__s-barch__" }),
    list("none", { botId: "__s-b1__" }, { seed: seedMcp({ none: true }) }),
    list("other-space-bot", { botId: "__s-bx__" }),
    list("other-space-bot-own-header", { botId: "__s-bx__" }, { space: 1 }),
    list("unknown-bot", { botId: "nope" }),
    list("extra-keys-ignored", { botId: "__s-b1__", more: 1 }),
    list("bot-id-missing", {}),
    list("bot-id-empty", { botId: "" }),
    list("bot-id-number", { botId: 5 }),
    list("bot-id-null", { botId: null }),
    list("no-input", undefined),
    list("null-input", null),
    list("array-input", []),
    list("anonymous", { botId: "__s-b1__" }, { anonymous: true }),
    tools("object", '{"x": 1}'),
    tools("string", '"read"'),
    tools("null", "null"),
    tools("mixed", '["a", 1, "b", null, ["c"], "\\u2028", "é"]'),
    tools("duplicates", '["a", "a"]'),
    tools("empty-name-fails-the-output-check", '["", "a"]'),
    tools("name-200", JSON.stringify(["x".repeat(200)])),
    tools("name-201-fails-the-output-check", JSON.stringify(["x".repeat(201)])),
    tools("name-astral-200", JSON.stringify(["😀".repeat(200)])),
    tools("name-astral-201-fails-the-output-check", JSON.stringify(["😀".repeat(201)])),
    all("empty-name-fails-the-output-check", undefined, { seed: seedMcp({ tools: '["", "a"]' }) }),
    all("long-name-fails-the-output-check", undefined, {
      seed: seedMcp({ tools: JSON.stringify(["x".repeat(201)]) }),
    }),
    all("odd-allowed-tools-shapes", undefined, {
      seed: seedMcp({ tools: '["a", 1, null, ["b"], {"c": 1}]' }),
    }),
  ];
}

/** The member's model roles: account rows, and a Space copy (with or without the override row). */
function seedModels(
  config: {
    overrides?: string[];
    strayCopy?: boolean;
    none?: boolean;
    backups?: Array<[string, string]>;
  } = {},
) {
  return async (seeded: Seeded) => {
    const user = seeded.userId;
    const other = await seedOtherMember(seeded);
    const [one, two] = seeded.spaces;
    if (!config.none) {
      await system.secret.create({
        data: {
          id: `${user}-sec-mc`,
          userId: user,
          spaceId: null,
          kind: "model",
          ciphertext: "sealed",
        },
      });
      await system.userModelCredential.create({
        data: {
          id: `${user}-mc1`,
          userId: user,
          provider: "openai",
          label: "Key",
          secretId: `${user}-sec-mc`,
        },
      });
      const choice = (
        userId: string,
        role: string,
        position: number,
        provider: string,
        modelId: string,
        thinkingLevel: string | null,
        credentialId: string | null,
      ) =>
        system.userModelRoleChoice.create({
          data: { userId, role, position, provider, modelId, thinkingLevel, credentialId },
        });
      await choice(user, "main", 0, "openai", "gpt-a", "high", `${user}-mc1`);
      await choice(user, "main", 1, "anthropic", "claude-b", "low", null);
      await choice(user, "main", 2, "openai", "gpt-c", null, `${user}-mc1`);
      await choice(user, "main", 3, "google", "gemini-d", "bogus", null);
      for (const [index, [provider, modelId]] of (config.backups ?? []).entries()) {
        await choice(user, "main", 10 + index, provider, modelId, null, null);
      }
      await choice(user, "summary", 0, "openai", "gpt-s", null, null);
      await choice(user, "summary", 1, "openai", "gpt-s2", null, null);
      await choice(other, "main", 0, "other", "other-a", null, null);
      await choice(other, "main", 1, "other", "other-b", null, null);
    }
    for (const setting of config.overrides ?? []) {
      await system.spaceSettingOverride.create({ data: { spaceId: one, userId: user, setting } });
    }
    if ((config.overrides ?? []).includes("models") || config.strayCopy) {
      const copy = (
        spaceId: string,
        role: string,
        position: number,
        provider: string,
        modelId: string,
      ) =>
        system.spaceModelRoleChoice.create({
          data: {
            spaceId,
            userId: user,
            role,
            position,
            provider,
            modelId,
            thinkingLevel: "high",
            credentialId: null,
          },
        });
      await copy(one, "main", 0, "space", "space-primary");
      await copy(one, "main", 1, "space", "space-backup-1");
      await copy(one, "main", 2, "space", "space-backup-2");
      await copy(one, "summary", 1, "space", "space-summary-backup");
      await copy(two, "main", 1, "space2", "elsewhere-backup");
    }
  };
}

function modelBackupCases(): Case[] {
  const backups = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `mb-backups-${name}`,
    procedure: "models.backups",
    input: undefined,
    seed: seedModels(),
    ...extra,
  });
  return [
    backups("account-copy"),
    backups("padded-values-are-returned-trimmed", {
      seed: seedModels({ backups: [[" openai\t", " gpt-x \u00a0"]] }),
    }),
    backups("provider-128", { seed: seedModels({ backups: [["p".repeat(128), "m"]] }) }),
    backups("provider-129-fails-the-output-check", {
      seed: seedModels({ backups: [["p".repeat(129), "m"]] }),
    }),
    backups("provider-astral-128", { seed: seedModels({ backups: [["😀".repeat(128), "m"]] }) }),
    backups("provider-astral-129-fails", {
      seed: seedModels({ backups: [["😀".repeat(129), "m"]] }),
    }),
    backups("model-512", { seed: seedModels({ backups: [["p", "m".repeat(512)]] }) }),
    backups("model-513-fails-the-output-check", {
      seed: seedModels({ backups: [["p", "m".repeat(513)]] }),
    }),
    backups("padded-513-is-trimmed-to-511", {
      seed: seedModels({ backups: [["p", ` ${"m".repeat(511)} `]] }),
    }),
    backups("blank-provider-fails-the-output-check", {
      seed: seedModels({ backups: [["  \t", "m"]] }),
    }),
    backups("blank-model-fails-the-output-check", { seed: seedModels({ backups: [["p", ""]] }) }),
    backups("unicode-and-separators", {
      seed: seedModels({ backups: [["Ключ\u2028", '日本語 <b> & "q"']] }),
    }),
    backups("nothing-saved", { seed: seedModels({ none: true }) }),
    backups("space-copy-when-overridden", { seed: seedModels({ overrides: ["models"] }) }),
    backups("other-settings-override-does-not-switch", {
      seed: seedModels({ overrides: ["voice", "confirmations", "credentials"] }),
    }),
    backups("stray-space-copy-without-override", { seed: seedModels({ strayCopy: true }) }),
    backups("space-two-header-uses-the-account", {
      space: 1,
      seed: seedModels({ overrides: ["models"] }),
    }),
    backups("junk-input-is-ignored", { input: { anything: 1 } }),
    backups("anonymous", { anonymous: true }),
  ];
}

/** The oldest unpinned page, with a title past the bound: the list has to leave it out of a page it is not in. */
async function seedOldestBadPage(seeded: Seeded) {
  await seedPages(seeded);
  await system.page.create({
    data: {
      id: `${seeded.userId}-bad`,
      spaceId: seeded.spaces[0],
      userId: seeded.userId,
      title: "t".repeat(201),
      visibility: "private",
      currentVersion: 1,
      pinnedAt: null,
      createdAt: new Date(PAGE_BASE - 101 * 3_600_000),
      updatedAt: new Date(PAGE_BASE - 100 * 3_600_000),
    },
  });
}

/** pages.rename and pages.pin, on the pages of seedPages (`__s-u1__` is a plain page, `__s-pa__` a pinned one). */
function pageWriteCases(): Case[] {
  // What the web app reloads afterwards: the list, ordered by pin and update time, and a title search.
  const after = [
    { procedure: "pages.list", input: {} },
    { procedure: "pages.list", input: { query: "ren" } },
  ];
  const rename = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `pw-rename-${name}`,
    procedure: "pages.rename",
    input,
    seed: seedPages,
    after,
    ...extra,
  });
  const pin = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `pw-pin-${name}`,
    procedure: "pages.pin",
    input,
    seed: seedPages,
    after,
    ...extra,
  });
  /** A page of the first Space with stored values the contract refuses, next to the seeded ones. */
  const badPage =
    (data: Record<string, unknown>, pinned = false) =>
    async (seeded: Seeded) => {
      await seedPages(seeded);
      await system.page.create({
        data: {
          id: `${seeded.userId}-bad`,
          spaceId: seeded.spaces[0],
          userId: seeded.userId,
          title: "Bad",
          visibility: "private",
          currentVersion: 1,
          pinnedAt: pinned ? new Date(PAGE_BASE) : null,
          createdAt: new Date(PAGE_BASE),
          updatedAt: new Date(PAGE_BASE),
          ...data,
        },
      });
    };
  const titled = (title: unknown) => ({ pageId: "__s-u1__", title });
  const titles: Array<[string, unknown]> = [
    ["tabs-and-newlines", "a\tb\nc\rd"],
    ["nul", "a\u0000b"],
    ["nul-at-the-ends", "\u0000 x \u0000"],
    ["line-separators", "a\u2028b\u2029c"],
    ["unicode-spaces", "a\u00a0\u3000\u2003b"],
    ["bom-at-the-ends", "\ufeffx\ufeff"],
    ["next-line", "a\u0085b"],
    ["delete", "a\u007fb"],
    ["zero-width-space-is-kept", "a\u200bb"],
    ["soft-hyphen-is-kept", "a\u00adb"],
    ["mongolian-vowel-separator-is-kept", "a\u180eb"],
    ["runs-of-spaces", "a        b"],
    ["padded", "   renamed padded   "],
    ["emoji", "😀 ok 😀"],
    ["combining", "e\u0301"],
    ["right-to-left", "שלום עולם"],
    ["lone-high-surrogate", "a\ud800"],
    ["lone-low-surrogate", "\udc00b"],
    ["lone-surrogate-between", "x\ud800y"],
    ["valid-pair", "x\ud83d\ude00y"],
    ["reversed-pair", "\ude00\ud83d"],
    ["replacement-character", "a\ufffdb"],
    ["quotes-and-markup", "<b> & \"q\" 'x'"],
    ["backslash", "a\\b"],
    ["percent-and-underscore", "100%_sure"],
    ["200-characters", "x".repeat(200)],
    ["201-characters-fails", "x".repeat(201)],
    ["200-characters-padded", `  ${"x".repeat(200)}  `],
    ["fold-makes-it-201-fails", `${"x".repeat(100)}\t\t${"x".repeat(100)}`],
    ["fold-makes-it-200", `${"x".repeat(99)}\t\t\t${"x".repeat(100)}`],
    ["200-emoji", "😀".repeat(200)],
    ["201-emoji-fails", "😀".repeat(201)],
    ["200-with-a-lone-surrogate", `${"x".repeat(199)}\ud800`],
    ["201-with-a-lone-surrogate-fails", `${"x".repeat(200)}\ud800`],
    ["many-fold-runs", "a ".repeat(100)],
    ["empty-fails", ""],
    ["spaces-only-fails", "   "],
    ["nul-only-fails", "\u0000"],
    ["whitespace-controls-only-fails", "\t\n\u2028\u00a0\u0000\ufeff"],
    ["bom-only-fails", "\ufeff"],
    ["not-a-string-number", 5],
    ["not-a-string-null", null],
    ["not-a-string-true", true],
    ["not-a-string-array", []],
    ["not-a-string-array-of-one", ["a"]],
    ["not-a-string-long-array", Array.from({ length: 300 }, () => 1)],
    ["not-a-string-object", {}],
    ["not-a-string-object-length", { length: 3 }],
    ["not-a-string-object-length-big", { length: 999 }],
  ];
  return [
    rename("plain", titled("Renamed page")),
    rename("same-title", { pageId: "__s-u1__", title: "100% sure" }),
    rename("pinned-page-stays-pinned", { pageId: "__s-pa__", title: "Renamed alpha" }),
    rename("link-page", { pageId: "__s-pb__", title: "Renamed beta" }),
    rename("weird-visibility-reads-as-private", { pageId: "__s-u5__", title: "Renamed weird" }),
    rename("bot-page", { pageId: "__s-u3__", title: "renamed bot page" }),
    rename("group-page", { pageId: "__s-g1__", title: "renamed group page" }),
    ...titles.map(([name, title]) => rename(`title-${name}`, titled(title))),
    rename("unknown-page", { pageId: "nope", title: "x" }),
    rename("other-members-page", { pageId: "__s-x2__", title: "x" }),
    rename("other-space-page-from-space-one", { pageId: "__s-x1__", title: "x" }),
    rename(
      "other-space-page-from-space-two",
      { pageId: "__s-x1__", title: "renamed x" },
      { space: 1 },
    ),
    rename("space-one-page-from-space-two", { pageId: "__s-u1__", title: "x" }, { space: 1 }),
    rename("space-three-sees-nothing", { pageId: "__s-u1__", title: "x" }, { space: 2 }),
    rename("page-id-empty", { pageId: "", title: "x" }),
    rename("page-id-number", { pageId: 5, title: "x" }),
    rename("page-id-null", { pageId: null, title: "x" }),
    rename("page-id-array", { pageId: [], title: "x" }),
    rename("page-id-object-length", { pageId: { length: 0 }, title: "x" }),
    rename("page-id-nul", { pageId: "a\u0000b", title: "x" }),
    rename("missing-page-id", { title: "x" }),
    rename("missing-title", { pageId: "__s-u1__" }),
    rename("missing-both", {}),
    rename("both-invalid", { pageId: "", title: " " }),
    rename("extra-key-is-refused", { pageId: "__s-u1__", title: "x", more: 1 }),
    rename("extra-keys-in-js-order", { b: 1, 2: 1, pageId: "__s-u1__", title: "x", a: 1, 1: 1 }),
    rename("extra-key-and-invalid-values", { zzz: 1, pageId: "", title: " ", aaa: 2 }),
    rename("extra-key-and-unknown-page", { pageId: "nope", title: "x", more: 1 }),
    rename("array-input", []),
    rename("null-input", null),
    rename("no-input", undefined),
    rename("string-input", "x"),
    rename("number-input", 5),
    rename("anonymous", titled("x"), { anonymous: true }),
    rename(
      "stored-version-zero-fails-the-output-check-after-the-write",
      { pageId: "__s-bad__", title: "fixed" },
      { seed: badPage({ currentVersion: 0 }) },
    ),
    rename(
      "stored-long-title-is-replaced",
      { pageId: "__s-bad__", title: "short" },
      { seed: badPage({ title: "t".repeat(201) }) },
    ),
    pin("pin-a-loose-page", { pageId: "__s-u1__", pinned: true }),
    pin("unpin-a-pinned-page", { pageId: "__s-pa__", pinned: false }),
    pin("pin-a-pinned-page-writes-nothing", { pageId: "__s-pa__", pinned: true }),
    pin("unpin-a-loose-page-writes-nothing", { pageId: "__s-u1__", pinned: false }),
    pin("unpin-the-link-page", { pageId: "__s-pb__", pinned: false }),
    pin("weird-visibility-reads-as-private", { pageId: "__s-u5__", pinned: true }),
    pin("bot-page", { pageId: "__s-u3__", pinned: true }),
    pin("group-page", { pageId: "__s-g1__", pinned: true }),
    pin("pin-time-tie", { pageId: "__s-pd__", pinned: false }),
    pin("unknown-page", { pageId: "nope", pinned: true }),
    pin("other-members-page", { pageId: "__s-x2__", pinned: true }),
    pin("other-space-page-from-space-one", { pageId: "__s-x1__", pinned: true }),
    pin("other-space-page-from-space-two", { pageId: "__s-x1__", pinned: true }, { space: 1 }),
    pin("space-one-page-from-space-two", { pageId: "__s-u1__", pinned: true }, { space: 1 }),
    pin("pinned-string", { pageId: "__s-u1__", pinned: "true" }),
    pin("pinned-number", { pageId: "__s-u1__", pinned: 1 }),
    pin("pinned-null", { pageId: "__s-u1__", pinned: null }),
    pin("pinned-array", { pageId: "__s-u1__", pinned: [] }),
    pin("pinned-object", { pageId: "__s-u1__", pinned: {} }),
    pin("pinned-missing", { pageId: "__s-u1__" }),
    pin("page-id-empty", { pageId: "", pinned: true }),
    pin("page-id-number", { pageId: 5, pinned: true }),
    pin("page-id-null", { pageId: null, pinned: true }),
    pin("page-id-array", { pageId: [], pinned: true }),
    pin("page-id-nul", { pageId: "a\u0000b", pinned: true }),
    pin("missing-both", {}),
    pin("both-invalid", { pageId: "", pinned: "yes" }),
    pin("extra-key-is-refused", { pageId: "__s-u1__", pinned: true, more: 1 }),
    pin("extra-key-and-invalid-values", { zzz: 1, pageId: "", pinned: 5 }),
    pin("extra-key-and-unknown-page", { pageId: "nope", pinned: true, more: 1 }),
    pin("array-input", []),
    pin("null-input", null),
    pin("no-input", undefined),
    pin("string-input", "x"),
    pin("anonymous", { pageId: "__s-u1__", pinned: true }, { anonymous: true }),
    pin(
      "stored-long-title-fails-the-output-check-after-the-pin",
      { pageId: "__s-bad__", pinned: true },
      { seed: badPage({ title: "t".repeat(201) }) },
    ),
    pin(
      "stored-long-title-already-pinned-fails-without-a-write",
      { pageId: "__s-bad__", pinned: true },
      { seed: badPage({ title: "t".repeat(201) }, true) },
    ),
    pin(
      "stored-version-zero-fails-the-output-check-after-the-pin",
      { pageId: "__s-bad__", pinned: true },
      { seed: badPage({ currentVersion: 0 }) },
    ),
  ];
}

/** Three connections of the member (`__s-cr1__`, `__s-cr2__`) and another member's (`__s-cro__`). */
async function seedCredentials(seeded: Seeded) {
  const other = `${seeded.userId}-other`;
  await system.user.create({
    data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
  });
  const credential = (key: string, userId: string, label: string) =>
    system.userModelCredential.create({
      data: {
        id: `${seeded.userId}-${key}`,
        userId,
        provider: "openai",
        label,
        secretId: `${seeded.userId}-secret-${key}`,
        createdAt: new Date(PAGE_BASE),
        updatedAt: new Date(PAGE_BASE),
      },
    });
  await credential("cr1", seeded.userId, "Old name");
  await credential("cr2", seeded.userId, "Sibling");
  await credential("cro", other, "Other member");
}

function modelRenameCases(): Case[] {
  const rename = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mr-${name}`,
    procedure: "models.rename",
    input,
    seed: seedCredentials,
    ...extra,
  });
  const labeled = (label: unknown) => ({ credentialId: "__s-cr1__", label });
  const labels: Array<[string, unknown]> = [
    ["plain", "New name"],
    ["same-label", "Old name"],
    ["trimmed", " \t padded \u00a0\n"],
    ["inner-whitespace-is-kept", "a \t b"],
    ["nul", "a\u0000b"],
    ["nul-at-the-end", "ab\u0000"],
    ["nul-only", "\u0000"],
    ["nul-between-spaces", " \u0000 "],
    ["lone-high-surrogate", "a\ud800"],
    ["lone-low-surrogate", "\udc00b"],
    ["valid-pair", "x\ud83d\ude00y"],
    ["unicode", "Ключ 日本語"],
    ["markup", '<b> & "q"'],
    ["80-characters", "x".repeat(80)],
    ["81-characters-fails", "x".repeat(81)],
    ["80-characters-padded", `  ${"x".repeat(80)}\t`],
    ["81-characters-padded-fails", `     ${"x".repeat(81)}`],
    ["80-emoji", "😀".repeat(80)],
    ["81-emoji-fails", "😀".repeat(81)],
    ["empty-fails", ""],
    ["spaces-only-fails", "  "],
    ["unicode-spaces-only-fails", "\u3000\u2003"],
    ["bom-only-fails", "\ufeff"],
    ["line-separator-only-fails", "\u2028"],
    ["not-a-string-number", 5],
    ["not-a-string-null", null],
    ["not-a-string-true", true],
    ["not-a-string-array", []],
    ["not-a-string-array-of-one", [1]],
    ["not-a-string-array-of-81", Array.from({ length: 81 }, () => 1)],
    ["not-a-string-object", {}],
    ["not-a-string-object-length-zero", { length: 0 }],
    ["not-a-string-object-length-big", { length: 999 }],
  ];
  return [
    ...labels.map(([name, label]) => rename(`label-${name}`, labeled(label))),
    rename("renamed-from-space-two", labeled("From space two"), { space: 1 }),
    rename("renamed-from-space-three", labeled("From space three"), { space: 2 }),
    rename("sibling-connection", { credentialId: "__s-cr2__", label: "Renamed sibling" }),
    rename("other-members-connection", { credentialId: "__s-cro__", label: "x" }),
    rename("unknown-connection", { credentialId: "nope", label: "x" }),
    rename("id-nul", { credentialId: "a\u0000b", label: "x" }),
    rename("id-empty", { credentialId: "", label: "x" }),
    rename("id-number", { credentialId: 5, label: "x" }),
    rename("id-null", { credentialId: null, label: "x" }),
    rename("id-array", { credentialId: [], label: "x" }),
    rename("id-object-length", { credentialId: { length: 0 }, label: "x" }),
    rename("missing-id", { label: "x" }),
    rename("missing-label", { credentialId: "__s-cr1__" }),
    rename("missing-both", {}),
    rename("both-invalid", { credentialId: "", label: " " }),
    rename("both-invalid-types", { credentialId: 5, label: 7 }),
    rename("extra-keys-are-ignored", {
      credentialId: "__s-cr1__",
      label: "With extras",
      more: 1,
      2: 3,
    }),
    rename("extra-keys-and-unknown-connection", { credentialId: "nope", label: "x", more: 1 }),
    rename("array-input", []),
    rename("null-input", null),
    rename("no-input", undefined),
    rename("string-input", "x"),
    rename("number-input", 5),
    rename("anonymous", labeled("x"), { anonymous: true }),
  ];
}

/**
 * Files for the artifact reads, in the first Space unless noted: report.md in four versions (the newest visible
 * one has a run; the fourth is an MCP app's hidden HTML), another member's upload, a bot-made image, two files
 * with the same time, group files, a standalone file, files of an archived bot and of no bot, every hidden type,
 * a file made after now and one in the second Space. Bots: `__s-ab1__`, `__s-ab2__`, `__s-ab3__` (no files),
 * `__s-abarch__` (archived), `__s-abx__` (second Space).
 */
async function seedArtifacts(seeded: Seeded) {
  const u = seeded.userId;
  const other = `${u}-other`;
  await system.user.create({
    data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
  });
  const hour = 3_600_000;
  const base = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
  const at = (hoursAgo: number) => new Date(base - hoursAgo * hour);
  for (const [key, space, archived] of [
    ["ab1", 0, false],
    ["ab2", 0, false],
    ["ab3", 0, false],
    ["abarch", 0, true],
    ["abx", 1, false],
  ] as const) {
    await system.bot.create({
      data: {
        id: `${u}-${key}`,
        spaceId: seeded.spaces[space],
        userId: u,
        name: key,
        color: "blue",
        archivedAt: archived ? new Date(base) : null,
      },
    });
  }
  await system.chatGroup.create({
    data: { id: `${u}-ag1`, spaceId: seeded.spaces[0], userId: u, name: "Group" },
  });
  const file = (key: string, over: Record<string, unknown>) =>
    system.artifact.create({
      data: {
        id: `${u}-${key}`,
        spaceId: seeded.spaces[0],
        userId: u,
        botId: `${u}-ab1`,
        name: "file.txt",
        description: null,
        mimeType: "text/plain",
        size: 12,
        hash: "h",
        storageKey: `k-${key}`,
        version: 1,
        createdAt: new Date(base),
        ...over,
      },
    });
  const root = `${u}-r1`;
  await file("r1", { name: "report.md", description: "First", createdAt: at(30) });
  await file("r2", { name: "report.md", version: 2, rootArtifactId: root, createdAt: at(20) });
  await file("r3", {
    name: "report.md",
    version: 3,
    rootArtifactId: root,
    runId: "run-r",
    description: "Latest",
    createdAt: at(10),
  });
  await file("r4", {
    name: "report.md",
    version: 4,
    rootArtifactId: root,
    mimeType: "text/html;profile=mcp-app",
    createdAt: at(9),
  });
  await file("s1", { name: "notes.txt", botId: `${u}-ab2`, userId: other, createdAt: at(25) });
  await file("t1", {
    name: "made.png",
    mimeType: "image/png",
    botId: `${u}-ab2`,
    runId: "run-t",
    createdAt: at(40),
  });
  await file("c1", { name: "Case.txt", createdAt: at(15) });
  await file("c2", { name: "case.TXT", createdAt: at(15) });
  await file("g1", { name: "group.txt", groupId: `${u}-ag1`, createdAt: at(12) });
  await file("g2", { name: "group-only.txt", botId: null, groupId: `${u}-ag1`, createdAt: at(11) });
  await file("st1", { name: "report.md", standalone: true, createdAt: at(8) });
  await file("a1", { name: "gone.txt", botId: `${u}-abarch`, createdAt: at(6) });
  await file("nb", { name: "orphan.txt", botId: null, createdAt: at(3) });
  await file("u1", {
    name: '日本語 <b> & "q" \u2028',
    mimeType: "text/plain; charset=utf-8",
    description: "d",
    size: 2147483647,
    createdAt: at(2),
  });
  await file("hv", { name: "big-version.txt", version: 2147483647, createdAt: at(1) });
  await file("app", { name: "app.html", mimeType: "text/html;profile=mcp-app", createdAt: at(7) });
  for (const [index, mimeType] of [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ].entries()) {
    await file(`ss${index}`, {
      name: `shot${index}.png`,
      mimeType: `${mimeType};profile=step-screenshot`,
      createdAt: at(4 + index),
    });
  }
  // Hidden types are matched exactly: this one is a file like any other.
  await file("ssc", {
    name: "shot-case.png",
    mimeType: "Image/Png;profile=step-screenshot",
    createdAt: at(5),
  });
  await file("fut", { name: "future.txt", createdAt: THREAD_FUTURE });
  await system.artifact.create({
    data: {
      id: `${u}-x1`,
      spaceId: seeded.spaces[1],
      userId: u,
      botId: `${u}-abx`,
      name: "elsewhere.txt",
      description: null,
      mimeType: "text/plain",
      size: 1,
      hash: "h",
      storageKey: "k-x1",
      version: 1,
      createdAt: at(1),
    },
  });
}

function artifactCases(): Case[] {
  const base = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
  const iso = (hoursAgo: number) => new Date(base - hoursAgo * 3_600_000).toISOString();
  const listCase = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `art-list-${name}`,
    procedure: "artifacts.list",
    input,
    seed: seedArtifacts,
    unordered: true,
    ...extra,
  });
  const spaceCase = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `art-space-${name}`,
    procedure: "artifacts.listSpace",
    input,
    seed: seedArtifacts,
    ...extra,
  });
  const versionsCase = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `art-versions-${name}`,
    procedure: "artifacts.listVersions",
    input,
    seed: seedArtifacts,
    ...extra,
  });
  /** A cursor as the server writes it, or as a caller might alter it. */
  const cur = (fields: Record<string, unknown>) =>
    `v1.${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
  const good = { createdAt: iso(10), id: "zzz", botId: null, madeByBots: false, asOf: iso(0) };
  /** A cursor bound to one of the case's own bots, whose ids depend on the case name. */
  const botCursor = (
    name: string,
    input: Record<string, unknown>,
    fields: Record<string, unknown>,
    bot: string | null,
    extra: Partial<Case> = {},
  ) =>
    spaceCase(
      name,
      {
        ...input,
        cursor: cur({
          ...fields,
          botId: bot === null ? null : `${ids(`art-space-${name}`).userId}-${bot}`,
        }),
      },
      extra,
    );
  const rawCursor = (text: string) => `v1.${Buffer.from(text).toString("base64url")}`;
  const seedWith = (more: (seeded: Seeded) => Promise<unknown>) => async (seeded: Seeded) => {
    await seedArtifacts(seeded);
    await more(seeded);
  };
  const extraFile = (key: string, over: Record<string, unknown>) => async (seeded: Seeded) =>
    system.artifact.create({
      data: {
        id: `${seeded.userId}-${key}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        botId: `${seeded.userId}-ab1`,
        name: "extra.txt",
        description: null,
        mimeType: "text/plain",
        size: 1,
        hash: "h",
        storageKey: `k-${key}`,
        version: 1,
        createdAt: new Date(base - 100 * 3_600_000),
        ...over,
      },
    });
  const farFuture = new Date(Date.now() + 60 * 86_400_000).toISOString();
  return [
    // artifacts.list: one bot's own chat, every version, no group file and no hidden type, in no set order.
    listCase("bot-one", { botId: "__s-ab1__" }),
    listCase("bot-two", { botId: "__s-ab2__" }),
    listCase("bot-without-files", { botId: "__s-ab3__" }),
    listCase("archived-bot", { botId: "__s-abarch__" }),
    listCase("unknown-bot", { botId: "nope" }),
    listCase("bot-of-another-space", { botId: "__s-abx__" }),
    listCase("bot-of-another-space-from-its-space", { botId: "__s-abx__" }, { space: 1 }),
    listCase("group-id-as-bot", { botId: "__s-ag1__" }),
    listCase("space-three", { botId: "__s-ab1__" }, { space: 2 }),
    listCase("extra-keys-are-ignored", { botId: "__s-ab1__", more: 1, 2: 3 }),
    listCase(
      "empty-run-id-fails-the-output-check",
      { botId: "__s-ab1__" },
      { seed: seedWith(extraFile("z1", { runId: "" })) },
    ),
    listCase(
      "empty-run-id-on-another-bot-is-not-listed",
      { botId: "__s-ab2__" },
      { seed: seedWith(extraFile("z1", { runId: "" })) },
    ),
    listCase("bot-id-empty", { botId: "" }),
    listCase("bot-id-number", { botId: 5 }),
    listCase("bot-id-null", { botId: null }),
    listCase("bot-id-array", { botId: [] }),
    listCase("bot-id-object-length", { botId: { length: 0 } }),
    listCase("missing-bot-id", {}),
    listCase("array-input", []),
    listCase("null-input", null),
    listCase("no-input", undefined),
    listCase("string-input", "x"),
    listCase("anonymous", { botId: "__s-ab1__" }, { anonymous: true }),

    // artifacts.listSpace: one entry per file family, newest first, with the count of its visible versions.
    spaceCase("all", {}),
    spaceCase("empty-object-with-extra-keys", { more: 1 }),
    spaceCase("limit-1-walk", { limit: 1 }, { paginate: true }),
    spaceCase("limit-2-walk", { limit: 2 }, { paginate: true }),
    spaceCase("limit-3-walk", { limit: 3 }, { paginate: true }),
    spaceCase("limit-5-walk", { limit: 5 }, { paginate: true }),
    spaceCase("limit-60", { limit: 60 }),
    spaceCase("made-by-bots", { madeByBots: true }),
    spaceCase("made-by-bots-false", { madeByBots: false }),
    spaceCase("made-by-bots-walk", { madeByBots: true, limit: 1 }, { paginate: true }),
    spaceCase("bot-one", { botId: "__s-ab1__" }),
    spaceCase("bot-one-walk", { botId: "__s-ab1__", limit: 2 }, { paginate: true }),
    spaceCase("bot-one-made-by-bots", { botId: "__s-ab1__", madeByBots: true }),
    spaceCase("bot-two", { botId: "__s-ab2__" }),
    spaceCase("bot-two-walk", { botId: "__s-ab2__", limit: 1 }, { paginate: true }),
    spaceCase("bot-without-files", { botId: "__s-ab3__" }),
    spaceCase("archived-bot", { botId: "__s-abarch__" }),
    spaceCase("unknown-bot", { botId: "nope" }),
    spaceCase("unknown-bot-before-the-cursor", { botId: "nope", cursor: "junk" }),
    spaceCase("bot-of-another-space", { botId: "__s-abx__" }),
    spaceCase("group-id-as-bot", { botId: "__s-ag1__" }),
    spaceCase("second-space", {}, { space: 1 }),
    spaceCase("second-space-bot", { botId: "__s-abx__" }, { space: 1 }),
    spaceCase("third-space", {}, { space: 2 }),
    spaceCase(
      "empty-run-id-on-the-newest-fails-the-output-check",
      {},
      { seed: seedWith(extraFile("z1", { runId: "" })) },
    ),
    spaceCase(
      "empty-run-id-just-past-the-page-is-not-parsed",
      { limit: 13 },
      { seed: seedWith(extraFile("z1", { runId: "" })) },
    ),
    spaceCase(
      "empty-run-id-last-in-the-page-fails",
      { limit: 14 },
      { seed: seedWith(extraFile("z1", { runId: "" })) },
    ),
    spaceCase(
      "empty-run-id-on-an-older-version",
      {},
      {
        seed: seedWith(async (seeded) => {
          await extraFile("y1", { name: "y.txt", runId: "" })(seeded);
          await extraFile("y2", {
            name: "y.txt",
            version: 2,
            rootArtifactId: `${seeded.userId}-y1`,
            createdAt: new Date(base - 99 * 3_600_000),
          })(seeded);
        }),
      },
    ),
    spaceCase("limit-0", { limit: 0 }),
    spaceCase("limit-61", { limit: 61 }),
    spaceCase("limit-negative", { limit: -1 }),
    spaceCase("limit-fraction", { limit: 1.5 }),
    spaceCase("limit-string", { limit: "5" }),
    spaceCase("limit-null", { limit: null }),
    spaceCase("limit-true", { limit: true }),
    spaceCase("limit-huge", { limit: 1e300 }),
    spaceCase("limit-unsafe", { limit: Number.MAX_SAFE_INTEGER + 1 }),
    spaceCase("made-by-bots-string", { madeByBots: "yes" }),
    spaceCase("made-by-bots-number", { madeByBots: 1 }),
    spaceCase("made-by-bots-null", { madeByBots: null }),
    spaceCase("bot-id-empty", { botId: "" }),
    spaceCase("bot-id-number", { botId: 5 }),
    spaceCase("bot-id-null", { botId: null }),
    spaceCase("bot-id-array", { botId: [] }),
    spaceCase("cursor-number", { cursor: 5 }),
    spaceCase("cursor-null", { cursor: null }),
    spaceCase("cursor-array", { cursor: [] }),
    spaceCase("cursor-object", { cursor: {} }),
    spaceCase("cursor-true", { cursor: true }),
    spaceCase("cursor-empty-string-is-no-cursor", { cursor: "" }),
    spaceCase("everything-invalid", { botId: 5, madeByBots: "x", cursor: 5, limit: 0 }),
    spaceCase("array-input", []),
    spaceCase("null-input", null),
    spaceCase("no-input", undefined),
    spaceCase("string-input", "x"),
    spaceCase("anonymous", {}, { anonymous: true }),

    // Cursors: what the server writes and what a caller might change.
    spaceCase("cursor-valid-middle", { limit: 3, cursor: cur(good) }),
    spaceCase("cursor-valid-walk", { limit: 2, cursor: cur(good) }, { paginate: true }),
    spaceCase("cursor-at-the-oldest", { cursor: cur({ ...good, createdAt: iso(40), id: "zzz" }) }),
    spaceCase("cursor-same-time-different-id", {
      cursor: cur({ ...good, createdAt: iso(15), id: "ct-" }),
    }),
    spaceCase("cursor-asof-freezes-newer-versions", {
      cursor: cur({ ...good, createdAt: iso(0), asOf: iso(15) }),
    }),
    spaceCase("cursor-asof-before-everything", {
      cursor: cur({ ...good, createdAt: iso(0), asOf: iso(400) }),
    }),
    spaceCase("cursor-asof-after-the-future-file", {
      cursor: cur({ ...good, createdAt: "2100-01-01T00:00:00.000Z", asOf: farFuture }),
      limit: 2,
    }),
    botCursor("cursor-scope-bot-matches", { botId: "__s-ab1__" }, good, "ab1"),
    botCursor("cursor-scope-other-bot", { botId: "__s-ab1__" }, good, "ab2"),
    botCursor("cursor-scope-bot-in-the-cursor-only", {}, good, "ab1"),
    spaceCase("cursor-scope-bot-in-the-input-only", { botId: "__s-ab1__", cursor: cur(good) }),
    spaceCase("cursor-scope-made-by-bots-matches", {
      madeByBots: true,
      cursor: cur({ ...good, madeByBots: true }),
    }),
    spaceCase("cursor-scope-made-by-bots-in-the-input-only", {
      madeByBots: true,
      cursor: cur(good),
    }),
    spaceCase("cursor-scope-made-by-bots-in-the-cursor-only", {
      cursor: cur({ ...good, madeByBots: true }),
    }),
    spaceCase("cursor-made-by-bots-absent-reads-false", {
      cursor: cur({ createdAt: good.createdAt, id: good.id, botId: null, asOf: good.asOf }),
    }),
    spaceCase("cursor-made-by-bots-null-reads-false", {
      cursor: cur({ ...good, madeByBots: null }),
    }),
    spaceCase("cursor-made-by-bots-string", { cursor: cur({ ...good, madeByBots: "yes" }) }),
    spaceCase("cursor-made-by-bots-number", { cursor: cur({ ...good, madeByBots: 1 }) }),
    spaceCase("cursor-bot-id-missing", {
      cursor: cur({ createdAt: good.createdAt, id: good.id, madeByBots: false, asOf: good.asOf }),
    }),
    spaceCase("cursor-bot-id-number", { cursor: cur({ ...good, botId: 5 }) }),
    spaceCase("cursor-bot-id-empty-string", { cursor: cur({ ...good, botId: "" }) }),
    spaceCase("cursor-id-empty", { cursor: cur({ ...good, id: "" }) }),
    spaceCase("cursor-id-null", { cursor: cur({ ...good, id: null }) }),
    spaceCase("cursor-id-number", { cursor: cur({ ...good, id: 5 }) }),
    spaceCase("cursor-id-missing", {
      cursor: cur({ createdAt: good.createdAt, botId: null, madeByBots: false, asOf: good.asOf }),
    }),
    spaceCase("cursor-id-unicode", { cursor: cur({ ...good, id: "日本語" }) }),
    spaceCase("cursor-id-emoji", { cursor: cur({ ...good, id: "😀" }) }),
    spaceCase("cursor-id-nul", { cursor: cur({ ...good, id: "a\u0000b" }) }),
    spaceCase("cursor-id-long", { cursor: cur({ ...good, id: "x".repeat(10_000) }) }),
    spaceCase("cursor-created-at-missing", {
      cursor: cur({ id: good.id, botId: null, madeByBots: false, asOf: good.asOf }),
    }),
    spaceCase("cursor-created-at-number", { cursor: cur({ ...good, createdAt: 5 }) }),
    spaceCase("cursor-created-at-null", { cursor: cur({ ...good, createdAt: null }) }),
    spaceCase("cursor-created-at-text", { cursor: cur({ ...good, createdAt: "yesterday" }) }),
    spaceCase("cursor-created-at-date-only", { cursor: cur({ ...good, createdAt: "2026-04-30" }) }),
    spaceCase("cursor-created-at-offset", {
      cursor: cur({ ...good, createdAt: "2026-04-30T10:00:00+05:30" }),
    }),
    spaceCase("cursor-created-at-long-fraction", {
      cursor: cur({ ...good, createdAt: "2026-04-30T10:00:00.1234567Z" }),
    }),
    spaceCase("cursor-created-at-hour-24", {
      cursor: cur({ ...good, createdAt: "2026-05-01T24:00:00Z" }),
    }),
    spaceCase("cursor-created-at-hour-25", {
      cursor: cur({ ...good, createdAt: "2026-05-01T25:00:00Z" }),
    }),
    // ECMAScript TimeClip: one millisecond outside the range Date can represent is Invalid Date.
    spaceCase("cursor-created-at-just-past-max-time", {
      cursor: cur({ ...good, createdAt: "+275760-09-13T00:00:00.001Z" }),
    }),
    spaceCase("cursor-created-at-just-below-min-time", {
      cursor: cur({ ...good, createdAt: "-271821-04-19T23:59:59.999Z" }),
    }),
    spaceCase("cursor-as-of-just-past-max-time", {
      cursor: cur({ ...good, asOf: "+275760-09-13T00:00:00.001Z" }),
    }),
    spaceCase("cursor-as-of-just-below-min-time", {
      cursor: cur({ ...good, asOf: "-271821-04-19T23:59:59.999Z" }),
    }),
    spaceCase("cursor-created-at-feb-30", { cursor: cur({ ...good, createdAt: "2026-02-30" }) }),
    spaceCase("cursor-created-at-month-13", { cursor: cur({ ...good, createdAt: "2026-13-01" }) }),
    spaceCase("cursor-as-of-missing", {
      cursor: cur({ createdAt: good.createdAt, id: good.id, botId: null, madeByBots: false }),
    }),
    spaceCase("cursor-as-of-number", { cursor: cur({ ...good, asOf: 5 }) }),
    spaceCase("cursor-as-of-null", { cursor: cur({ ...good, asOf: null }) }),
    spaceCase("cursor-as-of-text", { cursor: cur({ ...good, asOf: "soon" }) }),
    spaceCase("cursor-as-of-offset", {
      cursor: cur({ ...good, asOf: "2026-05-01T17:30:00+05:30" }),
    }),
    spaceCase("cursor-extra-keys", { cursor: cur({ ...good, more: [1] }) }),
    spaceCase("cursor-keys-in-another-order", {
      cursor: cur({
        asOf: good.asOf,
        madeByBots: false,
        botId: null,
        id: "zzz",
        createdAt: good.createdAt,
      }),
    }),
    spaceCase("cursor-duplicate-keys-last-wins", {
      cursor: rawCursor(
        `{"createdAt":"${good.createdAt}","id":"a","id":"zzz","botId":null,"asOf":"${good.asOf}"}`,
      ),
    }),
    spaceCase("cursor-upper-case-keys", {
      cursor: cur({ CreatedAt: good.createdAt, ID: "zzz", BotId: null, AsOf: good.asOf }),
    }),
    spaceCase("cursor-capitalized-id", {
      cursor: cur({ createdAt: good.createdAt, Id: "zzz", botId: null, asOf: good.asOf }),
    }),
    spaceCase("cursor-no-prefix", { cursor: cur(good).slice(3) }),
    spaceCase("cursor-prefix-upper-case", { cursor: `V1.${cur(good).slice(3)}` }),
    spaceCase("cursor-prefix-v2", { cursor: `v2.${cur(good).slice(3)}` }),
    spaceCase("cursor-prefix-without-dot", { cursor: `v1${cur(good).slice(3)}` }),
    spaceCase("cursor-prefix-only", { cursor: "v1." }),
    spaceCase("cursor-junk", { cursor: "v1.!!!" }),
    spaceCase("cursor-not-json", { cursor: rawCursor("nope") }),
    spaceCase("cursor-null-document", { cursor: rawCursor("null") }),
    spaceCase("cursor-array-document", { cursor: rawCursor("[]") }),
    spaceCase("cursor-number-document", { cursor: rawCursor("5") }),
    spaceCase("cursor-string-document", { cursor: rawCursor('"x"') }),
    spaceCase("cursor-empty-object", { cursor: rawCursor("{}") }),
    spaceCase("cursor-padded", { cursor: `${cur(good)}==` }),
    spaceCase("cursor-standard-base64", {
      cursor: `v1.${Buffer.from(JSON.stringify({ ...good, id: "zz\u00ffz??>>" })).toString("base64")}`,
    }),
    spaceCase("cursor-whitespace-inside", {
      cursor: `${cur(good).slice(0, 14)} \n ${cur(good).slice(14)}`,
    }),
    spaceCase("cursor-junk-characters-inside", {
      cursor: `${cur(good).slice(0, 14)}*.${cur(good).slice(14)}`,
    }),
    spaceCase("cursor-byte-order-mark", { cursor: rawCursor(`\ufeff${JSON.stringify(good)}`) }),
    spaceCase("cursor-invalid-utf8-in-the-id", {
      cursor: `v1.${Buffer.concat([Buffer.from(`{"createdAt":"${good.createdAt}","id":"a`), Buffer.from([0xe2, 0x82]), Buffer.from(`b","botId":null,"asOf":"${good.asOf}"}`)]).toString("base64url")}`,
    }),

    // artifacts.listVersions: the family any version's id names, newest first, hidden members included.
    versionsCase("first-version", { familyId: "__s-r1__" }),
    versionsCase("middle-version", { familyId: "__s-r2__" }),
    versionsCase("newest-version", { familyId: "__s-r3__" }),
    versionsCase("hidden-member-of-the-family", { familyId: "__s-r4__" }),
    versionsCase("single-file", { familyId: "__s-s1__" }),
    versionsCase("standalone-file", { familyId: "__s-st1__" }),
    versionsCase("same-name-file-is-another-family", { familyId: "__s-c1__" }),
    versionsCase("mcp-app-html", { familyId: "__s-app__" }),
    versionsCase("group-file", { familyId: "__s-g1__" }),
    versionsCase("file-of-an-archived-bot", { familyId: "__s-a1__" }),
    versionsCase("file-of-no-bot", { familyId: "__s-nb__" }),
    versionsCase("file-with-the-largest-version", { familyId: "__s-hv__" }),
    versionsCase("file-made-after-now", { familyId: "__s-fut__" }),
    versionsCase("step-screenshot", { familyId: "__s-ss0__" }),
    versionsCase("step-screenshot-webp", { familyId: "__s-ss2__" }),
    versionsCase("step-screenshot-in-another-case-is-a-file", { familyId: "__s-ssc__" }),
    versionsCase("file-of-another-space", { familyId: "__s-x1__" }),
    versionsCase("file-of-another-space-from-its-space", { familyId: "__s-x1__" }, { space: 1 }),
    versionsCase("file-of-the-first-space-from-the-second", { familyId: "__s-r1__" }, { space: 1 }),
    versionsCase("unknown-file", { familyId: "nope" }),
    versionsCase("family-id-nul", { familyId: "a\u0000b" }),
    versionsCase("extra-keys-are-ignored", { familyId: "__s-r2__", more: 1 }),
    versionsCase("family-id-empty", { familyId: "" }),
    versionsCase("family-id-number", { familyId: 5 }),
    versionsCase("family-id-null", { familyId: null }),
    versionsCase("family-id-array", { familyId: [] }),
    versionsCase("family-id-object-length", { familyId: { length: 0 } }),
    versionsCase("missing-family-id", {}),
    versionsCase("array-input", []),
    versionsCase("null-input", null),
    versionsCase("no-input", undefined),
    versionsCase("string-input", "x"),
    versionsCase("anonymous", { familyId: "__s-r1__" }, { anonymous: true }),
  ];
}

// ---------------------------------------------------------------- memory (Lane F)
//
// Memory documents are the first contract rows whose text is rkz1 ciphertext. Seeds write through
// the real Prisma client, so TypeScript seals them; the Go side must open those values with the
// same keys, and every write it makes must open again through the TypeScript extension — which is
// what databaseState checks below by reading the raw column and opening it here.

type MemorySeedDoc = {
  id?: string;
  scope: "bot" | "user";
  path: string;
  content: string;
  botId?: string | null;
  userId?: string;
  revision?: number;
  updatedAt?: Date;
  space?: 0 | 1 | 2;
};

/** Seals the documents through the API's own client, as a real writer would. */
async function seedMemoryDocuments(seeded: Seeded, docs: MemorySeedDoc[]) {
  for (const [index, doc] of docs.entries()) {
    await system.memoryDocument.create({
      data: {
        id: doc.id ?? `${seeded.userId}-mem${index + 1}`,
        spaceId: seeded.spaces[doc.space ?? 0],
        userId: doc.userId ?? seeded.userId,
        botId: doc.botId ?? null,
        scope: doc.scope,
        path: doc.path,
        content: doc.content,
        revision: doc.revision ?? 1,
        ...(doc.updatedAt ? { createdAt: doc.updatedAt, updatedAt: doc.updatedAt } : {}),
      },
    });
  }
}

/** A bot (`__membot__`) and, unless `thread: false`, its thread in the first Space. */
async function seedMemoryBot(
  seeded: Seeded,
  options: { archived?: boolean; space?: 0 | 1 | 2; thread?: boolean; summary?: string } = {},
) {
  const spaceId = seeded.spaces[options.space ?? 0];
  await system.bot.create({
    data: {
      id: `${seeded.userId}-membot`,
      spaceId,
      userId: seeded.userId,
      name: "Memory bot",
      color: "blue",
      ...(options.archived ? { archivedAt: new Date(Date.UTC(2020, 0, 1)) } : {}),
    },
  });
  if (options.thread === false) return;
  await system.thread.create({
    data: {
      id: `${seeded.userId}-membot-thread`,
      spaceId,
      userId: seeded.userId,
      botId: `${seeded.userId}-membot`,
      nextMessageSeq: 0,
      nextEventSeq: 0,
      ...(options.summary === undefined ? {} : { historyCompactionSummary: options.summary }),
    },
  });
}

/** The stored (sealed) content of a memory document. */
async function storedMemoryContent(id: string): Promise<string> {
  const rows =
    (await system.$queryRaw`SELECT content FROM memory_documents WHERE id = ${id}`) as Array<{
      content: string;
    }>;
  return rows[0]!.content;
}

async function overwriteMemoryContent(id: string, content: string) {
  await system.$executeRaw`UPDATE memory_documents SET content = ${content} WHERE id = ${id}`;
}

/** A valid envelope whose body is one different base64url character: the tag no longer checks. */
function tamperBody(value: string): string {
  const bodyStart = value.indexOf(":", "rkz1:".length) + 1;
  const replacement = value[bodyStart] === "A" ? "B" : "A";
  return `${value.slice(0, bodyStart)}${replacement}${value.slice(bodyStart + 1)}`;
}

/** A valid envelope cut short inside its body (below the 12-byte IV plus 16-byte tag). */
function truncateBody(value: string): string {
  const bodyStart = value.indexOf(":", "rkz1:".length) + 1;
  return value.slice(0, bodyStart + 4);
}

const MEMORY_TIME = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
const memoryAt = (minutesAgo: number) => new Date(MEMORY_TIME - minutesAgo * 60_000);

/** The documents most memory cases share: a bot's index and notes, and the Space's shared memory. */
function seedMemoryLibrary(seeded: Seeded) {
  return seedMemoryDocuments(seeded, [
    {
      id: `${seeded.userId}-mem1`,
      scope: "bot",
      path: "MEMORY.md",
      botId: `${seeded.userId}-membot`,
      content: "Memory notes\n\n- likes tea",
      revision: 3,
      updatedAt: memoryAt(10),
    },
    {
      id: `${seeded.userId}-mem2`,
      scope: "bot",
      path: "notes/shopping.md",
      botId: `${seeded.userId}-membot`,
      content: "milk\neggs",
      revision: 1,
      updatedAt: memoryAt(20),
    },
    {
      id: `${seeded.userId}-mem3`,
      scope: "user",
      path: "MEMORY.md",
      content: "shared preferences",
      revision: 7,
      updatedAt: memoryAt(30),
    },
    {
      id: `${seeded.userId}-mem4`,
      scope: "user",
      path: "house.md",
      botId: `${seeded.userId}-membot`,
      content: "bin day is Tuesday",
      revision: 2,
      updatedAt: memoryAt(40),
    },
  ]);
}

function memoryCases(): Case[] {
  const list = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mem-list-${name}`,
    procedure: "memory.list",
    input,
    seed: library,
    unordered: true,
    ...extra,
  });
  const exportCase = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mem-export-${name}`,
    procedure: "memory.exportMarkdown",
    input,
    // The join has no ORDER BY on either side; each document is still compared exactly.
    unorderedSections: true,
    ...extra,
  });
  const update = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mem-update-${name}`,
    procedure: "memory.update",
    input,
    ...extra,
  });
  const remove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mem-remove-${name}`,
    procedure: "memory.remove",
    input,
    ...extra,
  });
  const budget = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `mem-budget-${name}`,
    procedure: "memory.budget",
    input,
    ...extra,
  });
  /** A seed that adds the memory library and then one raw tamper of it. */
  const tampered = (change: (seeded: Seeded) => Promise<void>) => async (seeded: Seeded) => {
    await seedMemoryBot(seeded);
    await seedMemoryLibrary(seeded);
    await change(seeded);
  };
  const library = (seeded: Seeded) => seedMemoryBot(seeded).then(() => seedMemoryLibrary(seeded));

  return [
    // memory.list: every document of the Space, decrypted, optionally one bot or one scope.
    list("empty", {}),
    list("no-input", undefined),
    list("library", {}),
    list("bot", { botId: "__membot__" }),
    list("bot-unknown", { botId: "nope" }),
    list("scope-user", { scope: "user" }),
    list("scope-bot", { scope: "bot" }),
    list("extra-keys", { more: 1 }),
    list("invalid-scope", { scope: "space" }),
    list("invalid-scope-null", { scope: null }),
    list("invalid-types", { botId: 5, scope: 1 }),
    list("invalid-bot-empty", { botId: "" }),
    list("array-input", []),
    list("null-input", null),
    list("string-input", "x"),
    list("anonymous", {}, { anonymous: true }),
    list("from-another-space", {}, { space: 1 }),
    // A stored scope outside the enum is what the router's output parse refuses.
    list(
      "odd-scope-fails-the-output-check",
      {},
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            { id: `${seeded.userId}-mem1`, scope: "bot", path: "MEMORY.md", content: "ok" },
          ]);
          await system.$executeRaw`UPDATE memory_documents SET scope = 'space' WHERE id = ${`${seeded.userId}-mem1`}`;
        },
      },
    ),
    // Plaintext rows written before encryption read unchanged.
    list(
      "plaintext",
      {},
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            { id: `${seeded.userId}-mem1`, scope: "bot", path: "MEMORY.md", content: "sealed" },
          ]);
          await overwriteMemoryContent(`${seeded.userId}-mem1`, "legacy plaintext");
        },
      },
    ),
    // The crypto failures, which the API answers as a 500 rather than a value.
    list(
      "tampered",
      {},
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem1`,
            tamperBody(await storedMemoryContent(`${seeded.userId}-mem1`)),
          );
        }),
      },
    ),
    list(
      "truncated-body",
      {},
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem1`,
            truncateBody(await storedMemoryContent(`${seeded.userId}-mem1`)),
          );
        }),
      },
    ),
    list(
      "another-key",
      {},
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem1`,
            "rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          );
        }),
      },
    ),
    // The envelope is bound to its row: copied into another document of the same Space it fails.
    list(
      "content-of-another-row",
      {},
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem1`,
            await storedMemoryContent(`${seeded.userId}-mem2`),
          );
        }),
      },
    ),
    // ... and bound to its Space.
    list(
      "content-of-another-space",
      {},
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-memx`,
              scope: "bot",
              path: "MEMORY.md",
              content: "foreign secret",
              space: 2,
            },
            { id: `${seeded.userId}-mem1`, scope: "bot", path: "MEMORY.md", content: "own" },
          ]);
          await overwriteMemoryContent(
            `${seeded.userId}-mem1`,
            await storedMemoryContent(`${seeded.userId}-memx`),
          );
        },
      },
    ),

    // memory.exportMarkdown: `# path` and the content of every document, or of one bot's.
    exportCase("empty", {}),
    exportCase("no-input", undefined),
    exportCase("bot", { botId: "__membot__" }, { seed: library }),
    exportCase("bot-unknown", { botId: "nope" }, { seed: library }),
    exportCase("library", {}, { seed: library }),
    exportCase("extra-keys", { more: 1 }, { seed: library }),
    exportCase("invalid-bot", { botId: 5 }, { seed: library }),
    exportCase("invalid-bot-empty", { botId: "" }, { seed: library }),
    exportCase("array-input", []),
    exportCase("anonymous", {}, { anonymous: true, seed: library }),
    exportCase("from-another-space", {}, { seed: library, space: 1 }),
    exportCase(
      "tampered",
      {},
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem3`,
            tamperBody(await storedMemoryContent(`${seeded.userId}-mem3`)),
          );
        }),
      },
    ),

    // memory.update: replaces the content, bumps the revision, appends the sealed history row.
    update("content", { documentId: "__mem2__", content: "new list\n- bread" }, { seed: library }),
    update(
      "same-content",
      { documentId: "__mem1__", content: "# Memory\n\n- likes tea" },
      { seed: library },
    ),
    update("empty-content", { documentId: "__mem2__", content: "" }, { seed: library }),
    update(
      "huge-content",
      { documentId: "__mem2__", content: "x".repeat(40_000) },
      { seed: library },
    ),
    update(
      "unicode-content",
      { documentId: "__mem2__", content: "日本語 😀\u2028line\u0000nul" },
      { seed: library },
    ),
    update(
      "lone-surrogate-content",
      { documentId: "__mem2__", content: "a\ud800b" },
      { seed: library },
    ),
    update(
      "ciphertext-looking-content",
      { documentId: "__mem2__", content: "rkz1:zzzz:AAAA" },
      { seed: library },
    ),
    update(
      "expected-revision-matches",
      { documentId: "__mem2__", content: "kept", expectedRevision: 1 },
      { seed: library },
    ),
    update(
      "expected-revision-conflict",
      { documentId: "__mem2__", content: "lost", expectedRevision: 2 },
      { seed: library },
    ),
    update(
      "expected-revision-on-a-bumped-revision",
      { documentId: "__mem3__", content: "ok", expectedRevision: 7 },
      { seed: library },
    ),
    update(
      "expected-revision-zero",
      { documentId: "__mem2__", content: "x", expectedRevision: 0 },
      { seed: library },
    ),
    update(
      "expected-revision-negative",
      { documentId: "__mem2__", content: "x", expectedRevision: -1 },
      { seed: library },
    ),
    update(
      "expected-revision-float",
      { documentId: "__mem2__", content: "x", expectedRevision: 1.5 },
      { seed: library },
    ),
    update(
      "expected-revision-string",
      { documentId: "__mem2__", content: "x", expectedRevision: "1" },
      { seed: library },
    ),
    update(
      "expected-revision-null",
      { documentId: "__mem2__", content: "x", expectedRevision: null },
      { seed: library },
    ),
    update(
      "expected-revision-too-large",
      { documentId: "__mem2__", content: "x", expectedRevision: 9007199254740992 },
      { seed: library },
    ),
    update("missing-document", { documentId: "nope", content: "x" }, { seed: library }),
    update(
      "other-space-document",
      { documentId: "__memx__", content: "x" },
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-memx`,
              scope: "bot",
              path: "MEMORY.md",
              content: "elsewhere",
              space: 2,
            },
          ]);
        },
      },
    ),
    update(
      "other-users-document",
      { documentId: "__mem2__", content: "x" },
      {
        seed: async (seeded) => {
          const other = `${seeded.userId}-other`;
          await system.user.create({
            data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
          });
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mem2`,
              scope: "bot",
              path: "MEMORY.md",
              content: "theirs",
              userId: other,
            },
          ]);
        },
      },
    ),
    update(
      "plaintext-document",
      { documentId: "__mem2__", content: "resaved" },
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            { id: `${seeded.userId}-mem2`, scope: "bot", path: "MEMORY.md", content: "sealed" },
          ]);
          await overwriteMemoryContent(`${seeded.userId}-mem2`, "legacy plaintext");
        },
      },
    ),
    update(
      "revision-collision",
      { documentId: "__mem2__", content: "x" },
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mem2`,
              scope: "bot",
              path: "MEMORY.md",
              content: "sealed",
              revision: 1,
            },
          ]);
          await system.memoryRevision.create({
            data: {
              id: `${seeded.userId}-rev2`,
              documentId: `${seeded.userId}-mem2`,
              revision: 2,
              content: "taken",
              sourceRunId: null,
              sourceThreadId: null,
            },
          });
        },
      },
    ),
    update(
      "tampered-document",
      { documentId: "__mem2__", content: "x" },
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem2`,
            tamperBody(await storedMemoryContent(`${seeded.userId}-mem2`)),
          );
        }),
      },
    ),
    update("missing-content", { documentId: "__mem2__" }, { seed: library }),
    update("null-content", { documentId: "__mem2__", content: null }, { seed: library }),
    update("number-content", { documentId: "__mem2__", content: 5 }, { seed: library }),
    update("missing-document-id", { content: "x" }, { seed: library }),
    update("document-id-empty", { documentId: "", content: "x" }, { seed: library }),
    update("document-id-number", { documentId: 5, content: "x" }, { seed: library }),
    update("array-input", [], { seed: library }),
    update("null-input", null, { seed: library }),
    update("extra-keys", { documentId: "__mem2__", content: "x", more: 1 }, { seed: library }),
    update(
      "anonymous",
      { documentId: "__mem2__", content: "x" },
      { seed: library, anonymous: true },
    ),
    update(
      "from-another-space",
      { documentId: "__mem1__", content: "x" },
      { seed: library, space: 1 },
    ),

    // memory.remove: the index is refused, other documents and their revisions go.
    remove(
      "document",
      { documentId: "__mem2__" },
      {
        seed: async (seeded) => {
          await library(seeded);
          await system.memoryDocument.update({
            where: { id: `${seeded.userId}-mem2` },
            data: { revision: 2 },
          });
          await system.memoryRevision.create({
            data: {
              id: `${seeded.userId}-rev1`,
              documentId: `${seeded.userId}-mem2`,
              revision: 1,
              content: "old",
              sourceRunId: null,
              sourceThreadId: null,
            },
          });
          await system.memoryRevision.create({
            data: {
              id: `${seeded.userId}-rev2`,
              documentId: `${seeded.userId}-mem2`,
              revision: 2,
              content: "older still",
              sourceRunId: "run",
              sourceThreadId: "thread",
            },
          });
        },
      },
    ),
    remove("index", { documentId: "__mem1__" }, { seed: library }),
    remove(
      "plaintext-document",
      { documentId: "__mem2__" },
      {
        seed: async (seeded) => {
          await library(seeded);
          await overwriteMemoryContent(`${seeded.userId}-mem2`, "legacy plaintext");
        },
      },
    ),
    remove("missing-document", { documentId: "nope" }, { seed: library }),
    remove(
      "other-space-document",
      { documentId: "__memx__" },
      {
        seed: async (seeded) => {
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-memx`,
              scope: "bot",
              path: "MEMORY.md",
              content: "elsewhere",
              space: 2,
            },
          ]);
        },
      },
    ),
    remove(
      "tampered-document",
      { documentId: "__mem2__" },
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem2`,
            tamperBody(await storedMemoryContent(`${seeded.userId}-mem2`)),
          );
        }),
      },
    ),
    remove("missing-document-id", {}, { seed: library }),
    remove("document-id-empty", { documentId: "" }, { seed: library }),
    remove("document-id-number", { documentId: 5 }, { seed: library }),
    remove("array-input", [], { seed: library }),
    remove("null-input", null, { seed: library }),
    remove("extra-keys", { documentId: "__mem2__", more: 1 }, { seed: library }),
    remove("anonymous", { documentId: "__mem2__" }, { seed: library, anonymous: true }),

    // memory.budget: what the bot's prompt would carry, and what did not fit.
    budget(
      "empty",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
        },
      },
    ),
    budget("library", { botId: "__membot__" }, { seed: library }),
    budget(
      "other-bot-ignored",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await library(seeded);
          await system.bot.create({
            data: {
              id: `${seeded.userId}-membot2`,
              spaceId: seeded.spaces[0],
              userId: seeded.userId,
              name: "Other bot",
              color: "red",
            },
          });
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mem5`,
              scope: "bot",
              path: "MEMORY.md",
              botId: `${seeded.userId}-membot2`,
              content: "another bot's",
            },
          ]);
        },
      },
    ),
    budget(
      "user-scope-ignores-bot",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await library(seeded);
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mem5`,
              scope: "user",
              path: "other-bot-shared.md",
              botId: null,
              content: "everyone reads this",
            },
          ]);
        },
      },
    ),
    budget(
      "index-usage",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mem1`,
              scope: "bot",
              path: "MEMORY.md",
              botId: `${seeded.userId}-membot`,
              content: "x".repeat(1500),
              revision: 1,
              updatedAt: memoryAt(1),
            },
          ]);
        },
      },
    ),
    // Same instant and revision: the scope and path comparison decides, as String#localeCompare does.
    budget(
      "ties-on-time-and-revision",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
          const at = memoryAt(5);
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mema`,
              scope: "bot",
              path: "a.md",
              botId: `${seeded.userId}-membot`,
              content: "a",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memb`,
              scope: "bot",
              path: "A.md",
              botId: `${seeded.userId}-membot`,
              content: "A",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memc`,
              scope: "bot",
              path: "_u.md",
              botId: `${seeded.userId}-membot`,
              content: "u",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memd`,
              scope: "bot",
              path: "-d.md",
              botId: `${seeded.userId}-membot`,
              content: "d",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-meme`,
              scope: "bot",
              path: "10.md",
              botId: `${seeded.userId}-membot`,
              content: "ten",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memf`,
              scope: "bot",
              path: "2.md",
              botId: `${seeded.userId}-membot`,
              content: "two",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memg`,
              scope: "user",
              path: "é.md",
              content: "eacute",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memh`,
              scope: "user",
              path: "e.md",
              content: "e",
              revision: 1,
              updatedAt: at,
            },
            {
              id: `${seeded.userId}-memi`,
              scope: "user",
              path: "日本.md",
              content: "jp",
              revision: 1,
              updatedAt: at,
            },
          ]);
        },
      },
    ),
    // A revision and a fresher document both win over an older one.
    budget(
      "revision-and-time",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mema`,
              scope: "bot",
              path: "old.md",
              botId: `${seeded.userId}-membot`,
              content: "old body",
              revision: 1,
              updatedAt: memoryAt(100),
            },
            {
              id: `${seeded.userId}-memb`,
              scope: "bot",
              path: "bumped.md",
              botId: `${seeded.userId}-membot`,
              content: "bumped body",
              revision: 9,
              updatedAt: memoryAt(100),
            },
            {
              id: `${seeded.userId}-memc`,
              scope: "bot",
              path: "fresh.md",
              botId: `${seeded.userId}-membot`,
              content: "fresh body",
              revision: 1,
              updatedAt: memoryAt(1),
            },
          ]);
        },
      },
    ),
    // More than a prompt carries: the tail is truncated or left out, the plan says which.
    budget(
      "overflow",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
          await seedMemoryDocuments(seeded, [
            {
              id: `${seeded.userId}-mema`,
              scope: "bot",
              path: "MEMORY.md",
              botId: `${seeded.userId}-membot`,
              content: "a".repeat(20_000),
              revision: 1,
              updatedAt: memoryAt(1),
            },
            {
              id: `${seeded.userId}-memb`,
              scope: "bot",
              path: "second.md",
              botId: `${seeded.userId}-membot`,
              content: "b".repeat(20_000),
              revision: 1,
              updatedAt: memoryAt(2),
            },
            {
              id: `${seeded.userId}-memc`,
              scope: "user",
              path: "shared.md",
              content: "😀".repeat(4000),
              revision: 1,
              updatedAt: memoryAt(3),
            },
          ]);
        },
      },
    ),
    budget(
      "bot-without-a-thread",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded, { thread: false });
        },
      },
    ),
    budget(
      "archived-bot",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded, { archived: true });
        },
      },
    ),
    budget("unknown-bot", { botId: "nope" }, { seed: library }),
    budget(
      "bot-of-another-space",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded, { space: 2 });
        },
      },
    ),
    budget("no-bot-id", {}, { seed: library }),
    budget("bot-id-empty", { botId: "" }, { seed: library }),
    budget("bot-id-number", { botId: 5 }, { seed: library }),
    budget("array-input", [], { seed: library }),
    budget("null-input", null, { seed: library }),
    budget("extra-keys", { botId: "__membot__", more: 1 }, { seed: library }),
    budget("anonymous", { botId: "__membot__" }, { seed: library, anonymous: true }),
    budget(
      "tampered",
      { botId: "__membot__" },
      {
        seed: tampered(async (seeded) => {
          await overwriteMemoryContent(
            `${seeded.userId}-mem2`,
            tamperBody(await storedMemoryContent(`${seeded.userId}-mem2`)),
          );
        }),
      },
    ),
    // repos.getBot includes the bot thread, so its sealed summary is decrypted on the way: a good
    // one is transparent, a stored value no key opens fails the request.
    budget(
      "thread-summary-sealed",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded, { summary: "a compacted conversation" });
          await seedMemoryDocuments(seeded, [
            { id: `${seeded.userId}-mem1`, scope: "bot", path: "MEMORY.md", content: "still fine" },
          ]);
        },
      },
    ),
    budget(
      "thread-summary-unreadable",
      { botId: "__membot__" },
      {
        seed: async (seeded) => {
          await seedMemoryBot(seeded);
          await system.$executeRaw`UPDATE threads SET "historyCompactionSummary" = ${"rkz1:nokey:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} WHERE id = ${`${seeded.userId}-membot-thread`}`;
        },
      },
    ),
  ];
}

async function reset(seeded: ReturnType<typeof ids>) {
  await system.artifact.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.memoryRevision.deleteMany({
    where: { document: { spaceId: { in: seeded.spaces } } },
  });
  await system.memoryDocument.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  const { userId, orgId } = seeded;
  await system.messagingOutbound.deleteMany({ where: { id: { startsWith: userId } } });
  await system.agentConnection.deleteMany({ where: { id: { startsWith: userId } } });
  // Delete the chat rows explicitly rather than relying on cascades under the runtime role.
  const own = { in: [userId, `${userId}-other`] };
  // Email names are a global registry: rows outlive their bot (botId set null), so clear every
  // name this run tag claimed before the case starts.
  await system.botEmailAddress.deleteMany({ where: { name: { startsWith: `ct${RUN_TAG}-` } } });
  await system.spaceMemoryConfig.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
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
  // usage_records is append-only for the runtime role, and each row leaves an append-only billing
  // audit row with a unique source. Both are cleared as the table owner (a superuser), triggers off.
  // Truncate, not delete: usage_records never loses a row in production, so a fresh heap is the
  // faithful state, and it is also what makes the two sides' scan order identical. A sum over
  // float8 depends on that order (see usg-summary-many-rows-order-sensitive).
  if (owner) {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query('DELETE FROM billing_audit_events WHERE "spaceId" = ANY($1)', [
      seeded.spaces,
    ]);
    await owner.query("TRUNCATE usage_records");
    await owner.query("COMMIT");
  }
  await system.run.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.task.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.taughtSkill.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.botMcpServer.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.mcpServerSpace.deleteMany({ where: { userId: own } });
  await system.computerUpdate.deleteMany({ where: { computerId: { startsWith: userId } } });
  await system.connection.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.capabilityInstallSpace.deleteMany({ where: { userId: own } });
  await system.bot.deleteMany({ where: { userId: own } });
  await system.computer.deleteMany({ where: { spaceId: { in: seeded.spaces } } });
  await system.messagingChannel.deleteMany({ where: { id: { startsWith: userId } } });
  await system.messagingLinkCode.deleteMany({
    where: { userId: { in: [userId, `${userId}-other`] } },
  });
  await system.messagingIdentity.deleteMany({
    where: { userId: { in: [userId, `${userId}-other`] } },
  });
  await system.messagingInstallation.deleteMany({ where: { userId } });
  await system.spaceMember.deleteMany({ where: { userId: own } });
  await system.securityEvent.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.auditEvent.deleteMany({
    where: { OR: [{ organizationId: orgId }, { actorId: userId }] },
  });
  await system.page.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.pluginSubmission.deleteMany({ where: { id: { startsWith: `${userId}-` } } });
  await system.chatGroup.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.trustedLinkSite.deleteMany({
    where: { userId: { in: [userId, `${userId}-other`] } },
  });
  await system.payment.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.spendingLimit.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.vaultCredential.deleteMany({ where: { userId } });
  await system.paymentWallet.deleteMany({ where: { userId } });
  await system.bot.deleteMany({ where: { userId: { in: [userId, `${userId}-other`] } } });
  await system.agentSkillSpace.deleteMany({ where: { userId: own } });
  await system.mcpServerSpace.deleteMany({ where: { userId } });
  await system.capabilityInstallSpace.deleteMany({ where: { userId } });
  await system.agentSkill.deleteMany({ where: { userId: own } });
  await system.mcpServer.deleteMany({ where: { userId } });
  await system.capabilityInstall.deleteMany({ where: { userId } });
  await system.secret.deleteMany({ where: { userId } });
  await system.session.deleteMany({ where: { userId } });
  // Identity confirmations are bound to the session id, which is the same for every case of a
  // run: a case that confirms must not leave the gate open for the next one.
  await system.verification.deleteMany({
    where: {
      identifier: {
        in: [`identity-confirmed-${userId}-session`, `oidc-reauth-${userId}-session`],
      },
    },
  });
  await system.spaceMember.deleteMany({ where: { userId } });
  await system.space.deleteMany({ where: { organizationId: { in: [orgId, `${orgId}-f`] } } });
  await system.organization.deleteMany({ where: { id: `${orgId}-f` } });
  await system.member.deleteMany({ where: { organizationId: orgId } });
  await system.organization.deleteMany({ where: { id: orgId } });
  await system.user.deleteMany({ where: { id: { in: [userId, `${userId}-other`] } } });
  // Last: the foreign organizations, Spaces, links and people the membership cases add.
  await membershipReset(system, seeded);
  // Deleting a Space shreds its content keys (the shred_space_keys trigger), and each case re-creates
  // its Spaces under the same ids. Drop this process's cached copies too, as the content-encryption
  // hook does for a delete that names one Space, or the next case would seal under a key row that no
  // longer exists.
  const ring = contentEncryptionOf(system)?.ring;
  for (const spaceId of seeded.spaces) ring?.forget(spaceId);
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
      .replaceAll("__org__", seeded.orgId)
      .replaceAll("__user__", seeded.userId)
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
      .replaceAll("__membot__", `${seeded.userId}-membot`)
      .replaceAll("__mem1__", `${seeded.userId}-mem1`)
      .replaceAll("__mem2__", `${seeded.userId}-mem2`)
      .replaceAll("__mem3__", `${seeded.userId}-mem3`)
      .replaceAll("__memx__", `${seeded.userId}-memx`)
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
      .replaceAll("__skillname__", seeded.skillName)
      .replaceAll("__skillupper__", seeded.skillName.toUpperCase())
      .replaceAll("__upper__", `${seeded.userId}-UP`.toUpperCase())
      .replaceAll("__ec1__", `${seeded.userId}-ec1`)
      .replaceAll("__ec2__", `${seeded.userId}-ec2`)
      .replaceAll("__ec3__", `${seeded.userId}-ec3`)
      .replaceAll("__s-member2__", `${seeded.userId}-member2`)
      .replace(/__s-([a-z0-9]+)__/g, (_match, name: string) => `${seeded.userId}-${name}`),
  );
}

// ---- Lane G, second batch: tickets, taught skills and organization writes ----------------------

/** Turns the board lab on for the case's own account (the deployment flag stays off). */
async function withBoardLab(seeded: Seeded) {
  await system.user.update({ where: { id: seeded.userId }, data: { labs: ["board"] } });
}

/** A Space with its board and one ticket, plus the lab on for the caller. */
function seedBoardTicket(
  options: {
    status?: string;
    priority?: string | null;
    title?: string;
    completedAt?: Date;
    number?: number;
  } = {},
) {
  return async (seeded: Seeded) => {
    await withBoardLab(seeded);
    const spaceId = seeded.spaces[0];
    await system.board.create({
      data: {
        id: `${seeded.userId}-board`,
        spaceId,
        name: "Board",
        ticketPrefix: "RAK",
        nextNumber: 4,
        createdAt: LANE_G_OLD(),
        updatedAt: LANE_G_OLD(),
      },
    });
    await system.ticket.create({
      data: {
        id: `${seeded.userId}-t1`,
        boardId: `${seeded.userId}-board`,
        spaceId,
        number: options.number ?? 3,
        title: options.title ?? "First ticket",
        description: "as filed",
        status: options.status ?? "todo",
        priority: options.priority === undefined ? "normal" : options.priority,
        createdByUserId: seeded.userId,
        createdAt: LANE_G_OLD(),
        updatedAt: LANE_G_OLD(),
        ...(options.completedAt ? { completedAt: options.completedAt } : {}),
      },
    });
  };
}

/** A taught skill (with the bot, thread and draft card it edits) in the case's first Space. */
async function seedTaughtSkill(
  seeded: Seeded,
  options: {
    status?: string;
    name?: string;
    goal?: string;
    owner?: string;
    playbook?: unknown;
    recording?: unknown;
    card?: boolean;
    cardStatus?: string;
    cardSeq?: number;
    messageCount?: number;
    noThread?: boolean;
  } = {},
) {
  const found = await seedLaneGBot(seeded, {
    bot: "sk1",
    thread: "th-sk1",
    nextMessageSeq: options.card === false ? 0 : 1,
  });
  await system.taughtSkill.create({
    data: {
      id: `${seeded.userId}-ts1`,
      spaceId: found.spaceId,
      botId: found.botId,
      userId: options.owner ?? seeded.userId,
      name: options.name ?? "Teach me",
      goal: options.goal ?? "goal",
      status: options.status ?? "draft",
      playbook: (options.playbook === undefined ? {} : options.playbook) as never,
      recording: (options.recording ?? { events: [], snapshots: [] }) as never,
      createdAt: LANE_G_OLD(),
      updatedAt: LANE_G_OLD(),
    },
  });
  if (options.card === false) return;
  const card = {
    kind: "skill_draft",
    skillId: `${seeded.userId}-ts1`,
    name: options.name ?? "Teach me",
    goal: options.goal ?? "goal",
    playbook: {
      whenToUse: "when",
      inputs: [],
      steps: ["one"],
      howToCheck: "check",
      whatToReturn: "back",
      approvalBoundaries: "none",
      failureHandling: "retry",
    },
    status: options.cardStatus ?? "draft",
  };
  const messages: SeedMessage[] = [];
  for (let index = 0; index < (options.messageCount ?? 1); index += 1) {
    messages.push({
      seq: index,
      blocks:
        index === 0
          ? [{ kind: "text", text: "before" }, card]
          : [
              {
                kind: "mcp_approval",
                name: "x",
                serverId: "srv",
                transport: "stdio",
                endpoint: null,
                needsOAuth: false,
              },
            ],
    });
  }
  await seedLaneGMessages(seeded, found.threadId, messages);
}

/** A second person in the organization, and one pending invitation they may own. */
async function seedOrganizationPeople(
  seeded: Seeded,
  options: { role?: string; invitationStatus?: string; inviterIsOther?: boolean } = {},
) {
  const other = `${seeded.userId}-member2`;
  await system.user.create({
    data: { id: other, name: "Second Person", email: `${other}@example.test`, emailVerified: true },
  });
  await system.member.create({
    data: {
      id: `${seeded.userId}-mem2`,
      organizationId: seeded.orgId,
      userId: other,
      role: options.role ?? "member",
      createdAt: LANE_G_OLD(),
    },
  });
  await system.invitation.create({
    data: {
      id: `${seeded.userId}-inv1`,
      organizationId: seeded.orgId,
      email: `${seeded.userId}-invitee@example.test`,
      role: "member",
      status: options.invitationStatus ?? "pending",
      expiresAt: new Date(Date.UTC(2030, 0, 2)),
      createdAt: LANE_G_OLD(),
      inviterId: options.inviterIsOther ? other : seeded.userId,
    },
  });
}

function laneGCases2(): Case[] {
  const move = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `tk-move-${name}`,
    procedure: "tickets.move",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const comment = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `tk-comment-${name}`,
    procedure: "tickets.comment",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const draft = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `sk-draft-${name}`,
    procedure: "skills.updateDraft",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const save = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `sk-save-${name}`,
    procedure: "skills.save",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const role = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `org-role-${name}`,
    procedure: "organizations.members.setRole",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const cancel = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `org-cancel-${name}`,
    procedure: "organizations.invitations.cancel",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const playbook = {
    whenToUse: "when the user asks",
    inputs: ["a", "b"],
    steps: ["one", "two"],
    howToCheck: "read the page",
    whatToReturn: "the total",
    approvalBoundaries: "ask before paying",
    failureHandling: "stop and report",
  };
  const skill = { skillId: "__s-ts1__" };
  const ticket = { id: "__s-t1__" };
  const member = { organizationId: "__org__", userId: "__s-member2__" };

  return [
    // tickets.move -----------------------------------------------------------------------------
    move("to-doing", { ...ticket, status: "doing" }, seedBoardTicket()),
    move("to-done-stamps-completion", { ...ticket, status: "done" }, seedBoardTicket()),
    move(
      "keeps-first-completion",
      { ...ticket, status: "closed" },
      seedBoardTicket({ status: "done", completedAt: LANE_G_OLD() }),
    ),
    move(
      "reopens-clears-completion",
      { ...ticket, status: "todo" },
      seedBoardTicket({ status: "done", completedAt: LANE_G_OLD() }),
    ),
    move(
      "coerces-legacy-status",
      { ...ticket, status: "doing" },
      seedBoardTicket({ status: "weird" }),
    ),
    move(
      "coerces-null-priority",
      { ...ticket, status: "review" },
      seedBoardTicket({ priority: null }),
    ),
    move("missing-ticket", { id: "nope", status: "doing" }, seedBoardTicket()),
    move("other-board-ticket", { id: "__s-t1__", status: "doing" }, async (seeded) => {
      await withBoardLab(seeded);
      await system.board.create({
        data: {
          id: `${seeded.userId}-board2`,
          spaceId: seeded.spaces[1],
          name: "Other",
          ticketPrefix: "OTH",
          createdAt: LANE_G_OLD(),
          updatedAt: LANE_G_OLD(),
        },
      });
      await system.ticket.create({
        data: {
          id: `${seeded.userId}-t1`,
          boardId: `${seeded.userId}-board2`,
          spaceId: seeded.spaces[1],
          number: 1,
          title: "Elsewhere",
          status: "todo",
          createdAt: LANE_G_OLD(),
          updatedAt: LANE_G_OLD(),
        },
      });
    }),
    move("lab-off", { ...ticket, status: "doing" }, async (seeded) => {
      await seedBoardTicket()(seeded);
      await system.user.update({ where: { id: seeded.userId }, data: { labs: [] } });
    }),
    move("lab-on-by-deployment", { ...ticket, status: "doing" }, seedBoardTicket()),
    move("anonymous", { ...ticket, status: "doing" }, seedBoardTicket(), { anonymous: true }),
    move("bad-status", { ...ticket, status: "archived" }, seedBoardTicket()),
    move("missing-status", { id: "__s-t1__" }, seedBoardTicket()),
    move("missing-id", { status: "doing" }, seedBoardTicket()),
    move("empty-id", { id: "", status: "doing" }, seedBoardTicket()),
    move("null-input", null, seedBoardTicket()),
    move("ticket-in-another-space", { id: "__s-t1__", status: "doing" }, seedBoardTicket(), {
      space: 1,
    }),

    // tickets.comment --------------------------------------------------------------------------
    comment("basic", { ticketId: "__s-t1__", body: "  a note  " }, seedBoardTicket()),
    comment("keeps-unicode", { ticketId: "__s-t1__", body: "héllo 😀" }, seedBoardTicket()),
    comment("nul-in-body", { ticketId: "__s-t1__", body: "a\u0000b" }, seedBoardTicket()),
    comment("missing-ticket", { ticketId: "nope", body: "note" }, seedBoardTicket()),
    comment("empty-body", { ticketId: "__s-t1__", body: "   " }, seedBoardTicket()),
    comment("long-body", { ticketId: "__s-t1__", body: "x".repeat(10_001) }, seedBoardTicket()),
    comment("lab-off", { ticketId: "__s-t1__", body: "note" }, async (seeded) => {
      await seedBoardTicket()(seeded);
      await system.user.update({ where: { id: seeded.userId }, data: { labs: [] } });
    }),
    comment("anonymous", { ticketId: "__s-t1__", body: "note" }, seedBoardTicket(), {
      anonymous: true,
    }),
    comment("bad-input-array", [], seedBoardTicket()),
    comment("ticket-in-another-space", { ticketId: "__s-t1__", body: "note" }, seedBoardTicket(), {
      space: 1,
    }),

    // skills.updateDraft -----------------------------------------------------------------------
    draft(
      "updates-card",
      { ...skill, name: "Renamed", playbook },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    draft(
      "keeps-name",
      { ...skill, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded, { name: "Kept" })),
    ),
    draft(
      "saved-stays-saved",
      { ...skill, playbook },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, { status: "saved", cardStatus: "saved" })),
    ),
    draft("hands-over-recording", { ...skill, playbook }, async (seeded) => {
      await seedTaughtSkill(seeded, {
        owner: `${seeded.userId}-other`,
        recording: { events: [{ at: "2021-01-01T00:00:00.000Z", kind: "key" }], snapshots: [] },
      });
    }),
    draft("skips-other-skills-card", { ...skill, playbook }, async (seeded) => {
      const found = await seedLaneGBot(seeded, { bot: "sk1", thread: "th-sk1", nextMessageSeq: 2 });
      await system.taughtSkill.create({
        data: {
          id: `${seeded.userId}-ts1`,
          spaceId: found.spaceId,
          botId: found.botId,
          userId: seeded.userId,
          name: "Mine",
          goal: "g",
          status: "draft",
          playbook: {} as never,
          recording: { events: [], snapshots: [] } as never,
          createdAt: LANE_G_OLD(),
          updatedAt: LANE_G_OLD(),
        },
      });
      // The newest message carries another skill's card; the next one carries ours.
      await seedLaneGMessages(seeded, found.threadId, [
        {
          seq: 0,
          blocks: [
            {
              kind: "skill_draft",
              skillId: `${seeded.userId}-ts1`,
              name: "Mine",
              goal: "g",
              playbook,
              status: "draft",
            },
          ],
        },
        {
          seq: 1,
          blocks: [
            {
              kind: "skill_draft",
              skillId: `${seeded.userId}-ts9`,
              name: "Theirs",
              goal: "g",
              playbook,
              status: "draft",
            },
          ],
        },
      ]);
    }),
    draft("bot-without-thread", { ...skill, playbook }, async (seeded) => {
      await seedTaughtSkill(seeded);
      await system.thread.deleteMany({ where: { botId: `${seeded.userId}-sk1` } });
    }),
    draft(
      "recording-status-refused",
      { ...skill, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded, { status: "recording" })),
    ),
    draft(
      "drafting-status-refused",
      { ...skill, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded, { status: "drafting" })),
    ),
    draft(
      "missing-skill",
      { skillId: "nope", playbook },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    draft("other-space-skill", { ...skill, playbook }, async (seeded) => {
      await seedTaughtSkill(seeded);
      await system.taughtSkill.update({
        where: { id: `${seeded.userId}-ts1` },
        data: { spaceId: seeded.spaces[1] },
      });
    }),
    draft(
      "anonymous",
      { ...skill, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded)),
      { anonymous: true },
    ),
    draft(
      "bad-playbook-missing-field",
      { ...skill, playbook: { ...playbook, steps: undefined } },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    draft(
      "bad-playbook-number-step",
      { ...skill, playbook: { ...playbook, steps: [1] } },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    draft(
      "bad-name-number",
      { ...skill, name: 7, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    draft(
      "stored-status-outside-enum",
      { ...skill, playbook },
      async (seeded) => void (await seedTaughtSkill(seeded, { status: "weird" })),
    ),
    draft(
      "stored-recording-outside-schema",
      { ...skill, playbook },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, {
          recording: { events: [{ at: "x", kind: "weird" }], snapshots: [] },
        })),
    ),
    draft("unreadable-card-blocks", { ...skill, playbook }, async (seeded) => {
      await seedTaughtSkill(seeded);
      await owner!.query(
        `UPDATE messages SET blocks = jsonb_set(blocks, '{1,$sealed}', to_jsonb((blocks->1->>'$sealed') || 'AAAA')) WHERE "threadId" = $1`,
        [`${seeded.userId}-th-sk1`],
      );
    }),

    // skills.save ------------------------------------------------------------------------------
    save(
      "saves",
      { ...skill },
      async (seeded) => void (await seedTaughtSkill(seeded, { name: "Named" })),
    ),
    save(
      "names-from-goal",
      { ...skill },
      async (seeded) => void (await seedTaughtSkill(seeded, { name: "", goal: "Do the thing" })),
    ),
    save(
      "keeps-given-name",
      { ...skill, name: "Given" },
      async (seeded) => void (await seedTaughtSkill(seeded, { name: "Old" })),
    ),
    save("hands-over-recording", { ...skill }, async (seeded) => {
      await seedTaughtSkill(seeded, {
        owner: `${seeded.userId}-other`,
        recording: {
          events: [{ at: "2021-01-01T00:00:00.000Z", kind: "scroll", y: 2 }],
          snapshots: [],
        },
      });
    }),
    save(
      "no-card-still-appends",
      { ...skill },
      async (seeded) => void (await seedTaughtSkill(seeded, { card: false })),
    ),
    save(
      "recording-status-refused",
      { ...skill },
      async (seeded) => void (await seedTaughtSkill(seeded, { status: "recording" })),
    ),
    save(
      "missing-skill",
      { skillId: "nope" },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    save("anonymous", { ...skill }, async (seeded) => void (await seedTaughtSkill(seeded)), {
      anonymous: true,
    }),
    save(
      "bad-name-null",
      { ...skill, name: null },
      async (seeded) => void (await seedTaughtSkill(seeded)),
    ),
    save("bot-without-thread", { ...skill }, async (seeded) => {
      await seedTaughtSkill(seeded, { card: false });
      await system.thread.deleteMany({ where: { botId: `${seeded.userId}-sk1` } });
    }),

    // organizations.members.setRole ------------------------------------------------------------
    role(
      "promote",
      { ...member, role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    role(
      "demote-withdraws-invitations",
      { ...member, role: "member" },
      async (seeded) => void (await seedOrganizationPeople(seeded, { role: "admin" })),
    ),
    role(
      "demote-member-keeps-own-invitation",
      { ...member, role: "member" },
      async (seeded) =>
        void (await seedOrganizationPeople(seeded, { role: "admin", inviterIsOther: true })),
    ),
    role(
      "owner-refused",
      { organizationId: "__org__", userId: "__user__", role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    role(
      "target-unknown",
      { organizationId: "__org__", userId: "nope", role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    role("not-a-manager", { ...member, role: "admin" }, async (seeded) => {
      await seedOrganizationPeople(seeded);
      // The caller is only a member of the organization.
      await system.member.updateMany({
        where: { organizationId: seeded.orgId, userId: seeded.userId },
        data: { role: "member" },
      });
    }),
    role(
      "stranger",
      { ...member, role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
      { space: 1 },
    ),
    role(
      "bad-role",
      { ...member, role: "owner" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    role(
      "anonymous",
      { ...member, role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
      { anonymous: true },
    ),
    role(
      "bad-input-missing-user",
      { organizationId: "__org__", role: "admin" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),

    // organizations.invitations.cancel ---------------------------------------------------------
    cancel(
      "cancels",
      { organizationId: "__org__", invitationId: "__s-inv1__" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    cancel(
      "already-cancelled",
      { organizationId: "__org__", invitationId: "__s-inv1__" },
      async (seeded) =>
        void (await seedOrganizationPeople(seeded, { invitationStatus: "canceled" })),
    ),
    cancel(
      "unknown-invitation",
      { organizationId: "__org__", invitationId: "nope" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
    ),
    cancel(
      "other-organization",
      { organizationId: "__org__", invitationId: "__s-inv1__" },
      async (seeded) => {
        await seedOrganizationPeople(seeded);
        // The invitation belongs to another organization, which has to exist for the foreign key.
        await system.organization.create({
          data: {
            id: `${seeded.orgId}-f`,
            name: "Far Org",
            slug: `far-${seeded.userId}`,
            createdAt: LANE_G_OLD(),
          },
        });
        await system.invitation.updateMany({
          where: { id: `${seeded.userId}-inv1` },
          data: { organizationId: `${seeded.orgId}-f` },
        });
      },
    ),
    cancel(
      "not-a-manager",
      { organizationId: "__org__", invitationId: "__s-inv1__" },
      async (seeded) => {
        await seedOrganizationPeople(seeded);
        await system.member.updateMany({
          where: { organizationId: seeded.orgId, userId: seeded.userId },
          data: { role: "member" },
        });
      },
    ),
    cancel(
      "anonymous",
      { organizationId: "__org__", invitationId: "__s-inv1__" },
      async (seeded) => void (await seedOrganizationPeople(seeded)),
      { anonymous: true },
    ),
    cancel("bad-input-missing", {}, async (seeded) => void (await seedOrganizationPeople(seeded))),

    // The independent reviewer's repros: each one is a divergence it found between this port and
    // TypeScript, kept as a contract case.
    save(
      "gr-goal-splits-emoji",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, { name: "", goal: `${"a".repeat(79)}😀` })),
    ),
    save("gr-stored-null-playbook", { ...skill }, async (seeded) => {
      await seedTaughtSkill(seeded, { name: "Named" });
      await owner!.query(`UPDATE taught_skills SET playbook = 'null'::jsonb WHERE id = $1`, [
        `${seeded.userId}-ts1`,
      ]);
    }),
    save(
      "gr-stored-playbook-is-a-string",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, { name: "Named", playbook: "not an object" })),
    ),
    save(
      "gr-stored-playbook-is-a-list",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, { name: "Named", playbook: ["a", "b"] })),
    ),
    // G7: Array#join renders a null element as an empty field, not "null" (out-of-schema playbook).
    save(
      "grx3-playbook-array-with-null",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, {
          name: "Named",
          playbook: { whenToUse: ["a", null], inputs: [[null], 2] },
        })),
    ),
    // zod's .optional() admits a value or an absent key, never null: the output parse fails.
    save(
      "gr-recording-null-optional-key",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, {
          name: "Named",
          recording: {
            events: [{ at: "2021-01-01T00:00:00.000Z", kind: "scroll", y: null }],
            snapshots: [],
          },
        })),
    ),
    // A key the schemas do not name is stripped from the answer, here and in the nested entries.
    save(
      "gr-recording-unknown-key",
      { ...skill },
      async (seeded) =>
        void (await seedTaughtSkill(seeded, {
          name: "Named",
          recording: {
            events: [{ at: "2021-01-01T00:00:00.000Z", kind: "key", key: "a", extra: 1 }],
            snapshots: [{ at: "2021-01-01T00:00:00.000Z", summary: "s", extra: true }],
            extra: 1,
          },
        })),
    ),
    // boardEnabled is a middleware: with the lab off it answers 404 before the input is parsed.
    move("gr-lab-off-bad-input", { id: "__s-t1__" }, async (seeded) => {
      await seedBoardTicket()(seeded);
      await system.user.update({ where: { id: seeded.userId }, data: { labs: [] } });
    }),
    comment("gr-lab-off-bad-body", { ticketId: "__s-t1__", body: "   " }, async (seeded) => {
      await seedBoardTicket()(seeded);
      await system.user.update({ where: { id: seeded.userId }, data: { labs: [] } });
    }),
  ];
}

// ---- Lane G: thread-writing procedures over rkz1 content and computer.commands ----------------

/** The fixed timestamp the lane's seeds carry (a function: the case list builds before consts). */
function LANE_G_OLD() {
  return new Date(Date.UTC(2020, 0, 1));
}

/** A bot and (unless `thread: false`) its thread, in one of the case's Spaces. */
async function seedLaneGBot(
  seeded: Seeded,
  options: {
    bot?: string;
    space?: string;
    archived?: boolean;
    thread?: boolean | string;
    nextMessageSeq?: number;
    nextEventSeq?: number;
    summary?: string;
  } = {},
) {
  const botId = `${seeded.userId}-${options.bot ?? "ob1"}`;
  const spaceId = options.space ?? seeded.spaces[0];
  await system.bot.create({
    data: {
      id: botId,
      spaceId,
      userId: seeded.userId,
      name: "Onboarding bot",
      color: "blue",
      updatedAt: LANE_G_OLD(),
      ...(options.archived ? { archivedAt: LANE_G_OLD() } : {}),
    },
  });
  const threadId = `${seeded.userId}-${typeof options.thread === "string" ? options.thread : "th-ob1"}`;
  if (options.thread !== false) {
    await system.thread.create({
      data: {
        id: threadId,
        spaceId,
        userId: seeded.userId,
        botId,
        nextMessageSeq: options.nextMessageSeq ?? 0,
        nextEventSeq: options.nextEventSeq ?? 0,
        ...(options.summary ? { historyCompactionSummary: options.summary } : {}),
      },
    });
  }
  return { botId, threadId, spaceId };
}

type SeedMessage = {
  seq: number;
  role?: string;
  blocks: unknown;
  botId?: string | null;
  authorUserId?: string | null;
  createdAt?: Date;
};

/** Messages written through the API's client, so their blocks are sealed as production stores them. */
async function seedLaneGMessages(seeded: Seeded, threadId: string, messages: SeedMessage[]) {
  for (const message of messages) {
    await system.message.create({
      data: {
        id: `${threadId}-m${message.seq}`,
        threadId,
        seq: message.seq,
        role: message.role ?? "bot",
        blocks: message.blocks as never,
        botId: message.botId ?? null,
        authorUserId: message.authorUserId ?? null,
        createdAt: message.createdAt ?? new Date(Date.UTC(2021, 0, 1) + message.seq * 1000),
      },
    });
  }
}

async function seedLaneGEvent(
  seeded: Seeded,
  spaceId: string,
  threadId: string,
  botId: string,
  seq: number,
  type: string,
  payload: unknown,
) {
  await system.event.create({
    data: {
      id: `${threadId}-e${seq}`,
      spaceId,
      threadId,
      botId,
      seq,
      type,
      payload: payload as never,
      createdAt: new Date(Date.UTC(2021, 1, 1) + seq * 1000),
    },
  });
}

/** Declared as a function so the case list, built at module load, can reach it (hoisting). */
function CHOICE_CARD() {
  return {
    kind: "choice",
    question: "What do you want me on first?",
    options: [{ id: "day", letter: "A", label: "Day-to-day work" }],
  };
}

/** Replaces a thread's sealed compaction summary with a value that cannot be opened. */
async function breakThreadSummary(threadId: string) {
  const [row] =
    (await system.$queryRaw`SELECT "historyCompactionSummary" AS summary FROM threads WHERE id = ${threadId}`) as any[];
  const value = row.summary as string;
  const broken = `${value.slice(0, -3)}${value.slice(-3) === "AAA" ? "BBB" : "AAA"}`;
  await owner!.query('UPDATE threads SET "historyCompactionSummary" = $1 WHERE id = $2', [
    broken,
    threadId,
  ]);
}

/** Copies another thread's sealed summary onto `threadId`, so it names a key of another Space. */
async function moveSummary(threadId: string, fromThreadId: string) {
  await owner!.query(
    'UPDATE threads SET "historyCompactionSummary" = (SELECT "historyCompactionSummary" FROM threads WHERE id = $2) WHERE id = $1',
    [threadId, fromThreadId],
  );
}

/** Copies another message's sealed blocks onto `toMessageId`. */
async function moveMessageBlocks(toMessageId: string, fromMessageId: string) {
  await owner!.query(
    "UPDATE messages SET blocks = (SELECT blocks FROM messages WHERE id = $2) WHERE id = $1",
    [toMessageId, fromMessageId],
  );
}

/** Copies another event's sealed payload onto `toEventId`. */
async function moveEventPayload(toEventId: string, fromEventId: string) {
  await owner!.query(
    "UPDATE events SET payload = (SELECT payload FROM events WHERE id = $2) WHERE id = $1",
    [toEventId, fromEventId],
  );
}

function laneGCases(): Case[] {
  const focus = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `focus-${name}`,
    procedure: "onboarding.promptFocus",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const dismiss = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `fdismiss-${name}`,
    procedure: "onboarding.dismissFocus",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const commands = (
    name: string,
    input: unknown,
    seed?: Case["seed"],
    extra: Partial<Case> = {},
  ): Case => ({
    name: `cmd-${name}`,
    procedure: "computer.commands",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  const bot = { botId: "__s-ob1__" };
  /** A bot whose thread already holds `messages`, with the sequence counters they imply. */
  const withMessages = (
    messages: SeedMessage[],
    options: {
      nextMessageSeq?: number;
      nextEventSeq?: number;
      bot?: string;
      thread?: boolean | string;
    } = {},
  ) => {
    return async (seeded: Seeded) => {
      const found = await seedLaneGBot(seeded, {
        ...options,
        nextMessageSeq: options.nextMessageSeq ?? messages.length,
      });
      if (options.thread !== false) await seedLaneGMessages(seeded, found.threadId, messages);
    };
  };
  const command = (overrides: Record<string, unknown> = {}) => ({
    executionId: "exec-1",
    kind: "shell",
    command: "ls -la",
    cwd: "/work",
    status: "done",
    exitCode: 0,
    output: "total 0",
    ...overrides,
  });
  /** A bot with a thread and these command events, oldest first. */
  const withCommands = (
    payloads: Array<{ type?: string; payload: unknown; botId?: string }>,
    options: { bot?: string; archived?: boolean; thread?: boolean } = {},
  ) => {
    return async (seeded: Seeded) => {
      const found = await seedLaneGBot(seeded, { ...options, nextEventSeq: payloads.length });
      // An event names its thread (FK), so a bot without one has no history to seed.
      if (options.thread === false) return;
      for (const [index, entry] of payloads.entries()) {
        await seedLaneGEvent(
          seeded,
          found.spaceId,
          found.threadId,
          entry.botId ?? found.botId,
          index,
          entry.type ?? "computer.command",
          entry.payload,
        );
      }
    };
  };

  return [
    // onboarding.promptFocus -------------------------------------------------------------------
    focus("prompt-posts", bot, async (seeded) => void (await seedLaneGBot(seeded))),
    focus(
      "prompt-posts-after-messages",
      bot,
      withMessages(
        [
          { seq: 0, blocks: [{ kind: "text", text: "hello" }] },
          { seq: 1, blocks: [{ kind: "meta", text: "note" }] },
        ],
        { nextEventSeq: 1 },
      ),
    ),
    focus(
      "prompt-skips-user-message",
      bot,
      withMessages([{ seq: 0, role: "user", blocks: [{ kind: "text", text: "hi" }] }]),
    ),
    focus("prompt-skips-choice", bot, withMessages([{ seq: 0, blocks: [CHOICE_CARD()] }])),
    focus(
      "prompt-skips-ask",
      bot,
      withMessages([{ seq: 0, blocks: [{ kind: "ask", text: "which?" }] }]),
    ),
    focus(
      "prompt-skips-answered-choice",
      bot,
      withMessages([{ seq: 0, blocks: [{ ...CHOICE_CARD(), answerId: "day" }] }]),
    ),
    focus("prompt-skips-intro-run", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded);
      await system.task.create({
        data: {
          id: `${seeded.userId}-task1`,
          spaceId: found.spaceId,
          botId: found.botId,
          threadId: found.threadId,
          userId: seeded.userId,
          prompt: "intro",
          status: "running",
        } as never,
      });
      await system.run.create({
        data: {
          id: `${seeded.userId}-run1`,
          spaceId: found.spaceId,
          botId: found.botId,
          threadId: found.threadId,
          taskId: `${seeded.userId}-task1`,
          userId: seeded.userId,
          status: "running",
          trigger: "created",
        } as never,
      });
    }),
    focus("prompt-posts-after-failed-intro", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded);
      await system.task.create({
        data: {
          id: `${seeded.userId}-task1`,
          spaceId: found.spaceId,
          botId: found.botId,
          threadId: found.threadId,
          userId: seeded.userId,
          prompt: "intro",
          status: "running",
        } as never,
      });
      await system.run.create({
        data: {
          id: `${seeded.userId}-run1`,
          spaceId: found.spaceId,
          botId: found.botId,
          threadId: found.threadId,
          taskId: `${seeded.userId}-task1`,
          userId: seeded.userId,
          status: "failed",
          trigger: "created",
        } as never,
      });
    }),
    focus(
      "prompt-archived-bot-posts",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { archived: true })),
    ),
    focus(
      "prompt-bot-without-thread",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { thread: false })),
    ),
    focus(
      "prompt-other-space-bot",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { space: seeded.spaces[1] })),
    ),
    focus(
      "prompt-unknown-bot",
      { botId: "missing" },
      async (seeded) => void (await seedLaneGBot(seeded)),
    ),
    focus("prompt-anonymous", bot, async (seeded) => void (await seedLaneGBot(seeded)), {
      anonymous: true,
    }),
    focus("prompt-bad-input-missing", {}, async (seeded) => void (await seedLaneGBot(seeded))),
    focus(
      "prompt-bad-input-empty",
      { botId: "" },
      async (seeded) => void (await seedLaneGBot(seeded)),
    ),
    focus(
      "prompt-bad-input-number",
      { botId: 7 },
      async (seeded) => void (await seedLaneGBot(seeded)),
    ),
    focus("prompt-bad-input-null", null, async (seeded) => void (await seedLaneGBot(seeded))),
    focus("prompt-bad-input-array", [], async (seeded) => void (await seedLaneGBot(seeded))),
    focus(
      "prompt-bad-input-extra",
      { botId: "__s-ob1__", more: true },
      async (seeded) => void (await seedLaneGBot(seeded)),
    ),
    focus("prompt-tampered-summary", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { summary: "a summary" });
      await breakThreadSummary(found.threadId);
    }),
    focus("prompt-other-space-summary", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded);
      const elsewhere = await seedLaneGBot(seeded, {
        bot: "obx",
        thread: "th-obx",
        space: seeded.spaces[1],
        summary: "another space",
      });
      await moveSummary(found.threadId, elsewhere.threadId);
    }),
    focus(
      "prompt-plaintext-blocks",
      bot,
      withMessages([{ seq: 0, blocks: [{ kind: "text", text: "legacy" }] }]),
    ),

    // onboarding.dismissFocus ------------------------------------------------------------------
    dismiss("answers", bot, withMessages([{ seq: 0, blocks: [CHOICE_CARD()] }])),
    dismiss(
      "answers-second-message",
      bot,
      withMessages([
        { seq: 0, blocks: [{ kind: "text", text: "hello" }] },
        { seq: 1, blocks: [CHOICE_CARD()] },
      ]),
    ),
    dismiss(
      "no-choice",
      bot,
      withMessages([{ seq: 0, blocks: [{ kind: "text", text: "hello" }] }]),
    ),
    dismiss(
      "already-answered",
      bot,
      withMessages([{ seq: 0, blocks: [{ ...CHOICE_CARD(), answerId: "day" }] }]),
    ),
    dismiss(
      "empty-answer-is-pending",
      bot,
      withMessages([{ seq: 0, blocks: [{ ...CHOICE_CARD(), answerId: "" }] }]),
    ),
    dismiss(
      "answers-first-of-two-cards",
      bot,
      withMessages([
        { seq: 0, blocks: [CHOICE_CARD()] },
        { seq: 1, blocks: [{ ...CHOICE_CARD(), question: "Second?" }] },
      ]),
    ),
    dismiss(
      "text-before-choice",
      bot,
      withMessages([{ seq: 0, blocks: [{ kind: "text", text: "before" }, CHOICE_CARD()] }]),
    ),
    dismiss(
      "keeps-stray-entries",
      bot,
      withMessages([{ seq: 0, blocks: [CHOICE_CARD(), "stray", { no: "kind" }, { kind: 7 }] }]),
    ),
    dismiss(
      "bot-without-thread",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { thread: false })),
    ),
    dismiss(
      "other-space-bot",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { space: seeded.spaces[1] })),
    ),
    dismiss(
      "unknown-bot",
      { botId: "missing" },
      async (seeded) => void (await seedLaneGBot(seeded)),
    ),
    dismiss("anonymous", bot, withMessages([{ seq: 0, blocks: [CHOICE_CARD()] }]), {
      anonymous: true,
    }),
    dismiss("bad-input-missing", {}, withMessages([{ seq: 0, blocks: [CHOICE_CARD()] }])),
    dismiss("bad-input-null", null, withMessages([{ seq: 0, blocks: [CHOICE_CARD()] }])),
    dismiss("tampered-blocks", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextMessageSeq: 1 });
      await seedLaneGMessages(seeded, found.threadId, [{ seq: 0, blocks: [CHOICE_CARD()] }]);
      await owner!.query(
        `UPDATE messages SET blocks = jsonb_set(blocks, '{0,$sealed}', to_jsonb((blocks->0->>'$sealed') || 'AAAA')) WHERE "threadId" = $1`,
        [found.threadId],
      );
    }),
    dismiss("other-space-blocks", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextMessageSeq: 1 });
      await seedLaneGMessages(seeded, found.threadId, [{ seq: 0, blocks: [CHOICE_CARD()] }]);
      const elsewhere = await seedLaneGBot(seeded, {
        bot: "obx",
        thread: "th-obx",
        space: seeded.spaces[1],
        nextMessageSeq: 1,
      });
      await seedLaneGMessages(seeded, elsewhere.threadId, [{ seq: 0, blocks: [CHOICE_CARD()] }]);
      await moveMessageBlocks(`${found.threadId}-m0`, `${elsewhere.threadId}-m0`);
    }),

    // computer.commands ------------------------------------------------------------------------
    commands("empty", bot, withCommands([])),
    commands("one", bot, withCommands([{ payload: command() }])),
    commands(
      "folds-running-then-done",
      bot,
      withCommands([
        { payload: command({ status: "running", exitCode: null, output: "" }) },
        { payload: command() },
      ]),
    ),
    commands(
      "keeps-done-before-running",
      bot,
      withCommands([
        { payload: command() },
        { payload: command({ status: "running", exitCode: null }) },
      ]),
    ),
    commands(
      "orders-by-execution",
      bot,
      withCommands([
        { payload: command({ executionId: "b", command: "two" }) },
        { payload: command({ executionId: "a", command: "one" }) },
        { payload: command({ executionId: "b", command: "two again" }) },
      ]),
    ),
    commands(
      "drops-bad-payloads",
      bot,
      withCommands([
        { payload: command({ executionId: "good" }) },
        { payload: { ...command(), exitCode: undefined } },
        { payload: command({ kind: "rm" }) },
        { payload: command({ bytes: -1 }) },
        { payload: command({ bytes: null }) },
        { payload: command({ status: "queued" }) },
        { payload: { executionId: "no-fields" } },
        { payload: "not an object" },
        { payload: null },
      ]),
    ),
    commands(
      "keeps-optional-bytes",
      bot,
      withCommands([{ payload: command({ kind: "write_file", bytes: 42, exitCode: null }) }]),
    ),
    commands("ignores-other-events-and-bots", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextEventSeq: 3 });
      // A second bot of the same Space, whose commands are not this bot's history.
      await seedLaneGBot(seeded, { bot: "ob2", thread: "th-ob2" });
      await seedLaneGEvent(
        seeded,
        found.spaceId,
        found.threadId,
        found.botId,
        0,
        "thread.message.created",
        command({ executionId: "other-type" }),
      );
      await seedLaneGEvent(
        seeded,
        found.spaceId,
        found.threadId,
        `${seeded.userId}-ob2`,
        1,
        "computer.command",
        command({ executionId: "other-bot" }),
      );
      await seedLaneGEvent(
        seeded,
        found.spaceId,
        found.threadId,
        found.botId,
        2,
        "computer.command",
        command({ executionId: "mine" }),
      );
    }),
    commands("bot-without-thread", bot, withCommands([{ payload: command() }], { thread: false })),
    commands("archived-bot", bot, withCommands([{ payload: command() }], { archived: true })),
    commands(
      "other-space-bot",
      bot,
      async (seeded) => void (await seedLaneGBot(seeded, { space: seeded.spaces[1] })),
    ),
    commands("unknown-bot", { botId: "missing" }, withCommands([])),
    commands("anonymous", bot, withCommands([{ payload: command() }]), { anonymous: true }),
    commands("bad-input-missing", {}, withCommands([])),
    commands("bad-input-empty", { botId: "" }, withCommands([])),
    commands("bad-input-number", { botId: 3 }, withCommands([])),
    commands("plaintext-payload", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextEventSeq: 1 });
      await owner!.query(
        `INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "createdAt")
           VALUES ($1, $2, $3, $4, 0, 'computer.command', $5::jsonb, now())`,
        [
          `${found.threadId}-legacy`,
          found.spaceId,
          found.threadId,
          found.botId,
          JSON.stringify(command({ executionId: "legacy" })),
        ],
      );
    }),
    commands("tampered-payload", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextEventSeq: 1 });
      await seedLaneGEvent(
        seeded,
        found.spaceId,
        found.threadId,
        found.botId,
        0,
        "computer.command",
        command(),
      );
      await owner!.query(
        `UPDATE events SET payload = jsonb_set(payload, '{$sealed}', to_jsonb((payload->>'$sealed') || 'AAAA')) WHERE id = $1`,
        [`${found.threadId}-e0`],
      );
    }),
    commands("other-space-payload", bot, async (seeded) => {
      const found = await seedLaneGBot(seeded, { nextEventSeq: 1 });
      await seedLaneGEvent(
        seeded,
        found.spaceId,
        found.threadId,
        found.botId,
        0,
        "computer.command",
        command(),
      );
      const elsewhere = await seedLaneGBot(seeded, {
        bot: "obx",
        thread: "th-obx",
        space: seeded.spaces[1],
        nextEventSeq: 1,
      });
      await seedLaneGEvent(
        seeded,
        elsewhere.spaceId,
        elsewhere.threadId,
        elsewhere.botId,
        0,
        "computer.command",
        command(),
      );
      await moveEventPayload(`${found.threadId}-e0`, `${elsewhere.threadId}-e0`);
    }),
  ];
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
  return gatewayCall(GO_URL, procedure, input, seeded);
}

/** Fault-injection path: one request through the all-proxy gateway. */
async function proxyCall(procedure: string, input: unknown, seeded: Seeded) {
  return gatewayCall(PROXY_URL, procedure, input, seeded);
}

async function gatewayCall(
  base: string,
  procedure: string,
  input: unknown,
  seeded: Seeded,
) {
  const response = await fetch(`${base}/rpc/${procedure.replaceAll(".", "/")}`, {
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
  "routines.testRun",
  "skills.testRun",
  "mcp.assignments.approve",
  "spendingLimit.set",
  "botSections.create",
  "botSections.update",
  "botSections.remove",
  "availability.set",
  "availability.chooseForSpace",
  "spaces.rename",
  "spaces.members.add",
  "spaces.invites.accept",
  "spaces.invites.cancel",
  "organizations.rename",
  "trustedLinkSites.remove",
  "pages.rename",
  "pages.pin",
  "models.rename",
  "models.setRole",
  "bots.reorder",
  "bots.restore",
  "bots.claimEmailAddress",
  "memory.setDefaultScope",
  "groups.restore",
  "agentSkills.remove",
  "memory.update",
  "memory.remove",
  "onboarding.promptFocus",
  "onboarding.dismissFocus",
  "tickets.move",
  "tickets.comment",
  "tickets.create",
  "tickets.update",
  "tickets.decide",
  "skills.updateDraft",
  "skills.save",
  "organizations.members.setRole",
  "organizations.invitations.cancel",
  "computer.dismissUpdate",
  "computer.dismissDiskWarning",
  "boards.list",
  "boards.get",
  "boards.rename",
  "bots.rotateWebhookSecret",
  "pages.remove",
  "pages.setVisibility",
]);

const CUID = /^c[0-9a-z]{24}$/;
// The credential store's record ids are 12 random bytes as hex; a webhook secret is 32 random
// bytes as unpadded base64url. Both sides generate their own, so only the shape is compared.
const SECRET_ID = /^[0-9a-f]{24}$/;
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{43}$/;
const PAGE_SHARE_HASH = /^[0-9a-f]{64}$/;
const PAGE_SHARE_URL = /^(.*\/p\/[^/?#]*?)([A-Za-z0-9_-]{43})$/;
const LINK_CODE = /^(?:[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}|[A-HJKMNP-TV-Z2-9]{8})$/;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const HARNESS_START = Date.now() - 3_600_000;

/**
 * Ids and times each side generates itself differ run to run. A fresh cuid becomes "<cuid>" and a time
 * since the harness started becomes "<now>", so shape and recency are still compared exactly. An artifact
 * list cursor carries the instant its sequence started (asOf), which each side takes from its own clock: that
 * one field is read like any other time, and the rest of the cursor is compared as is.
 */
function normalize<T>(value: T): T {
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const cursor = artifactCursor(node);
      if (cursor) return cursor;
      const share = PAGE_SHARE_URL.exec(node);
      if (share) return `${share[1]}<share-token>`;
      if (PAGE_SHARE_HASH.test(node)) return "<share-token-hash>";
      if (CUID.test(node)) return "<cuid>";
      if (SECRET_ID.test(node)) return "<secret-id>";
      if (WEBHOOK_SECRET.test(node)) return "<webhook-secret>";
      if (LINK_CODE.test(node)) return "<code>";
      // Times near now (link-code expiry is minutes ahead) vary per run; instants days away are the case's own data.
      if (
        ISO_TIME.test(node) &&
        Date.parse(node) >= HARNESS_START &&
        Date.parse(node) <= Date.now() + 6 * 3_600_000
      )
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

const ARTIFACT_CURSOR_KEYS = ["createdAt", "id", "botId", "madeByBots", "asOf"].join(",");

/** An artifact list cursor with its asOf read as a time, or undefined when the string is not one. */
function artifactCursor(text: string): string | undefined {
  if (!text.startsWith("v1.")) return undefined;
  try {
    const record = JSON.parse(Buffer.from(text.slice(3), "base64url").toString("utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      Object.keys(record).join(",") !== ARTIFACT_CURSOR_KEYS
    )
      return undefined;
    const near =
      ISO_TIME.test(record.asOf) &&
      Date.parse(record.asOf) >= HARNESS_START &&
      Date.parse(record.asOf) <= Date.now() + 6 * 3_600_000;
    return `v1.${Buffer.from(JSON.stringify({ ...record, asOf: near ? "<now>" : record.asOf })).toString("base64url")}`;
  } catch {
    return undefined;
  }
}

/** Runs a call and reports the roster and Space-change signals published while it ran. */
async function observed(
  settleMs: number,
  call: () => Promise<any>,
  seeded: Seeded,
  procedure: string,
) {
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
        const signal = JSON.parse(payload) as { topic?: unknown; payload?: unknown };
        const topic = typeof signal.topic === "string" ? signal.topic : "";
        const body = typeof signal.payload === "string" ? signal.payload : "";
        // The API's own 30s job reconciler drains the seeded ComputerUpdate rows and announces each
        // one; computer.updates is a read and publishes nothing, so its window cannot own these.
        if (
          procedure === "computer.updates" &&
          topic.startsWith("space-changes:") &&
          body === "computerUpdates"
        ) {
          return false;
        }
        // TypeScript's routine sweep wakes the seeded overdue routine at its own moment and announces
        // the run it starts; routines.list is a read and publishes nothing, so its window cannot own these.
        if (
          procedure === "routines.list" &&
          topic.startsWith("space-changes:") &&
          (body === "routines" || body === "runs")
        ) {
          return false;
        }
        const name = topic.slice(topic.indexOf(":") + 1);
        // A case's ids: its own people, its Spaces, and every thread it seeds (all of which start
        // with the case's user id). Ids a case creates beside its own (other people, another
        // organization's Spaces) share the id prefix too.
        const ownId = (id: string) =>
          own.includes(id) || id.startsWith(`${seeded.userId}-`) || id === `${seeded.orgId}-f`;
        if (topic.startsWith("thread:")) return body.startsWith('{"cursor":') && ownId(name);
        if (topic.startsWith("board:")) return own.includes(name);
        if (topic.startsWith("organization-changes:")) {
          return ownId(name) || idPrefixOfOrgMember(name, seeded);
        }
        return (
          (topic.startsWith("roster-") || topic.startsWith("space-changes:")) &&
          (own.some((id) => topic.endsWith(`:${id}`)) ||
            // Ids a case creates beside its own (other people, another organization's Spaces).
            name.startsWith(seeded.userId.slice(0, -1)))
        );
      } catch {
        return false;
      }
    })
    // A board frame carries the instant it was made; each side takes its own clock.
    .map(normalizeSignal)
    .sort();
  return { ...result, notifications };
}

/** Whether a person is one the case added beside its own (a member seeded for an organization case). */
function idPrefixOfOrgMember(id: string, seeded: Seeded) {
  return id === `${seeded.userId}-other` || id.startsWith(`${seeded.userId}-m`);
}

/** Reads a board frame's createdAt like any other instant: recency is compared, not the value. */
function normalizeSignal(payload: string) {
  try {
    const signal = JSON.parse(payload) as { topic?: string; payload?: string };
    if (signal.topic === "secret-store-change" && typeof signal.payload === "string") {
      // Each side seals its own refs and has its own process origin; the shape and the order of
      // the announcements are what must match.
      const event = JSON.parse(signal.payload) as { origin?: string; ref?: string };
      const ref = typeof event.ref === "string" ? event.ref : "";
      const kind = ref.startsWith("rkz1:") ? "<rkz1>" : ref.startsWith("v2:") ? "<v2>" : ref;
      return JSON.stringify({
        topic: signal.topic,
        payload: JSON.stringify({ origin: "<origin>", ref: kind }),
      });
    }
    if (!signal.topic?.startsWith("board:") || typeof signal.payload !== "string") return payload;
    const frame = JSON.parse(signal.payload) as { createdAt?: string };
    if (typeof frame.createdAt !== "string") return payload;
    const near =
      Date.parse(frame.createdAt) >= HARNESS_START &&
      Date.parse(frame.createdAt) <= Date.now() + 6 * 3_600_000;
    return JSON.stringify({
      ...signal,
      payload: JSON.stringify({ ...frame, createdAt: near ? "<now>" : frame.createdAt }),
    });
  } catch {
    return payload;
  }
}

async function databaseState(seeded: ReturnType<typeof ids>, procedure?: string) {
  const stateUsers = { in: [seeded.userId, `${seeded.userId}-other`] };
  const skills = await system.agentSkill.findMany({
    where: { userId: stateUsers },
    select: {
      id: true,
      spaceId: true,
      allSpaces: true,
      name: true,
      description: true,
      content: true,
      source: true,
    },
    orderBy: { id: "asc" },
  });
  const skillSpaces = await system.agentSkillSpace.findMany({
    where: { userId: stateUsers },
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
  const secretRows = await system.secret.findMany({
    where: { userId: seeded.userId },
    select: { id: true, spaceId: true },
    orderBy: { id: "asc" },
  });
  // A procedure that lets the store choose its record id (bots.rotateWebhookSecret) makes the raw
  // id random, and ordering by it before normalization would let two different rows swap places
  // between the two sides. Order by the normalized id instead; rows that normalize alike are
  // identical after normalization, so their relative order cannot matter.
  const secretOrder = (row: { id: string; spaceId: string | null }) =>
    `${SECRET_ID.test(row.id) ? "<secret-id>" : row.id}|${row.spaceId ?? ""}`;
  const secrets = secretRows.sort((left, right) =>
    secretOrder(left).localeCompare(secretOrder(right)),
  );
  const owners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const paymentRows = await system.payment.findMany({
    where: { userId: owners },
    select: { id: true, userId: true, amount: true, currency: true, releasedAt: true },
    orderBy: { id: "asc" },
  });
  // Each side seeds at its own "now"; whether a payment is released is what matters.
  const payments = paymentRows.map(({ releasedAt, ...row }) => ({
    ...row,
    released: releasedAt !== null,
  }));
  const spendingLimits = await system.spendingLimit.findMany({
    where: { userId: owners },
    select: { userId: true, amount: true, currency: true, period: true },
    orderBy: { userId: "asc" },
  });
  const pages = await system.page.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      userId: true,
      botId: true,
      groupId: true,
      title: true,
      visibility: true,
      currentVersion: true,
      shareTokenHash: true,
      shareSecretId: true,
      pinnedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const botSections = await system.botSection.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, userId: true, name: true, position: true },
    orderBy: { id: "asc" },
  });
  const threadReads = await system.threadRead.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      threadId: true,
      userId: true,
      spaceId: true,
      unread: true,
      lastReadSeq: true,
      snoozedUntil: true,
    },
    orderBy: [{ threadId: "asc" }, { userId: "asc" }],
  });
  const externalConversations = await system.externalConversation.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      userId: true,
      teamChatAmbientEnabled: true,
      teamChatRules: true,
      automatedSenderPolicies: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const messagingIdentities = await system.messagingIdentity.findMany({
    where: { userId: owners },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      botId: true,
      provider: true,
      address: true,
      installationId: true,
      updatedAt: true,
    },
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
    orderBy: [
      { spaceId: "asc" },
      { createdByUserId: "asc" },
      { matchKind: "asc" },
      { matchValue: "asc" },
      { effect: "asc" },
    ],
  });
  const spaceSettingOverrides = await system.spaceSettingOverride.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }, { setting: "asc" }],
  });
  const spaceModelChoices = await system.spaceModelRoleChoice.findMany({
    where: { spaceId: { in: seeded.spaces } },
    orderBy: [{ spaceId: "asc" }, { userId: "asc" }, { role: "asc" }, { position: "asc" }],
  });
  const userModelChoices = await system.userModelRoleChoice.findMany({
    where: { userId: owners },
    orderBy: [{ userId: "asc" }, { role: "asc" }, { position: "asc" }],
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
  const connections = await system.connection.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      provider: true,
      displayName: true,
      status: true,
      connectorId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const artifacts = await system.artifact.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      groupId: true,
      runId: true,
      name: true,
      mimeType: true,
      version: true,
      rootArtifactId: true,
      standalone: true,
      createdAt: true,
    },
    orderBy: { id: "asc" },
  });
  const modelCredentials = await system.userModelCredential.findMany({
    where: { userId: owners },
    select: {
      id: true,
      userId: true,
      provider: true,
      label: true,
      secretId: true,
      supportsImages: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  // Memory content is stored sealed: read the raw column and open it with the same extension the
  // API reads through, so a row written by Go must open here (and a row sealed here must open in Go,
  // which every memory case proves by reading the seeded values).
  const inspectMemoryContent = async (model: "MemoryDocument" | "MemoryRevision", raw: any) => {
    const value = raw.content;
    if (typeof value !== "string" || !value.startsWith("rkz1:"))
      return { sealed: false, content: value ?? null };
    try {
      const [opened] = await contentEncryptionOf(system)!.openRows(model, [raw]);
      return { sealed: true, content: opened.content };
    } catch (error) {
      return { sealed: true, error: (error as Error).message };
    }
  };
  const rawMemoryDocuments =
    (await system.$queryRaw`SELECT id, "spaceId", "userId", "botId", scope, path, content, revision, "createdAt", "updatedAt"
    FROM memory_documents WHERE "spaceId" = ANY(${seeded.spaces}::text[])
    ORDER BY "spaceId", scope, path, id`) as any[];
  const memoryDocuments = [];
  for (const raw of rawMemoryDocuments) {
    memoryDocuments.push({
      id: raw.id,
      spaceId: raw.spaceId,
      userId: raw.userId,
      botId: raw.botId,
      scope: raw.scope,
      path: raw.path,
      revision: raw.revision,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(await inspectMemoryContent("MemoryDocument", raw)),
    });
  }
  const rawMemoryRevisions =
    (await system.$queryRaw`SELECT r.id, r."documentId", r.revision, r.content, r."sourceRunId", r."sourceThreadId", r."createdAt"
    FROM memory_revisions r JOIN memory_documents d ON d.id = r."documentId"
    WHERE d."spaceId" = ANY(${seeded.spaces}::text[])
    ORDER BY r."documentId", r.revision, r.id`) as any[];
  const memoryRevisions = [];
  for (const raw of rawMemoryRevisions) {
    memoryRevisions.push({
      id: raw.id,
      documentId: raw.documentId,
      revision: raw.revision,
      sourceRunId: raw.sourceRunId,
      sourceThreadId: raw.sourceThreadId,
      createdAt: raw.createdAt,
      ...(await inspectMemoryContent("MemoryRevision", raw)),
    });
  }
  // Messages and events are rkz1 JSON columns: read them raw and open them with the extension,
  // so a row written by either side must open here, and each side's rows must match.
  const inspectContent = async (
    model: "Message" | "Event",
    raw: any,
    field: "blocks" | "payload",
  ) => {
    // Each side seals with its own freshly created Space key, so raw ciphertext never matches; the
    // opened value is what both sides must agree on.
    const value = raw[field];
    const sealed =
      typeof value === "string" ||
      (Array.isArray(value) &&
        value.some((entry: any) => entry && typeof entry === "object" && "$sealed" in entry));
    try {
      const [opened] = await contentEncryptionOf(system)!.openRows(model, [raw]);
      return { sealed, [field]: opened[field] };
    } catch (error) {
      // The ciphertext itself is each side's own; the failure is what has to match.
      return { sealed, [field]: null, error: (error as Error).message };
    }
  };
  const rawThreads =
    (await system.$queryRaw`SELECT id, "spaceId", "botId", "groupId", "nextMessageSeq", "nextEventSeq", "historyCompactedUpToSeq", "historyCompactionSummary"
    FROM threads WHERE "userId" = ANY(${owners.in}::text[]) ORDER BY id`) as any[];
  const threads = [];
  for (const raw of rawThreads) {
    const summary = raw.historyCompactionSummary;
    let summaryState: any = { sealed: false, content: summary ?? null };
    if (typeof summary === "string" && summary.startsWith("rkz1:")) {
      try {
        const [opened] = await contentEncryptionOf(system)!.openRows("Thread", [raw]);
        summaryState = { sealed: true, content: opened.historyCompactionSummary };
      } catch (error) {
        summaryState = { sealed: true, error: (error as Error).message };
      }
    }
    threads.push({
      id: raw.id,
      spaceId: raw.spaceId,
      botId: raw.botId,
      groupId: raw.groupId,
      nextMessageSeq: raw.nextMessageSeq,
      nextEventSeq: raw.nextEventSeq,
      historyCompactedUpToSeq: raw.historyCompactedUpToSeq,
      summary: summaryState,
    });
  }
  const rawMessages =
    (await system.$queryRaw`SELECT id, "threadId", seq, role, blocks, "botId", "authorUserId", "replyToMessageId", "replyQuote", "runId", "clientNonce", "searchTokens", "createdAt"
    FROM messages WHERE "threadId" LIKE ${`${seeded.userId}-%`} ORDER BY "threadId", seq, id`) as any[];
  const messages = [];
  for (const raw of rawMessages) {
    // Blind-index tokens are an HMAC under the Space key, and each side has its own key, so the
    // numbers cannot be equal. Their presence and how many there are still must be (infra-a's
    // proof pins the arithmetic itself).
    const tokens = Array.isArray(raw.searchTokens)
      ? { present: true, count: raw.searchTokens.length }
      : { present: false };
    const { searchTokens: _tokens, ...rest } = raw;
    messages.push({
      ...rest,
      searchTokens: tokens,
      ...(await inspectContent("Message", raw, "blocks")),
    });
  }
  const rawEvents =
    (await system.$queryRaw`SELECT id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt"
    FROM events WHERE "threadId" LIKE ${`${seeded.userId}-%`} ORDER BY "threadId", seq, id`) as any[];
  const events = [];
  for (const raw of rawEvents) {
    events.push({ ...raw, ...(await inspectContent("Event", raw, "payload")) });
  }
  // The rows the ticket, taught-skill and organization writes leave behind.
  const boards = await system.board.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, name: true, ticketPrefix: true, nextNumber: true },
    orderBy: { spaceId: "asc" },
  });
  const tickets = await system.ticket.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      boardId: true,
      spaceId: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      assigneeBotId: true,
      ownerUserId: true,
      ownerBotId: true,
      workerBotIds: true,
      createdByBotId: true,
      createdByUserId: true,
      completedAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const ticketComments = await system.ticketComment.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      ticketId: true,
      spaceId: true,
      authorUserId: true,
      authorBotId: true,
      body: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const taughtSkills = await system.taughtSkill.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      userId: true,
      name: true,
      goal: true,
      status: true,
      playbook: true,
      recording: true,
      startedAt: true,
      expiresAt: true,
      stoppedAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const organizationIDs = [seeded.orgId, `${seeded.orgId}-f`];
  const members = await system.member.findMany({
    where: { organizationId: { in: organizationIDs } },
    select: { organizationId: true, userId: true, role: true },
    orderBy: [{ organizationId: "asc" }, { userId: "asc" }],
  });
  const invitations = await system.invitation.findMany({
    where: { organizationId: { in: organizationIDs } },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      inviterId: true,
    },
    orderBy: { id: "asc" },
  });
  const trustedLinkSites = await system.trustedLinkSite.findMany({
    where: { userId: { in: [seeded.userId, `${seeded.userId}-other`] } },
    select: { userId: true, site: true },
    orderBy: [{ userId: "asc" }, { site: "asc" }],
  });
  const byJson = (left: unknown, right: unknown) =>
    JSON.stringify(left) < JSON.stringify(right) ? -1 : 1;
  const securityEvents = (await system.securityEvent.findMany({ where: { userId: owners } })).sort(
    byJson,
  );
  const auditEvents = (
    await system.auditEvent.findMany({
      where: { OR: [{ organizationId: seeded.orgId }, { actorId: seeded.userId }] },
    })
  ).sort(byJson);
  const bots = await system.bot.findMany({
    where: { userId: owners },
    select: {
      id: true,
      spaceId: true,
      archivedAt: true,
      updatedAt: true,
      position: true,
      section: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });
  const groups = await system.chatGroup.findMany({
    where: { userId: owners },
    select: {
      id: true,
      spaceId: true,
      archivedAt: true,
      updatedAt: true,
      section: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });
  const run1Rows =
    procedure === "routines.testRun" || procedure === "skills.testRun"
      ? {
          run1Tasks: await system.task.findMany({
            where: { spaceId: { in: seeded.spaces } },
            select: {
              id: true,
              spaceId: true,
              botId: true,
              threadId: true,
              userId: true,
              prompt: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { id: "asc" },
          }),
          run1Runs: await system.run.findMany({
            where: { spaceId: { in: seeded.spaces } },
            select: {
              id: true,
              spaceId: true,
              botId: true,
              threadId: true,
              taskId: true,
              userId: true,
              status: true,
              trigger: true,
              modelProvider: true,
              modelId: true,
              thinkingLevel: true,
              modelPinned: true,
              clientNonce: true,
              routineId: true,
              wakeAt: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { id: "asc" },
          }),
        }
      : {};
  const run1Assignments =
    procedure === "mcp.assignments.approve"
      ? await system.botMcpServer.findMany({
          where: { spaceId: { in: seeded.spaces } },
          orderBy: { id: "asc" },
        })
      : [];
  const botEmailAddresses = await system.botEmailAddress.findMany({
    where: { name: { startsWith: `ct${RUN_TAG}-` } },
    select: { name: true, botId: true, createdAt: true },
    orderBy: { name: "asc" },
  });
  const spaceMemoryConfigs = await system.spaceMemoryConfig.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      spaceId: true,
      provider: true,
      settings: true,
      defaultMemoryScope: true,
      secretId: true,
      updatedAt: true,
    },
    orderBy: { spaceId: "asc" },
  });
  const routineRows = await system.routine.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      id: true,
      botId: true,
      userId: true,
      active: true,
      resumeOnRestore: true,
      nextRunAt: true,
    },
    orderBy: { id: "asc" },
  });
  // Each side computes from its own "now"; whether a run is scheduled is what matters.
  const routines = routineRows.map(({ nextRunAt, ...row }) => ({
    ...row,
    nextRunAt: nextRunAt ? "<set>" : null,
  }));
  // The rows a routine change posts in its chat: one system message per change.
  const routineNotices = (
    await system.message.findMany({
      where: { thread: { spaceId: { in: seeded.spaces } }, role: "system" },
      select: { threadId: true, seq: true, botId: true, blocks: true },
      orderBy: [{ threadId: "asc" }, { seq: "asc" }],
    })
  ).filter((row) => JSON.stringify(row.blocks).includes('"routine_event"'));
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
    botEmailAddresses,
    spaceMemoryConfigs,
    routines,
    routineNotices,
    ...run1Rows,
    run1Assignments,
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
    userModelChoices,
    spaceVoicePreferences,
    autoReviewPreferences,
    vaultCredentials,
    connections,
    membership: await membershipState(system, seeded),
    artifacts,
    modelCredentials,
    memoryDocuments,
    memoryRevisions,
    threads,
    messages,
    events,
    boards,
    tickets,
    ticketComments,
    taughtSkills,
    members,
    invitations,
    ...(await laneHState(system, seeded)),
    ...(await laneJState(system, seeded, procedure)),
    // computer.updates is a read; the API's in-process reconciler can drain the seeded
    // ComputerUpdate rows between the two sides' captures, so those volatile rows are not
    // compared for it (the response body and the other tables still are).
    ...(procedure === "computer.updates" ? { laneHComputerUpdates: [] } : {}),
  };
}

// A killed run leaves the rows of the case it was in. Invites carry a globally unique token
// hash, so an earlier case in the next run could collide with one: the fixture is disposable,
// so a run starts with the invite table empty (each case seeds and resets its own).
await system.spaceInvite.deleteMany({});

let failures = 0;
let caseIndex = 0;
for (const testCase of cases) {
  const position = caseIndex++;
  // CASE_FROM=<n> resumes a run at a case index after a timeout; cases keep their order.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
  if (process.env.CASE_FROM && position < Number(process.env.CASE_FROM)) continue;
  // CASE_FILTER=<regexp> reruns only the matching cases.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
  if (process.env.CASE_FILTER && !new RegExp(process.env.CASE_FILTER).test(testCase.name)) continue;
  if (Boolean(testCase.email) !== EMAIL_ON) continue;
  const mode = routeMode(testCase.procedure);
  if (mode !== "go" && mode !== "shadow") {
    failures += 1;
    console.error(
      `FAIL ${testCase.name}: ${testCase.procedure} is routed ${mode}, not go/shadow`,
    );
    continue;
  }
  const caseIds = ids(testCase.name);
  COMPUTER_UPDATE_BASE = Date.now() - 30_000;
  const input = withIds(testCase.input, caseIds);
  // A write has realtime signals to wait for; a read only needs to show it sent none.
  const settle =
    WRITE_PROCEDURES.has(testCase.procedure) || testCase.procedure.startsWith("messaging.")
      ? 400
      : 40;

  let seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  if (testCase.admin)
    await system.user.update({
      where: { id: seeded.userId },
      data: { email: CONTRACT_ADMIN_EMAIL, emailVerified: true },
    });
  const tsResult = await observed(
    settle,
    () => run(testCase, tsCall, input, seeded),
    seeded,
    testCase.procedure,
  );
  let tsCheckError: unknown;
  try {
    await testCase.check?.({ seeded, result: tsResult, side: "ts", gatewayLog });
  } catch (error) {
    tsCheckError = error;
  }
  const tsState = normalize(await databaseState(caseIds, testCase.procedure));

  // A TypeScript background job (a restored routine's first run, say) publishes its Space changes
  // after the request returned; the Go side enqueues the same job but nothing executes it in the
  // harness, so its signals would land only on the TypeScript side's tab. Drop the stragglers in
  // this gap, before the Go window starts capturing.
  if (testCase.gapMs) await sleep(testCase.gapMs);

  seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  if (testCase.admin)
    await system.user.update({
      where: { id: seeded.userId },
      data: { email: CONTRACT_ADMIN_EMAIL, emailVerified: true },
    });
  const hitsBefore = upstreamHits;
  gatewayLog = "";
  let goCallForCase = goCall;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
  if (process.env.CONTRACT_PROXY_ONE_CONCURRENT === "1" && testCase.concurrent) {
    let dispatched = 0;
    goCallForCase = (procedure, caseInput, caseSeeded) => {
      dispatched += 1;
      return dispatched === 1
        ? proxyCall(procedure, caseInput, caseSeeded)
        : goCall(procedure, caseInput, caseSeeded);
    };
  }
  const goResult = await observed(
    settle,
    () => run(testCase, goCallForCase, input, seeded),
    seeded,
    testCase.procedure,
  );
  let goCheckError: unknown;
  try {
    await testCase.check?.({ seeded, result: goResult, side: "go", gatewayLog });
  } catch (error) {
    goCheckError = error;
  }
  const goState = normalize(await databaseState(caseIds, testCase.procedure));

  try {
    if (tsCheckError) throw tsCheckError;
    if (goCheckError) throw goCheckError;
    if (testCase.declines !== undefined)
      assert.equal(
        upstreamHits - hitsBefore,
        testCase.declines ? 1 : 0,
        `${testCase.name}: ${testCase.declines ? "Go should decline" : "Go should answer"}`,
      );
    // Every request in the Go window must be a local answer, not a proxy fallback. Shadow
    // comparisons call the same local server and log the same marker; they run after the TS
    // response, inside the observed settle window. `after` reloads are TypeScript-only and
    // never appear in the gateway log, so they cannot inflate this count.
    if (mode === "go" || mode === "shadow") {
      if (testCase.declines !== true) {
        const expectedCalls = goResult.calls ?? 1;
        const served = servedByGoCount(gatewayLog, testCase.procedure);
        assert.ok(
          served >= expectedCalls,
          `${testCase.name}: ${served} served_by:go entries for ${expectedCalls} expected calls`,
        );
      }
    }
    assert.equal(goResult.status, tsResult.status, `${testCase.name}: status`);
    assert.deepEqual(goResult.headers, tsResult.headers, `${testCase.name}: headers`);
    assert.deepEqual(normalize(goResult.body), normalize(tsResult.body), `${testCase.name}: body`);
    if (!testCase.ignoreSignals)
      assert.deepEqual(
        goResult.notifications,
        tsResult.notifications,
        `${testCase.name}: realtime signals`,
      );
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
await owner?.end();

go?.kill("SIGTERM");
proxyGo?.kill("SIGTERM");
upstreamServer.close();
await handles.stop();
await rm(dataDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} contract case(s) failed`);
  process.exit(1);
}
console.log(`contract: ${cases.length} cases match`);
