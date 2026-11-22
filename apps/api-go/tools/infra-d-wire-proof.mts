/**
 * Proves the zod `.url()` stored value across the real wire, schema, Prisma
 * client and Postgres, for a JSON input carrying an unpaired surrogate.
 *
 *   source .env (DATABASE_URL, DATABASE_MIGRATION_URL)
 *   CONTENT_ENCRYPTION=off ENCRYPTION_KEY=<test> NODE_ENV=test \
 *     node_modules/.bin/tsx apps/api-go/tools/infra-d-wire-proof.mts
 *
 * It uses the exact McpRemoteEndpointSchema that mcp.servers.create validates,
 * the real createDb client (with the text-sanitizing extension), and the real
 * mcp_servers table. The comparison is against the Go driver's ZodURLValue for
 * the same JSON line, so it closes the loop Go <-> zod <-> Prisma -> Postgres.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpRemoteEndpointSchema } from "../../../packages/contracts/src/integrations/mcp.js";
import { sanitizeUtf16ForJson } from "../../../packages/core/src/messages/events.js";
import { asSystem, createDb } from "../../../packages/db/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required (fixture database)");

// Exactly what the HTTP body carries: a JSON string with a \ud800 escape.
const wireText = String.raw`{"endpoint":"https://example.com/\ud800"}`;
const wire = JSON.parse(wireText) as { endpoint: string };

const parsed = McpRemoteEndpointSchema.safeParse(wire.endpoint);
if (!parsed.success) throw new Error(`McpRemoteEndpointSchema rejected the endpoint: ${parsed.error}`);
const zodValue = parsed.data;
if (zodValue !== wire.endpoint) throw new Error("trim changed the URL; the case is not focused");
if (!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(zodValue)) {
  throw new Error("JSON.parse lost the lone surrogate; the case is not testing it");
}

const expectedStored = sanitizeUtf16ForJson(zodValue);
if (expectedStored === zodValue) throw new Error("the write sanitizer did not change the value");
if (!expectedStored.endsWith("\uFFFD")) throw new Error("the stored value is not U+FFFD-terminated");

const db = createDb(databaseUrl, { encryptContent: false });
const prisma = asSystem(db.prisma, "infra-d URL wire proof");
const suffix = `${Date.now()}-${process.pid}`;
const userId = `infra-d-wire-user-${suffix}`;
const organizationId = `infra-d-wire-org-${suffix}`;
const spaceId = `infra-d-wire-space-${suffix}`;
const serverId = `infra-d-wire-server-${suffix}`;

let failed = false;
try {
  await prisma.user.create({ data: { id: userId, name: "infra-d wire", email: `${userId}@example.test` } });
  await prisma.organization.create({
    data: { id: organizationId, name: "infra-d wire", slug: organizationId, createdAt: new Date() },
  });
  await prisma.space.create({
    data: { id: spaceId, organizationId, name: "infra-d wire", createdByUserId: userId },
  });
  await prisma.mcpServer.create({
    data: {
      id: serverId,
      spaceId,
      userId,
      slug: "wire",
      name: "wire",
      transport: "http",
      endpoint: zodValue,
    },
  });
  const row = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
  if (row.endpoint !== expectedStored) {
    failed = true;
    console.error(
      `DB endpoint ${JSON.stringify(row.endpoint)} != sanitized zod ${JSON.stringify(expectedStored)}`,
    );
  } else {
    console.log(`DB stored ${JSON.stringify(row.endpoint)} (U+FFFD), as sanitizeUtf16ForJson predicts`);
  }

  // The same JSON line through the Go driver: Go's decoder turns the lone
  // surrogate into U+FFFD, and ZodURLValue returns that form.
  const work = mkdtempSync(join(tmpdir(), "infra-d-wire-"));
  const corpus = join(work, "corpus.jsonl");
  const actual = join(work, "actual.jsonl");
  const binary = join(work, "urlproof");
  writeFileSync(
    corpus,
    `${JSON.stringify({ id: "wire", op: "parse", input: wire.endpoint })}\n`,
  );
  const build = spawnSync("go", ["build", "-o", binary, "./cmd/urlproof"], {
    cwd: GO_DIR,
    encoding: "utf8",
    env: process.env,
  });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const run = spawnSync(binary, ["-corpus", corpus, "-out", actual], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`urlproof failed: ${run.stderr}`);
  const go = JSON.parse(readFileSync(actual, "utf8")) as { zvalue: string };
  if (go.zvalue !== row.endpoint) {
    failed = true;
    console.error(`Go zvalue ${JSON.stringify(go.zvalue)} != DB endpoint ${JSON.stringify(row.endpoint)}`);
  } else {
    console.log("Go ZodURLValue equals the Postgres value end to end");
  }
} finally {
  await prisma.mcpServer.deleteMany({ where: { id: serverId } }).catch(() => undefined);
  await prisma.space.deleteMany({ where: { id: spaceId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: organizationId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  await db.pool.end();
}

if (failed) process.exit(1);
console.log("wire proof: ok");
