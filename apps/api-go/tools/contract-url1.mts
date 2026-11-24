/**
 * URL slice cases: marketplace.submissions, integrationSetup.get and pages.setVisibility.
 *
 * Plugin submission rows are global; their ids start with the case user's id so `reset` can
 * remove them. A page share token is random on each side, so the response comparison normalizes
 * the URL shape, while the per-side checks hash the returned token and compare it with the stored
 * shareTokenHash, require the sealed ciphertext to stay out of the response and gateway log, and
 * compare the audit/security event counts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSecretStore } from "../../../packages/adapters/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;
type CheckContext = Parameters<NonNullable<Case["check"]>>[0];

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, minute));
const READABLE_SHARE_TOKEN = "A".repeat(43);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const eventEvidence = new Map<string, { security: unknown[]; audit: unknown[] }>();
const byJson = (left: unknown, right: unknown) =>
  JSON.stringify(left) < JSON.stringify(right) ? -1 : 1;

async function eventRows(system: System, seeded: Seeded) {
  const security = await system.securityEvent.findMany({
    where: { userId: { in: [seeded.userId, `${seeded.userId}-other`] } },
  });
  const audit = await system.auditEvent.findMany({
    where: { OR: [{ organizationId: seeded.orgId }, { actorId: seeded.userId }] },
  });
  return { security: security.sort(byJson), audit: audit.sort(byJson) };
}

/**
 * The contract's databaseState already compares security and audit rows. This explicit snapshot makes
 * the same assertion on each URL case before the next seed deletes them, and it also gives the page
 * checks a place to store the TypeScript side's evidence for comparison with the Go side.
 */
function withEvents(
  system: System,
  name: string,
  check?: (context: CheckContext) => void | Promise<void>,
): NonNullable<Case["check"]> {
  return async (context) => {
    const rows = await eventRows(system, context.seeded);
    if (context.side === "ts") {
      eventEvidence.set(name, rows);
    } else {
      assert.deepEqual(rows, eventEvidence.get(name), `${name}: audit/security event rows`);
    }
    if (check) await check(context);
  };
}

function payloads(result: CheckContext["result"]): any[] {
  const json = result.body?.json;
  if (
    Array.isArray(json) &&
    json.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Object.hasOwn(entry, "status") &&
        Object.hasOwn(entry, "json"),
    )
  ) {
    return json.map((entry) => entry.json);
  }
  return [json];
}

function shareURLs(result: CheckContext["result"]): string[] {
  return payloads(result).flatMap((payload) =>
    typeof payload?.shareUrl === "string" ? [payload.shareUrl] : [],
  );
}

function shareToken(url: string, name: string): string {
  const token = /[A-Za-z0-9_-]{43}$/.exec(url)?.[0];
  assert.ok(token, `${name}: share URL does not end in a token: ${url}`);
  return token;
}

async function pageEvidence(system: System, seeded: Seeded, pageKey: string) {
  const id = `${seeded.userId}-urlpage-${pageKey}`;
  const page = await system.page.findUnique({
    where: { id },
    select: { visibility: true, shareTokenHash: true, shareSecretId: true },
  });
  assert.ok(page, `page ${id} is missing`);
  return { page, id };
}

function pageCheck(
  system: System,
  name: string,
  pageKey: string,
  expected: { link: boolean; status?: number; concurrent?: number; token?: string },
): NonNullable<Case["check"]> {
  return withEvents(system, name, async ({ seeded, result, gatewayLog }) => {
    if (expected.status !== undefined)
      assert.equal(result.status, expected.status, `${name}: status`);
    if (expected.concurrent !== undefined) {
      const combined = result.body?.json;
      assert.ok(Array.isArray(combined), `${name}: concurrent responses are not a list`);
      assert.equal(combined.length, expected.concurrent, `${name}: concurrent response count`);
      assert.ok(
        combined.every((entry) => entry?.status === 200),
        `${name}: a concurrent call did not succeed`,
      );
    }
    const { page } = await pageEvidence(system, seeded, pageKey);
    const urls = shareURLs(result);
    const body = JSON.stringify(result.body);
    const shareSecrets = await system.secret.count({
      where: { userId: seeded.userId, kind: "page_share" },
    });
    assert.equal(shareSecrets, expected.link ? 1 : 0, `${name}: persisted page_share secret rows`);
    let ciphertext: string | null = null;
    if (page.shareSecretId) {
      const secret = await system.secret.findUnique({
        where: { id: page.shareSecretId },
        select: { ciphertext: true },
      });
      ciphertext = secret?.ciphertext ?? null;
      if (ciphertext) {
        assert.ok(!body.includes(ciphertext), `${name}: response disclosed the share ciphertext`);
        assert.ok(
          !gatewayLog.includes(ciphertext),
          `${name}: gateway log disclosed the ciphertext`,
        );
      }
    }
    if (expected.link) {
      assert.ok(urls.length > 0, `${name}: no share URL in the response`);
      if (expected.concurrent !== undefined)
        assert.equal(urls.length, expected.concurrent, `${name}: concurrent share URLs`);
      assert.equal(page.visibility, "link", `${name}: page visibility`);
      assert.ok(page.shareSecretId, `${name}: page has no share secret`);
      assert.ok(page.shareTokenHash, `${name}: page has no shareTokenHash`);
      if (expected.token) {
        assert.equal(urls.length, 1, `${name}: existing link returned more than one URL`);
        assert.equal(
          shareToken(urls[0]!, name),
          expected.token,
          `${name}: existing link token changed`,
        );
        assert.equal(
          page.shareTokenHash,
          tokenHash(expected.token),
          `${name}: stored shareTokenHash != seeded hash`,
        );
      }
      for (const url of urls) {
        const token = shareToken(url, name);
        assert.equal(
          tokenHash(token),
          page.shareTokenHash,
          `${name}: SHA-256(returned token) != stored shareTokenHash`,
        );
        assert.ok(!gatewayLog.includes(token), `${name}: gateway log disclosed the share token`);
      }
    } else {
      assert.equal(urls.length, 0, `${name}: response unexpectedly contains a share URL`);
      assert.equal(page.visibility, "private", `${name}: page visibility`);
      assert.equal(page.shareSecretId, null, `${name}: page still has a share secret`);
      assert.equal(page.shareTokenHash, null, `${name}: page still has a shareTokenHash`);
    }
  });
}

function submissionCheck(
  system: System,
  name: string,
  status: number,
  expected: (payload: any[]) => void,
): NonNullable<Case["check"]> {
  return withEvents(system, name, async ({ result }) => {
    assert.equal(result.status, status, `${name}: status`);
    const [payload] = payloads(result);
    assert.ok(Array.isArray(payload), `${name}: submissions response is not a list`);
    expected(payload);
  });
}

function statusOnly(system: System, name: string, status: number): NonNullable<Case["check"]> {
  return withEvents(system, name, ({ result }) => {
    assert.equal(result.status, status, `${name}: status`);
  });
}

function addSubmission(
  system: System,
  seeded: Seeded,
  key: string,
  data: {
    status: string;
    source?: string | null;
    website?: string | null;
    logo?: string | null;
    claim?: string | null;
    testing?: string | null;
    reason?: string | null;
    description?: string;
    createdAt?: Date;
    reviewedAt?: Date | null;
  },
) {
  return system.pluginSubmission.create({
    data: {
      id: `${seeded.userId}-urlps-${key}`,
      email: `${seeded.userId}-${key}@example.test`,
      name: key,
      website: data.website ?? null,
      logo: data.logo ?? null,
      claim: data.claim ?? null,
      source: data.source ?? null,
      description: data.description ?? `description ${key}`,
      testing: data.testing ?? null,
      status: data.status,
      reason: data.reason ?? null,
      createdAt: data.createdAt ?? at(0),
      reviewedAt: data.reviewedAt ?? null,
    },
  });
}

async function addPage(
  system: System,
  seeded: Seeded,
  key: string,
  options: { title: string; visibility: string; secretID?: string },
) {
  await system.page.create({
    data: {
      id: `${seeded.userId}-urlpage-${key}`,
      spaceId: seeded.spaces[0],
      userId: seeded.userId,
      title: options.title,
      visibility: options.visibility,
      ...(options.secretID ? { shareSecretId: options.secretID } : {}),
    },
  });
}

async function addUnreadableShare(system: System, seeded: Seeded, pageKey: string) {
  const secretID = `${seeded.userId}-urlpage-bad-${pageKey}`;
  await system.secret.create({
    data: {
      id: secretID,
      userId: seeded.userId,
      spaceId: seeded.spaces[0],
      kind: "page_share",
      ciphertext: "not-a-vault-value",
    },
  });
  await addPage(system, seeded, pageKey, {
    title: `Bad link ${pageKey}`,
    visibility: "link",
    secretID,
  });
}

async function addReadableShare(system: System, seeded: Seeded, pageKey: string) {
  const token = READABLE_SHARE_TOKEN;
  const store = createSecretStore(CONTRACT_ENCRYPTION_KEY, process.env);
  const record = await store.put(token, { signal: new AbortController().signal });
  await system.secret.create({
    data: {
      id: record.id,
      userId: seeded.userId,
      spaceId: seeded.spaces[0],
      kind: "page_share",
      ciphertext: record.ciphertext,
    },
  });
  await addPage(system, seeded, pageKey, {
    title: "Existing link",
    visibility: "link",
    secretID: record.id,
  });
  await system.page.update({
    where: { id: `${seeded.userId}-urlpage-${pageKey}` },
    data: { shareTokenHash: tokenHash(token) },
  });
}

export function url1Cases(system: System): Case[] {
  const cases: Case[] = [
    {
      name: "url1-integration-setup",
      procedure: "integrationSetup.get",
      input: {},
      check: statusOnly(system, "url1-integration-setup", 200),
    },
    {
      name: "url1-submissions-default-pending",
      procedure: "marketplace.submissions",
      input: {},
      admin: true,
      seed: async (seeded) => {
        await addSubmission(system, seeded, "pending-late", {
          status: "pending",
          source: "https://github.com/Example/Plugins/tree/main/one",
          createdAt: at(30),
        });
        await addSubmission(system, seeded, "pending-early", {
          status: "pending",
          source: "https://github.com/example/plugins.git@feature/x#sub/dir",
          createdAt: at(10),
        });
        // Pending, not approved, so the default query returns and normalizes the GitLab source too.
        await addSubmission(system, seeded, "gitlab", {
          status: "pending",
          source: "https://gitlab.com/Example/Repo",
          createdAt: at(20),
        });
        await addSubmission(system, seeded, "rejected", {
          status: "rejected",
          source: null,
          claim: "claimed-page",
          createdAt: at(40),
          reason: "not a fit",
          reviewedAt: at(50),
        });
      },
      check: submissionCheck(system, "url1-submissions-default-pending", 200, (payload) => {
        assert.equal(payload.length, 3, "default pending rows");
        assert.ok(
          payload.some(
            (row) => typeof row.source === "string" && row.source.includes("gitlab.com"),
          ),
          "GitLab source is not visible in the pending query",
        );
      }),
    },
    {
      name: "url1-submissions-approved",
      procedure: "marketplace.submissions",
      input: { status: "approved" },
      admin: true,
      seed: async (seeded) => {
        await addSubmission(system, seeded, "pending", {
          status: "pending",
          source: "https://github.com/example/pending",
          createdAt: at(1),
        });
        await addSubmission(system, seeded, "approved-old", {
          status: "approved",
          source: "https://github.com/example/old",
          createdAt: at(2),
        });
        await addSubmission(system, seeded, "approved-new", {
          status: "approved",
          source: "https://github.com/example/new",
          createdAt: at(3),
        });
      },
      check: submissionCheck(system, "url1-submissions-approved", 200, (payload) => {
        assert.equal(payload.length, 2, "approved rows");
        assert.deepEqual(
          payload.map((row) => row.id.slice(-12)),
          ["approved-new", "approved-old"],
          "approved rows are newest first",
        );
      }),
    },
    {
      name: "url1-submissions-invalid-status",
      procedure: "marketplace.submissions",
      input: { status: "pending-ish" },
      admin: true,
      check: statusOnly(system, "url1-submissions-invalid-status", 400),
    },
    {
      name: "url1-submissions-unknown-key-is-stripped",
      procedure: "marketplace.submissions",
      input: { status: "pending", ignored: true },
      admin: true,
      seed: async (seeded) => {
        await addSubmission(system, seeded, "one", {
          status: "pending",
          source: "https://github.com/example/one",
        });
      },
      check: submissionCheck(system, "url1-submissions-unknown-key-is-stripped", 200, (payload) => {
        assert.equal(payload.length, 1, "unknown-key pending rows");
      }),
    },
    {
      name: "url1-submissions-forbidden",
      procedure: "marketplace.submissions",
      input: {},
      check: statusOnly(system, "url1-submissions-forbidden", 403),
    },
    {
      name: "url1-submissions-rejected",
      procedure: "marketplace.submissions",
      input: { status: "rejected" },
      admin: true,
      seed: async (seeded) => {
        await addSubmission(system, seeded, "rejected-old", {
          status: "rejected",
          source: null,
          claim: "old-page",
          createdAt: at(5),
          reason: "old reason",
          reviewedAt: at(6),
        });
        await addSubmission(system, seeded, "rejected-new", {
          status: "rejected",
          source: null,
          claim: "new-page",
          createdAt: at(7),
          reason: "new reason",
          reviewedAt: at(8),
        });
        await addSubmission(system, seeded, "pending", {
          status: "pending",
          source: "https://github.com/example/pending",
          createdAt: at(9),
        });
      },
      check: submissionCheck(system, "url1-submissions-rejected", 200, (payload) => {
        assert.equal(payload.length, 2, "rejected rows");
        assert.deepEqual(
          payload.map((row) => row.id.slice(-12)),
          ["rejected-new", "rejected-old"],
          "rejected rows are newest first",
        );
        assert.ok(payload.every((row) => row.status === "rejected"));
      }),
    },
    {
      name: "url1-submissions-invalid-source",
      procedure: "marketplace.submissions",
      input: {},
      admin: true,
      seed: async (seeded) => {
        await addSubmission(system, seeded, "invalid-source", {
          status: "pending",
          source: "http://github.com/example/insecure",
        });
      },
      check: statusOnly(system, "url1-submissions-invalid-source", 500),
    },
    {
      name: "url1-submissions-cap-200",
      procedure: "marketplace.submissions",
      input: {},
      admin: true,
      seed: async (seeded) => {
        for (let index = 0; index < 205; index += 1) {
          await addSubmission(system, seeded, `cap-${index}`, {
            status: "pending",
            source: `https://github.com/example/cap-${index}`,
            createdAt: at(index),
          });
        }
      },
      check: submissionCheck(system, "url1-submissions-cap-200", 200, (payload) => {
        assert.equal(payload.length, 200, "submissions cap");
        assert.ok(payload[0]!.id.endsWith("-urlps-cap-0"), "oldest pending row");
        assert.ok(payload[199]!.id.endsWith("-urlps-cap-199"), "200th pending row");
        assert.ok(
          !payload.some((row) => row.id.endsWith("-urlps-cap-200")),
          "the 201st pending row leaked through the cap",
        );
      }),
    },
    {
      name: "url1-visibility-private",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-private", visibility: "private" },
      seed: async (seeded) => {
        await addPage(system, seeded, "private", { title: "Private page", visibility: "private" });
      },
      check: pageCheck(system, "url1-visibility-private", "private", {
        link: false,
        status: 200,
      }),
    },
    {
      name: "url1-visibility-link",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-link", visibility: "link" },
      seed: async (seeded) => {
        await addPage(system, seeded, "link", { title: "Link page", visibility: "private" });
      },
      check: pageCheck(system, "url1-visibility-link", "link", { link: true, status: 200 }),
    },
    {
      name: "url1-visibility-existing-link",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-existing", visibility: "link" },
      seed: async (seeded) => {
        await addReadableShare(system, seeded, "existing");
      },
      check: pageCheck(system, "url1-visibility-existing-link", "existing", {
        link: true,
        status: 200,
        token: READABLE_SHARE_TOKEN,
      }),
    },
    {
      name: "url1-visibility-turn-off",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-off", visibility: "private" },
      seed: async (seeded) => {
        await addUnreadableShare(system, seeded, "off");
      },
      check: pageCheck(system, "url1-visibility-turn-off", "off", { link: false, status: 200 }),
    },
    {
      name: "url1-visibility-replace-unreadable",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-bad", visibility: "link" },
      seed: async (seeded) => {
        await addUnreadableShare(system, seeded, "bad");
      },
      check: pageCheck(system, "url1-visibility-replace-unreadable", "bad", {
        link: true,
        status: 200,
      }),
    },
    {
      name: "url1-visibility-missing",
      procedure: "pages.setVisibility",
      input: { pageId: "missing", visibility: "link" },
      check: statusOnly(system, "url1-visibility-missing", 404),
    },
    {
      name: "url1-visibility-invalid",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-private", visibility: "public" },
      seed: async (seeded) => {
        await addPage(system, seeded, "private", { title: "Private page", visibility: "private" });
      },
      check: pageCheck(system, "url1-visibility-invalid", "private", {
        link: false,
        status: 400,
      }),
    },
    {
      name: "url1-visibility-unknown-key",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-private", visibility: "private", ignored: true },
      seed: async (seeded) => {
        await addPage(system, seeded, "private", { title: "Private page", visibility: "private" });
      },
      check: pageCheck(system, "url1-visibility-unknown-key", "private", {
        link: false,
        status: 400,
      }),
    },
    {
      name: "url1-visibility-concurrent-link",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-cas-on", visibility: "link" },
      concurrent: 16,
      ignoreSignals: true,
      seed: async (seeded) => {
        await addPage(system, seeded, "cas-on", { title: "CAS on", visibility: "private" });
      },
      check: pageCheck(system, "url1-visibility-concurrent-link", "cas-on", {
        link: true,
        concurrent: 16,
      }),
    },
    {
      name: "url1-visibility-concurrent-off",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-cas-off", visibility: "private" },
      concurrent: 16,
      ignoreSignals: true,
      seed: async (seeded) => {
        await addReadableShare(system, seeded, "cas-off");
      },
      check: pageCheck(system, "url1-visibility-concurrent-off", "cas-off", {
        link: false,
        concurrent: 16,
      }),
    },
  ];
  return cases;
}
