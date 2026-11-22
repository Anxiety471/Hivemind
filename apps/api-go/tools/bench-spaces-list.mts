/**
 * Manual benchmark: spaces.list with a few hundred seeded bots, TypeScript in-process
 * against the Go gateway, reporting p50/p95 latency.
 *
 * Run from the lane with a disposable fixture and a built gateway:
 *   set -a; . /home/hitori/lanes/spaces-runs-fixture/.env; set +a
 *   export ENCRYPTION_KEY=contract-test-encryption-key-0123456789abcdef NODE_ENV=test
 *   export GO_BINARY=/tmp/spaces-runs-gateway GO_PORT=3269 UPSTREAM_PORT=3969
 *   export BUILD_ID_FILE=/tmp/spaces-runs-build-id
 *   node_modules/.bin/tsx apps/api-go/tools/bench-spaces-list.mts
 *
 * The fixture is disposable, so the seeded rows are left behind.
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { asSystem } from "../../../packages/db/src/index.js";
import { createApp } from "../../api/src/app.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

const DATABASE_URL = process.env.DATABASE_URL;
const GO_BINARY = process.env.GO_BINARY;
const GO_PORT = process.env.GO_PORT ?? "3269";
const UPSTREAM_PORT = process.env.UPSTREAM_PORT ?? "3969";
const BUILD_ID_FILE = process.env.BUILD_ID_FILE ?? "/tmp/spaces-runs-build-id";
if (!DATABASE_URL || !GO_BINARY) throw new Error("DATABASE_URL and GO_BINARY are required");

const SECRET = "contract-test-secret-0123456789abcdef";
const WEB_ORIGIN = "http://127.0.0.1:5173";
const BOTS = Number(process.env.BENCH_BOTS ?? "300");
const CALLS = Number(process.env.BENCH_CALLS ?? "40");
const ID = "bench-sp";
const userId = `${ID}-user`;
const orgId = `${ID}-org`;
const spaces = [`${ID}-s1`, `${ID}-s2`, `${ID}-s3`];
const cookie = (() => {
  const token = `${ID}-session-token`;
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
})();

const dataDir = await mkdtemp(join(tmpdir(), "rakazo-bench-"));
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
  sandboxProvider: "fake",
  wakeupDriver: "memory",
} as never);
const system = asSystem(handles.prisma);

async function seed() {
  await system.user.create({
    data: { id: userId, name: "Bench User", email: `${userId}@example.test`, emailVerified: true },
  });
  await system.organization.create({
    data: { id: orgId, name: "Bench Org", slug: `bench-${userId}`, createdAt: new Date() },
  });
  await system.member.create({
    data: { id: `${orgId}-m`, organizationId: orgId, userId, role: "owner", createdAt: new Date() },
  });
  for (const [index, spaceId] of spaces.entries()) {
    await system.space.create({
      data: { id: spaceId, organizationId: orgId, name: `Space ${index + 1}`, isDefault: index === 0 },
    });
    await system.spaceMember.create({
      data: { id: `${spaceId}-m`, spaceId, organizationId: orgId, userId, role: "owner", createdAt: new Date() },
    });
    await system.botSection.create({
      data: { id: `${spaceId}-section`, spaceId, userId, name: "Bench section", position: 0 },
    });
  }
  await system.session.create({
    data: {
      id: `${ID}-session`,
      expiresAt: new Date(Date.now() + 86_400_000),
      token: `${ID}-session-token`,
      userId,
    },
  });
  const bots: Array<{ id: string; spaceId: string; threadId: string }> = [];
  for (let index = 0; index < BOTS; index += 1) {
    const spaceId = index % 10 === 0 ? spaces[1] : spaces[0];
    bots.push({ id: `${ID}-b${index}`, spaceId, threadId: `${ID}-t${index}` });
  }
  await system.bot.createMany({
    data: bots.map((bot, index) => ({
      id: bot.id,
      spaceId: bot.spaceId,
      userId,
      name: `Bench bot ${index}`,
      color: "blue",
      pinned: index % 25 === 0,
      sectionId: `${bot.spaceId}-section`,
    })),
  });
  await system.thread.createMany({
    data: bots.map((bot) => ({
      id: bot.threadId,
      spaceId: bot.spaceId,
      userId,
      botId: bot.id,
      nextMessageSeq: 6,
      nextEventSeq: 0,
    })),
  });
  await system.threadRead.createMany({
    data: bots.map((bot, index) => ({
      threadId: bot.threadId,
      userId,
      spaceId: bot.spaceId,
      unread: index % 7 === 0,
      lastReadSeq: 3,
    })),
  });
  const messages: Array<Record<string, unknown>> = [];
  for (const bot of bots) {
    for (const seq of [1, 2, 3, 4, 5]) {
      messages.push({
        id: `${bot.threadId}-m${seq}`,
        threadId: bot.threadId,
        seq,
        role: seq === 5 ? "bot" : "user",
        blocks: [{ kind: "text", text: `Message ${seq} in ${bot.id}` }],
      });
    }
  }
  for (let index = 0; index < messages.length; index += 500) {
    await system.message.createMany({ data: messages.slice(index, index + 500) as never });
  }
  // A group with two active bots and a preview.
  await system.chatGroup.create({
    data: { id: `${ID}-g1`, spaceId: spaces[0], userId, name: "Bench group" },
  });
  for (const member of [0, 1]) {
    await system.chatGroupMember.create({
      data: { id: `${ID}-gm${member}`, groupId: `${ID}-g1`, botId: bots[member]!.id },
    });
  }
  await system.thread.create({
    data: {
      id: `${ID}-gt1`,
      spaceId: spaces[0],
      userId,
      groupId: `${ID}-g1`,
      nextMessageSeq: 2,
      nextEventSeq: 0,
    },
  });
  await system.message.create({
    data: { id: `${ID}-gm1`, threadId: `${ID}-gt1`, seq: 1, role: "user", blocks: [{ kind: "text", text: "Group hi" }] },
  });
}

const headers = {
  "content-type": "application/json",
  origin: WEB_ORIGIN,
  cookie,
  "x-rakazo-space-id": spaces[0]!,
  "user-agent": "bench-spaces-list/1",
  "x-forwarded-for": "198.51.100.77",
};

const upstream = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && name !== "host" && name !== "content-length") {
      responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const response = await handles.app.request(
    incoming.url ?? "/",
    { method: incoming.method, headers: responseHeaders, body: Buffer.concat(chunks) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const answer: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    answer[name] = value;
  });
  outgoing.writeHead(response.status, answer);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => upstream.listen(Number(UPSTREAM_PORT), "127.0.0.1", resolve));

const routesFile = join(dataDir, "routes.json");
await writeFile(routesFile, JSON.stringify({ default: "proxy", routes: { "spaces.list": { mode: "go", readOnly: true } } }));

await seed();

const go = spawn(
  GO_BINARY,
  ["-listen", `127.0.0.1:${GO_PORT}`, "-upstream", `http://127.0.0.1:${UPSTREAM_PORT}`, "-routes", routesFile, "-build-id-file", BUILD_ID_FILE],
  {
    env: {
      ...process.env,
      DATABASE_URL,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: WEB_ORIGIN,
      WEB_ORIGIN,
      ENCRYPTION_KEY: CONTRACT_ENCRYPTION_KEY,
      CONTENT_ENCRYPTION: "on",
      MAX_UPLOAD_SIZE_MB: "10",
      PHONE_CALLS_ENABLED: "true",
      PHONE_CALL_RING_SECONDS: "45",
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
const goURL = `http://127.0.0.1:${GO_PORT}`;
for (let attempt = 0; attempt < 200; attempt += 1) {
  try {
    if ((await fetch(`${goURL}/healthz`)).ok) break;
  } catch {
    // still starting
  }
  if (attempt === 199) throw new Error("go gateway did not start");
  await sleep(50);
}

async function tsCall() {
  const response = await handles.app.request(
    "/rpc/spaces/list",
    { method: "POST", headers, body: JSON.stringify({ json: {} }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  if (response.status !== 200) throw new Error(`ts status ${response.status}`);
  return response.arrayBuffer();
}

async function goCall() {
  const response = await fetch(`${goURL}/rpc/spaces/list`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: {} }),
  });
  if (response.status !== 200) throw new Error(`go status ${response.status}: ${await response.text()}`);
  return response.arrayBuffer();
}

function percentile(samples: number[], fraction: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index]!;
}

async function measure(label: string, call: () => Promise<ArrayBuffer>) {
  for (let index = 0; index < 5; index += 1) await call();
  const samples: number[] = [];
  let bytes = 0;
  for (let index = 0; index < CALLS; index += 1) {
    const started = performance.now();
    const body = await call();
    samples.push(performance.now() - started);
    bytes = body.byteLength;
  }
  console.log(
    `${label}: p50 ${percentile(samples, 0.5).toFixed(1)} ms, p95 ${percentile(samples, 0.95).toFixed(1)} ms, ` +
      `min ${Math.min(...samples).toFixed(1)} ms, max ${Math.max(...samples).toFixed(1)} ms, body ${(bytes / 1024).toFixed(0)} KiB, n=${CALLS}`,
  );
}

try {
  await measure("TypeScript spaces.list", tsCall);
  await measure("Go spaces.list        ", goCall);
} finally {
  go.kill("SIGTERM");
  upstream.close();
  await handles.stop();
}
