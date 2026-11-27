/**
 * Lane O setup: the database clients, the TypeScript app, the upstream bridge, and the Go gateway
 * process. Importing this module starts them, in order, once.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { asSystem } from "../../../packages/db/src/index.js";
import { createApp } from "../../api/src/app.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
export const GO_BINARY = process.env.GO_BINARY;
if (!GO_BINARY) throw new Error("GO_BINARY is required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
export const BUILD_ID_FILE = process.env.BUILD_ID_FILE ?? join(process.cwd(), "apps/web/dist/build-id");
export const SECRET = "contract-test-secret-0123456789abcdef";
export const WEB_ORIGIN = "http://127.0.0.1:5173";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
export const RUN_TAG = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : "";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
export const GO_PORT = process.env.GO_PORT ?? "3284";
export const GO_URL = `http://127.0.0.1:${GO_PORT}`;
// The gateway's upstream bridge: the in-process app, so a proxied stream would still answer.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: manual harness, not a turbo task
export const UPSTREAM_PORT = process.env.UPSTREAM_PORT ?? "3996";

process.env.PHONE_CALLS_ENABLED = "true";
process.env.PHONE_CALL_RING_SECONDS = "45";
// The app reads these through loadEnv at createApp time; the fixture env file need not carry them.
process.env.NODE_ENV = "test";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.SIGNUPS_ENABLED = "true";
process.env.BETTER_AUTH_SECRET = SECRET;
process.env.ENCRYPTION_KEY = CONTRACT_ENCRYPTION_KEY;
process.env.CONTENT_ENCRYPTION = "on";

// A raw listener: proves a signal was published, independent of either side's fanout.
export const databaseRequire = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
export type PgClientLike = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: { payload?: string }) => void): void;
};
const { Client: PgClient } = databaseRequire("pg") as {
  Client: new (options: { connectionString: string }) => PgClientLike;
};
export const signals: string[] = [];
export const signalClient = new PgClient({ connectionString: DATABASE_URL });
// The owner connection: RLS lets the app role update no row it did not scope, and content writes
// must bypass the system client's sealing to plant a ciphertext no key can open.
export const ownerClient = new PgClient({ connectionString: process.env.DATABASE_MIGRATION_URL ?? DATABASE_URL });
await signalClient.connect();
await ownerClient.connect();
await signalClient.query("LISTEN rakazo_events");
signalClient.on("notification", (notification) => {
  if (notification.payload) signals.push(notification.payload);
});

export const dataDir = await mkdtemp(join(tmpdir(), "rakazo-contract-o-"));
export const handles = await createApp({
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
  adminEmails: [],
  inboundEmail: { domain: "bots.contract.test", secret: "contract-inbound-email-secret-0123456789" },
  sandboxProvider: "fake",
  wakeupDriver: "memory",
} as never);
export const system = asSystem(handles.prisma);

export const upstreamServer = createServer(async (incoming, outgoing) => {
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

export const routesFile = join(dataDir, "routes.json");
await writeFile(
  routesFile,
  JSON.stringify({
    default: "proxy",
    routes: {
      "threads.subscribe": { mode: "go" },
      "threads.helperSubscribe": { mode: "go" },
      "notifications.subscribe": { mode: "go" },
      "notifications.subscribeCalls": { mode: "go" },
    },
  }),
);

export const gateway: { process?: ChildProcess; log: string } = { log: "" };
export const gatewayEnv = {
  ...process.env,
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: WEB_ORIGIN,
  WEB_ORIGIN,
  ENCRYPTION_KEY: CONTRACT_ENCRYPTION_KEY,
  CONTENT_ENCRYPTION: "on",
  PHONE_CALLS_ENABLED: "true",
  PHONE_CALL_RING_SECONDS: "45",
};
const go = spawn(
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
export const capture = (chunk: Buffer) => {
  gateway.log += chunk.toString();
  process.stderr.write(chunk);
};
go.stdout?.on("data", capture);
go.stderr?.on("data", capture);
gateway.process = go;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(`${GO_URL}/healthz`)).ok) break;
  } catch {
    // still starting
  }
  if (attempt === 99) throw new Error("go gateway did not start");
  await sleep(50);
}

export function cookieFor(token: string) {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

export function callHeaders(seeded: Seeded) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    origin: WEB_ORIGIN,
    cookie: seeded.cookie,
    "x-rakazo-space-id": seeded.spaceId,
  };
}

// ---- fixture ---------------------------------------------------------------------------------

export type Seeded = {
  userId: string;
  orgId: string;
  spaceId: string;
  otherSpaceId: string;
  sessionToken: string;
  cookie: string;
  botId: string;
  otherBotId: string;
  groupId: string;
  threadId: string;
  otherThreadId: string;
  helperBotId: string;
  helperThreadId: string;
  callBotId: string;
  callThreadId: string;
};
