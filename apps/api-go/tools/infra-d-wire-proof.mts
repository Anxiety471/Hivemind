/**
 * Proves zod's `.url()` stored value across the real stack for a JSON input
 * carrying an unpaired surrogate: JSON.parse -> mcp.servers.create handler ->
 * McpRemoteEndpointSchema -> Prisma text sanitizer -> Postgres -> DTO/row.
 *
 * It drives the real router client and handler (`apps/api/src/router.ts`,
 * `routes/mcp.ts`), the real createDb client, the real schema and the real
 * mcp_servers table. The comparison is against the Go driver's ZodURLValue for
 * the same JSON line, closing Go <-> TS zod <-> Prisma -> Postgres.
 *
 * Requires the disposable fixture database (go-port/fixture-db):
 *
 *   set -a; . /home/hitori/go-port/fixture-db/.env.infra-d; set +a
 *   CONTENT_ENCRYPTION=off NODE_ENV=test ENCRYPTION_KEY=<test-key> \
 *     node_modules/.bin/tsx apps/api-go/tools/infra-d-wire-proof.mts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouterClient } from "../../../apps/api/node_modules/@orpc/server/dist/index.mjs";
import { McpRemoteEndpointSchema } from "../../../packages/contracts/src/integrations/mcp.js";
import { sanitizeUtf16ForJson } from "../../../packages/core/src/messages/events.js";
import { createDb, runAsSystem, runAsTenant } from "../../../packages/db/src/index.js";
import { createRouter } from "../../../apps/api/src/router.js";

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
const suffix = `${Date.now()}-${process.pid}`;
const userId = `infra-d-wire-user-${suffix}`;
const organizationId = `infra-d-wire-org-${suffix}`;
const spaceId = `infra-d-wire-space-${suffix}`;
const actor = { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false };

let failed = false;
const client = createRouterClient(
  createRouter({
    prisma: db.prisma,
    // A streamable HTTP endpoint with no headers, env, files or OAuth client
    // needs no secret store; the real store is irrelevant to this path.
    secrets: { put: async () => { throw new Error("unexpected secret write"); } },
    remoteConnectors: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    },
    events: { notify: () => undefined },
    env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
    dataDir: "/tmp/infra-d-wire-proof",
  }) as never,
  { context: { actor } },
);

let serverId = "";
try {
  await runAsSystem("infra-d wire fixture", async () => {
    await db.prisma.user.create({
      data: { id: userId, name: "infra-d wire", email: `${userId}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id: organizationId, name: "infra-d wire", slug: organizationId, createdAt: new Date() },
    });
    await db.prisma.space.create({
      data: { id: spaceId, organizationId, name: "infra-d wire", createdByUserId: userId },
    });
  });

  // The real procedure: authed context, McpServerConfigInput, transaction,
  // mcp_servers insert, then its DTO.
  const created = await runAsTenant(actor, () =>
    client.mcp.servers.create({
      transport: "streamable_http",
      slug: "wire",
      name: "wire",
      endpoint: wire.endpoint,
      headers: {},
      enabled: true,
    }),
  );
  serverId = created.id;
  if (created.endpoint !== expectedStored) {
    failed = true;
    console.error(
      `DTO endpoint ${JSON.stringify(created.endpoint)} != sanitized zod ${JSON.stringify(expectedStored)}`,
    );
  }

  const row = await runAsSystem("infra-d wire read", () =>
    db.prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } }),
  );
  if (row.endpoint !== expectedStored) {
    failed = true;
    console.error(
      `DB endpoint ${JSON.stringify(row.endpoint)} != sanitized zod ${JSON.stringify(expectedStored)}`,
    );
  } else {
    console.log(`DB stored ${JSON.stringify(row.endpoint)} (U+FFFD) through mcp.servers.create`);
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
  await runAsSystem("infra-d wire cleanup", async () => {
    if (serverId) await db.prisma.mcpServer.deleteMany({ where: { id: serverId } });
    await db.prisma.space.deleteMany({ where: { id: spaceId } });
    await db.prisma.organization.deleteMany({ where: { id: organizationId } });
    await db.prisma.user.deleteMany({ where: { id: userId } });
  });
  await db.pool.end();
}

if (failed) process.exit(1);
console.log("wire proof: ok");
