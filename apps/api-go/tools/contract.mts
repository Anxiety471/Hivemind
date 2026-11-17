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
];

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

async function reset(seeded: ReturnType<typeof ids>) {
  const { userId, orgId } = seeded;
  await system.agentSkillSpace.deleteMany({ where: { userId } });
  await system.mcpServerSpace.deleteMany({ where: { userId } });
  await system.capabilityInstallSpace.deleteMany({ where: { userId } });
  await system.agentSkill.deleteMany({ where: { userId } });
  await system.mcpServer.deleteMany({ where: { userId } });
  await system.capabilityInstall.deleteMany({ where: { userId } });
  await system.secret.deleteMany({ where: { userId } });
  await system.session.deleteMany({ where: { userId } });
  await system.spaceMember.deleteMany({ where: { userId } });
  await system.space.deleteMany({ where: { organizationId: orgId } });
  await system.member.deleteMany({ where: { organizationId: orgId } });
  await system.organization.deleteMany({ where: { id: orgId } });
  await system.user.deleteMany({ where: { id: userId } });
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

function withIds(input: unknown, seeded: ReturnType<typeof ids>) {
  return JSON.parse(
    JSON.stringify(input)
      .replaceAll("__skill__", seeded.skillId)
      .replaceAll("__sp1__", seeded.spaces[0])
      .replaceAll("__sp2__", seeded.spaces[1])
      .replaceAll("__sp3__", seeded.spaces[2]),
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
  const response = await handles.app.request(`/rpc/${procedure.replaceAll(".", "/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      cookie: seeded.cookie,
      "x-rakazo-space-id": seeded.spaces[0],
    },
    body: JSON.stringify({ json: input }),
  });
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
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      cookie: seeded.cookie,
      "x-rakazo-space-id": seeded.spaces[0],
    },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: selectedHeaders(response.headers),
    body: text ? JSON.parse(text) : null,
  };
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
  return { skills, skillSpaces, servers, serverSpaces, installs, installSpaces, secrets };
}

let failures = 0;
for (const testCase of cases) {
  const caseIds = ids(testCase.name);
  const input = withIds(testCase.input, caseIds);

  let seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  const tsResult = await tsCall(testCase.procedure, input, seeded);
  const tsState = await databaseState(caseIds);

  seeded = await seed(caseIds);
  if (testCase.seed) await testCase.seed(seeded);
  // Wait a moment after re-seeding so Prisma's timestamps settle, then call Go.
  const goResult = await goCall(testCase.procedure, input, seeded);
  const goState = await databaseState(caseIds);

  try {
    assert.equal(goResult.status, tsResult.status, `${testCase.name}: status`);
    assert.deepEqual(goResult.headers, tsResult.headers, `${testCase.name}: headers`);
    assert.deepEqual(goResult.body, tsResult.body, `${testCase.name}: body`);
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

go?.kill("SIGTERM");
await handles.stop();
await rm(dataDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} contract case(s) failed`);
  process.exit(1);
}
console.log(`contract: ${cases.length} cases match`);
