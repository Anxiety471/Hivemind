/**
 * Lone-surrogate procedure-boundary check.
 *
 * 1. Live Go paths: spaces.rename and organizations.rename echo `\ud800` through
 *    shared.EchoText; pages.rename stores through Postgres, where TS and Go both
 *    return U+FFFD. The responses are compared for each.
 * 2. The strict inputs (pages.list, pages.pin, pages.remove, pages.rename and
 *    spendingLimit.set at its root and nested limit) must answer with the same
 *    escaped key; externalConversations.updatePolicy must echo the saved policy
 *    with the same code units; and the TypeScript-only computerProvider value
 *    must survive the Go boundary decoder. Every case must be equal.
 *
 * Requires the disposable fixture database:
 *   set -a; . /home/hitori/go-port/fixture-db/.env.infra-d; set +a
 *   CONTENT_ENCRYPTION=off NODE_ENV=test \
 *     node_modules/.bin/tsx apps/api-go/tools/infra-d-surrogate-wire.mts
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  getComputerProviderSettings,
  updateComputerProviderSettings,
} from "../../api/src/computers/computer-provider-config.js";
import { createApp } from "../../api/src/app.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { asSystem } from "../../../packages/db/src/index.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const SECRET = "infra-d-surrogate-secret-0123456789abcdef";
const WEB_ORIGIN = "http://127.0.0.1:5173";
// 55484 is the gw-wtf8 lane's database; these are free harness-only ports.
const GO_PORT = process.env.SURROGATE_GO_PORT ?? "55486";
const UPSTREAM_PORT = process.env.SURROGATE_UPSTREAM_PORT ?? "55487";
const GO_URL = `http://127.0.0.1:${GO_PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), "infra-d-surrogate-"));
const gateway = join(dataDir, "rakazo-gateway");

const build = spawnSync("go", ["build", "-o", gateway, "./cmd/gateway"], {
  cwd: GO_DIR,
  encoding: "utf8",
  env: process.env,
});
if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);

const handles = await createApp({
  databaseUrl: DATABASE_URL,
  dataDir,
  authSecret: SECRET,
  encryptionKey: CONTRACT_ENCRYPTION_KEY,
  screenProxySecret: "infra-d-surrogate-screen-secret-0123456789",
  webOrigin: WEB_ORIGIN,
  authUrl: WEB_ORIGIN,
  nodeEnv: "test",
  signupsEnabled: "true",
  agentRuntime: "scripted",
  sandboxProvider: "fake",
  wakeupDriver: "memory",
} as never);
const system = asSystem(handles.prisma);

const upstream = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined && name !== "host" && name !== "content-length") {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
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
await new Promise<void>((resolve) => upstream.listen(Number(UPSTREAM_PORT), "127.0.0.1", resolve));

const routesFile = join(dataDir, "routes.json");
await writeFile(
  routesFile,
  JSON.stringify({
    default: "proxy",
    routes: {
      "spaces.rename": { mode: "go" },
      "organizations.rename": { mode: "go" },
      "pages.list": { mode: "go" },
      "pages.pin": { mode: "go" },
      "pages.remove": { mode: "go" },
      "pages.rename": { mode: "go" },
      "spendingLimit.set": { mode: "go" },
      "externalConversations.updatePolicy": { mode: "go" },
    },
  }),
);
let go: ReturnType<typeof spawn> | undefined;
const suffix = `${Date.now()}-${process.pid}`;
const ids = {
  userId: `sd-u-${suffix}`,
  orgId: `sd-o-${suffix}`,
  space1: `sd-s1-${suffix}`,
  space2: `sd-s2-${suffix}`,
  pageId: `sd-p-${suffix}`,
  botId: `sd-b-${suffix}`,
  externalId: `sd-x-${suffix}`,
  token: `sd-token-${suffix}-${"0".repeat(20)}`,
};
const cookie = `better-auth.session_token=${encodeURIComponent(
  `${ids.token}.${createHmac("sha256", SECRET).update(ids.token).digest("base64")}`,
)}`;

async function seed(): Promise<void> {
  await system.user.create({
    data: {
      id: ids.userId,
      name: "Surrogate Wire",
      email: `${ids.userId}@example.test`,
      emailVerified: true,
    },
  });
  await system.organization.create({
    data: { id: ids.orgId, name: "Surrogate Org", slug: ids.orgId, createdAt: new Date() },
  });
  await system.member.create({
    data: {
      id: `${ids.orgId}-m`,
      organizationId: ids.orgId,
      userId: ids.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  for (const [index, spaceId] of [ids.space1, ids.space2].entries()) {
    await system.space.create({
      data: {
        id: spaceId,
        organizationId: ids.orgId,
        name: `Surrogate Space ${index + 1}`,
        isDefault: index === 0,
      },
    });
    await system.spaceMember.create({
      data: {
        id: `${spaceId}-m`,
        spaceId,
        organizationId: ids.orgId,
        userId: ids.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  await system.session.create({
    data: {
      id: `${ids.userId}-session`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      token: ids.token,
      userId: ids.userId,
    },
  });
  await system.page.create({
    data: {
      id: ids.pageId,
      spaceId: ids.space1,
      userId: ids.userId,
      title: "Surrogate page",
    },
  });
  await system.bot.create({
    data: {
      id: ids.botId,
      spaceId: ids.space1,
      userId: ids.userId,
      name: "Surrogate Bot",
      color: "#123456",
    },
  });
  await system.externalConversation.create({
    data: {
      id: ids.externalId,
      provider: "slack",
      workspaceId: `sd-w-${suffix}`,
      externalKey: `sd-x-${suffix}`,
      conversationId: `sd-c-${suffix}`,
      spaceId: ids.space1,
      botId: ids.botId,
      userId: ids.userId,
    },
  });
  await system.deploymentSettings.deleteMany({ where: { id: "default" } });
}

function headers(space: string): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: WEB_ORIGIN,
    cookie,
    "x-rakazo-space-id": space,
    "user-agent": "infra-d-surrogate/1",
  };
}

async function call(url: string, procedure: string, input: unknown, space: string) {
  const response = await fetch(`${url}/rpc/${procedure.replaceAll(".", "/")}`, {
    method: "POST",
    headers: headers(space),
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

await seed();
go = spawn(
  gateway,
  [
    "-listen",
    `127.0.0.1:${GO_PORT}`,
    "-upstream",
    `http://127.0.0.1:${UPSTREAM_PORT}`,
    "-routes",
    routesFile,
  ],
  {
    env: {
      ...process.env,
      DATABASE_URL,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: WEB_ORIGIN,
      WEB_ORIGIN,
      ENCRYPTION_KEY: CONTRACT_ENCRYPTION_KEY,
      CONTENT_ENCRYPTION: "off",
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(`${GO_URL}/healthz`)).ok) break;
  } catch {
    // still starting
  }
  if (attempt === 99) throw new Error("gateway did not start");
  await sleep(50);
}

const cases: Record<string, unknown>[] = [];
let failures = 0;
async function errorEcho(procedure: string, input: unknown, space: string, label: string) {
  const goResult = await call(GO_URL, procedure, input, space);
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: headers(space), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  const tsResult = { status: response.status, text, body: text ? JSON.parse(text) : null };
  const equal =
    tsResult.status === goResult.status &&
    isDeepStrictEqual(tsResult.body, goResult.body);
  if (!equal) {
    failures += 1;
    console.log(`FAIL  ${procedure} ${label}: ${tsResult.status}/${goResult.status}`);
    console.log("  ts:", tsResult.text, "\n  go:", goResult.text);
  } else {
    console.log(`ok    ${procedure} ${label}: ${tsResult.status}`);
  }
  cases.push({
    procedure,
    kind: label,
    input: JSON.parse(
      JSON.stringify(input)
        .replaceAll(ids.space2, "__space2__")
        .replaceAll(ids.orgId, "__org__")
        .replaceAll(ids.pageId, "__page__")
        .replaceAll(ids.botId, "__bot__")
        .replaceAll(ids.externalId, "__external__"),
    ),
    typescript: tsResult.body,
    go: goResult.body,
    equal,
    excluded: false,
  });
  return equal;
}

async function echoPolicy(space: string, label: string) {
  const input = {
    externalConversationId: ids.externalId,
    teamChatAmbientEnabled: null,
    teamChatRules: "rule\ud800text",
    automatedSenderPolicies: {
      "sender\ud800": { name: "name\ud800", mode: "ignore" },
    },
  };
  const goResult = await call(GO_URL, "externalConversations.updatePolicy", input, space);
  const response = await handles.app.request(
    "/rpc/externalConversations/updatePolicy",
    { method: "POST", headers: headers(space), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  const tsResult = { status: response.status, text, body: text ? JSON.parse(text) : null };
  const equal =
    tsResult.status === goResult.status &&
    isDeepStrictEqual(tsResult.body, goResult.body);
  if (!equal) {
    failures += 1;
    console.log(`FAIL  externalConversations.updatePolicy ${label}: ${tsResult.status}/${goResult.status}`);
    console.log("  ts:", tsResult.text, "\n  go:", goResult.text);
  } else {
    console.log(`ok    externalConversations.updatePolicy ${label}: ${tsResult.status}`);
  }
  cases.push({
    procedure: "externalConversations.updatePolicy",
    kind: label,
    input: JSON.parse(
      JSON.stringify(input)
        .replaceAll(ids.space2, "__space2__")
        .replaceAll(ids.orgId, "__org__")
        .replaceAll(ids.pageId, "__page__")
        .replaceAll(ids.botId, "__bot__")
        .replaceAll(ids.externalId, "__external__"),
    ),
    typescript: tsResult.body,
    go: goResult.body,
    equal,
    excluded: false,
  });
  return equal;
}

async function exactEcho(
  procedure: string,
  input: unknown,
  space: string,
  field: string,
  label: string,
) {
  const goResult = await call(GO_URL, procedure, input, space);
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: headers(space), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  const tsResult = { status: response.status, body: text ? JSON.parse(text) : null };
  const tsValue = tsResult.body?.json?.[field];
  const goValue = goResult.body?.json?.[field];
  const equal =
    tsResult.status === goResult.status && tsValue === goValue && tsValue === (input as any)[field];
  if (!equal) {
    failures += 1;
    console.log(`FAIL  ${procedure} ${label}: ${tsResult.status}/${goResult.status}`);
    console.log("  ts:", JSON.stringify(tsValue), "\n  go:", JSON.stringify(goValue));
  } else {
    console.log(`ok    ${procedure} ${label}: literal code units echoed`);
  }
  cases.push({
    procedure,
    kind: label,
    input,
    field,
    typescript: tsValue ?? null,
    go: goValue ?? null,
    equal,
    excluded: false,
  });
  return equal;
}

async function rawError(procedure: string, body: string, space: string, label: string) {
  const goResponse = await fetch(`${GO_URL}/rpc/${procedure.replaceAll(".", "/")}`, {
    method: "POST",
    headers: headers(space),
    body,
  });
  const goText = await goResponse.text();
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: headers(space), body },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  const parse = (value: string) => (value ? JSON.parse(value) : null);
  const equal = response.status === goResponse.status && isDeepStrictEqual(parse(text), parse(goText));
  if (!equal) {
    failures += 1;
    console.log(`FAIL  ${procedure} ${label}: ${response.status}/${goResponse.status}`);
    console.log("  ts:", text, "\n  go:", goText);
  } else {
    console.log(`ok    ${procedure} ${label}: ${response.status}`);
  }
  cases.push({
    procedure,
    kind: label,
    input: "<raw body>",
    typescript: parse(text),
    go: parse(goText),
    equal,
    excluded: false,
  });
  return equal;
}

async function policyStorage(space: string, label: string) {
  const input = {
    externalConversationId: ids.externalId,
    teamChatAmbientEnabled: true,
    teamChatRules: "stored\ud800rule",
    automatedSenderPolicies: {
      "sender\ud800": { name: "name\ud800", mode: "ignore" },
      "sender\uFFFD": { name: "second", mode: "user" },
      "nul\u0000key": { name: "third", mode: "ignore" },
    },
  };
  const response = await handles.app.request(
    "/rpc/externalConversations/updatePolicy",
    { method: "POST", headers: headers(space), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const tsText = await response.text();
  const tsRow = await system.externalConversation.findUnique({
    where: { id: ids.externalId },
    select: { automatedSenderPolicies: true, teamChatRules: true },
  });
  const goResult = await call(GO_URL, "externalConversations.updatePolicy", input, space);
  const goRow = await system.externalConversation.findUnique({
    where: { id: ids.externalId },
    select: { automatedSenderPolicies: true, teamChatRules: true },
  });
  const equal = response.status === goResult.status && isDeepStrictEqual(tsRow, goRow);
  if (!equal) {
    failures += 1;
    console.log(`FAIL  externalConversations.updatePolicy ${label}: ${response.status}/${goResult.status}`);
    console.log("  ts row:", JSON.stringify(tsRow), "\n  go row:", JSON.stringify(goRow));
  } else {
    console.log(`ok    externalConversations.updatePolicy ${label}: stored leaves match (${response.status})`);
  }
  cases.push({
    procedure: "externalConversations.updatePolicy",
    kind: label,
    input: JSON.parse(JSON.stringify(input)),
    typescript: tsRow,
    go: goRow,
    equal,
    excluded: false,
  });
  void tsText;
  return equal;
}

async function liveRename(
  procedure: string,
  input: unknown,
  space: string,
  field: string,
  rawEcho = true,
) {
  const goResult = await call(GO_URL, procedure, input, space);
  const response = await handles.app.request(
    `/rpc/${procedure.replaceAll(".", "/")}`,
    { method: "POST", headers: headers(space), body: JSON.stringify({ json: input }) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  const text = await response.text();
  const tsResult = { status: response.status, text, body: text ? JSON.parse(text) : null };
  const value = (result: any) => result?.body?.json?.[field];
  const marker = rawEcho ? "\ud800" : "\uFFFD";
  const exact =
    typeof value(tsResult) === "string" &&
    value(tsResult).includes(marker) &&
    (rawEcho || !value(tsResult).includes("\ud800"));
  // DB-backed writes return their own now(), so only the ISO timestamps may differ.
  const normalized = (text: string) => text.replace(/"\d{4}-\d\d-\d\dT[^"]+Z"/g, '"<time>"');
  const equal =
    tsResult.status === goResult.status &&
    normalized(tsResult.text) === normalized(goResult.text) &&
    value(tsResult) === value(goResult);
  if (!equal || !exact) {
    failures += 1;
    console.error(`FAIL ${procedure}`, { tsResult, goResult });
  } else {
    console.log(
      `ok   ${procedure}: both ${rawEcho ? "echo" : "store"} ${rawEcho ? "\\ud800" : "U+FFFD"} (${tsResult.status})`,
    );
  }
  cases.push({
    procedure,
    input: JSON.parse(
      JSON.stringify(input)
        .replaceAll(ids.space2, "__space2__")
        .replaceAll(ids.orgId, "__org__")
        .replaceAll(ids.pageId, "__page__")
        .replaceAll(ids.botId, "__bot__")
        .replaceAll(ids.externalId, "__external__"),
    ),
    field,
    typescript: value(tsResult) ?? null,
    go: value(goResult) ?? null,
    expected: rawEcho ? "\\ud800" : "\\uFFFD",
    equal,
    excluded: false,
  });
}

try {
  await liveRename("spaces.rename", { spaceId: ids.space2, name: "x\ud800y" }, ids.space1, "name");
  await liveRename(
    "organizations.rename",
    { organizationId: ids.orgId, name: "org\ud800name" },
    ids.space1,
    "name",
  );
  await liveRename(
    "pages.rename",
    { pageId: ids.pageId, title: "page\ud800title" },
    ids.space1,
    "title",
    false,
  );
  await errorEcho(
    "pages.rename",
    { pageId: ids.pageId, title: "ok", ["bad\ud800"]: 1 },
    ids.space1,
    "unrecognized-key",
  );
  await errorEcho(
    "pages.list",
    { ["bad\ud800"]: 1 },
    ids.space1,
    "unrecognized-key",
  );
  await errorEcho(
    "pages.pin",
    { pageId: ids.pageId, pinned: true, ["bad\ud800"]: 1 },
    ids.space1,
    "unrecognized-key",
  );
  await errorEcho(
    "pages.remove",
    { pageId: ids.pageId, ["bad\ud800"]: 1 },
    ids.space1,
    "unrecognized-key",
  );
  await errorEcho(
    "spendingLimit.set",
    { limit: null, ["bad\ud800"]: 1 },
    ids.space1,
    "unrecognized-key",
  );
  await errorEcho(
    "spendingLimit.set",
    { limit: { amount: 500, currency: "usd", period: "week", ["bad\ud800"]: 1 } },
    ids.space1,
    "unrecognized-nested-key",
  );
  await echoPolicy(ids.space1, "saved-policy-echo");
  await policyStorage(ids.space1, "reviewer-policy-keys-store");
  await rawError(
    "externalConversations.updatePolicy",
    JSON.stringify({
      json: {
        externalConversationId: ids.externalId + "\u0000",
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
      },
    }),
    ids.space1,
    "reviewer-id-nul",
  );
  await exactEcho(
    "spaces.rename",
    { spaceId: ids.space2, name: "m\uFC00\uFC01\uE000\uE7FF\uE800\uF8FFz" },
    ids.space1,
    "name",
    "literal-marker-code-units",
  );
  await rawError(
    "spaces.rename",
    `{"json":{"spaceId":${JSON.stringify(ids.space2)},"name":"a\u0001b"}}`,
    ids.space1,
    "raw-control-byte",
  );

  // Excluded: computerProvider.update/get is TypeScript-only and echoes the raw
  // code unit; Go's decoder turns the same body into U+FFFD.
  const secrets = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
  const apiUrl = "https://example.com/\ud800";
  const deps = {
    prisma: handles.prisma,
    secrets,
    jobs: {},
    sandbox: { refresh: async () => undefined },
    env: {
      sandboxProvider: "boat",
      adminEmails: [`${ids.userId}@example.test`.toLowerCase()],
      computerSettingsEnabled: true,
    },
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    verifyConnection: async () => undefined,
  };
  const actor = {
    userId: ids.userId,
    spaceId: ids.space1,
    email: `${ids.userId}@example.test`,
    isDeploymentOwner: true,
  };
  const updated = await updateComputerProviderSettings(deps as never, actor as never, {
    provider: "boat",
    values: { apiKey: "wire-key", apiUrl },
  } as never);
  const got = await getComputerProviderSettings(deps as never, actor as never);
  const tsEcho = updated.values.apiUrl;
  const tsGetEcho = got.values.apiUrl;
  if (tsEcho !== apiUrl || tsGetEcho !== apiUrl) {
    throw new Error(`TS did not echo the raw surrogate: ${JSON.stringify({ tsEcho, tsGetEcho })}`);
  }
  // The same JSON string through the Go boundary decoder: the procedure is
  // TypeScript-only, so this pins the code unit the gateway's decoder keeps.
  const wtf8proof = join(dataDir, "wtf8proof");
  const corpus = join(dataDir, "surrogate-corpus.jsonl");
  const actual = join(dataDir, "surrogate-actual.jsonl");
  const buildProof = spawnSync("go", ["build", "-o", wtf8proof, "./cmd/wtf8proof"], {
    cwd: GO_DIR,
    encoding: "utf8",
    env: process.env,
  });
  if (buildProof.status !== 0) throw new Error(`wtf8proof build failed: ${buildProof.stderr}`);
  await writeFile(corpus, `${JSON.stringify({ id: "computerProvider", value: apiUrl })}\n`);
  const runProof = spawnSync(wtf8proof, ["-corpus", corpus, "-out", actual], { encoding: "utf8" });
  if (runProof.status !== 0) throw new Error(`wtf8proof failed: ${runProof.stderr}`);
  const answer = JSON.parse((await readFile(actual, "utf8")).trim()) as {
    ok: boolean;
    text: string;
  };
  const goDecoded = answer.ok ? JSON.parse(answer.text) : undefined;
  const equal = answer.ok && isDeepStrictEqual(goDecoded, apiUrl);
  if (!equal) {
    failures += 1;
    console.error("FAIL computerProvider decode", { apiUrl, goDecoded });
  } else {
    console.log("ok   computerProvider decode: TS and the Go boundary keep the code unit");
  }
  cases.push({
    procedure: "computerProvider.update/get",
    input: { provider: "boat", values: { apiUrl } },
    field: "values.apiUrl",
    typescript: tsEcho,
    typescriptGet: tsGetEcho,
    goDecoded,
    equal,
    excluded: false,
  });
} finally {
  await system.deploymentSettings.deleteMany({ where: { id: "default" } });
  await system.session.deleteMany({ where: { id: `${ids.userId}-session` } });
  await system.page.deleteMany({ where: { id: ids.pageId } });
  await system.externalConversation.deleteMany({ where: { id: ids.externalId } });
  await system.bot.deleteMany({ where: { id: ids.botId } });
  await system.spaceMember.deleteMany({ where: { spaceId: { in: [ids.space1, ids.space2] } } });
  await system.space.deleteMany({ where: { id: { in: [ids.space1, ids.space2] } } });
  await system.organization.deleteMany({ where: { id: ids.orgId } });
  await system.user.deleteMany({ where: { id: ids.userId } });
  await writeFile(
    join(HERE, "infra-d-surrogate-cases.json"),
    `${JSON.stringify({ note: "Generated by infra-d-surrogate-wire.mts", cases }, null, 2)}\n`,
  );
  go?.kill("SIGTERM");
  upstream.close();
  await handles.stop();
  await rm(dataDir, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
const excludedCount = cases.filter((entry) => entry.excluded === true).length;
console.log(`surrogate wire: ${cases.length} cases (${excludedCount} excluded)`);
