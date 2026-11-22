/**
 * URL slice cases: marketplace.submissions, integrationSetup.get and pages.setVisibility.
 *
 * Plugin submission rows are global; their ids start with the case user's id so `reset` can
 * remove them. A page share token is random on each side, so the contract normalizer compares
 * only the URL's `/p/...` prefix and the stored hash's shape.
 */
import { createSecretStore } from "../../../packages/adapters/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, minute));

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
  const token = "A".repeat(43);
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
}

export function url1Cases(system: System): Case[] {
  const cases: Case[] = [
    {
      name: "url1-integration-setup",
      procedure: "integrationSetup.get",
      input: {},
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
        await addSubmission(system, seeded, "approved", {
          status: "approved",
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
    },
    {
      name: "url1-submissions-invalid-status",
      procedure: "marketplace.submissions",
      input: { status: "pending-ish" },
      admin: true,
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
    },
    {
      name: "url1-submissions-forbidden",
      procedure: "marketplace.submissions",
      input: {},
    },
    {
      name: "url1-visibility-private",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-private", visibility: "private" },
      seed: async (seeded) => {
        await addPage(system, seeded, "private", { title: "Private page", visibility: "private" });
      },
    },
    {
      name: "url1-visibility-link",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-link", visibility: "link" },
      seed: async (seeded) => {
        await addPage(system, seeded, "link", { title: "Link page", visibility: "private" });
      },
    },
    {
      name: "url1-visibility-existing-link",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-existing", visibility: "link" },
      seed: async (seeded) => {
        await addReadableShare(system, seeded, "existing");
      },
    },
    {
      name: "url1-visibility-turn-off",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-off", visibility: "private" },
      seed: async (seeded) => {
        await addUnreadableShare(system, seeded, "off");
      },
    },
    {
      name: "url1-visibility-replace-unreadable",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-bad", visibility: "link" },
      seed: async (seeded) => {
        await addUnreadableShare(system, seeded, "bad");
      },
    },
    {
      name: "url1-visibility-missing",
      procedure: "pages.setVisibility",
      input: { pageId: "missing", visibility: "link" },
    },
    {
      name: "url1-visibility-invalid",
      procedure: "pages.setVisibility",
      input: { pageId: "__user__-urlpage-private", visibility: "public" },
      seed: async (seeded) => {
        await addPage(system, seeded, "private", { title: "Private page", visibility: "private" });
      },
    },
  ];
  return cases;
}
