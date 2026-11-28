import { createHmac, timingSafeEqual } from "node:crypto";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { recordTicketIssueState, recordTicketPullRequestState } from "@rakazo/adapters";
import type { CommitCheckState, TicketIssueState, TicketPullRequestState } from "@rakazo/contracts";
import type { CommitCheckReport, PullRequestHeadReport } from "@rakazo/db";
import { recordCommitCheck, recordPullRequestHead } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Hono } from "hono";
import { readBoundedBytes } from "../http/http-body.js";
import { githubEventMetadataPrompt } from "../messaging/inbound-delivery.prompt.js";
import type { WebhookDeps, WebhookSecretCache } from "./webhook-inbound.js";
import {
  deliverWebhookEvent,
  loadWebhookTarget,
  parseWebhookPayload,
  WEBHOOK_MAX_BODY_BYTES,
  webhookDeliveryResponse,
} from "./webhook-inbound.js";

export function hasValidGithubSignature(
  signature: string | undefined,
  secret: string,
  raw: Uint8Array,
): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const GITHUB_EVENT_NAMES = new Set([
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "issue_comment",
  "issues",
  "merge_group",
  "ping",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "release",
  "repository",
  "repository_dispatch",
  "status",
  "workflow_dispatch",
  "workflow_job",
  "workflow_run",
]);

const GITHUB_ACTIONS = new Set([
  "assigned",
  "closed",
  "completed",
  "created",
  "deleted",
  "edited",
  "in_progress",
  "labeled",
  "locked",
  "opened",
  "published",
  "queued",
  "ready_for_review",
  "reopened",
  "requested",
  "review_requested",
  "synchronize",
  "unassigned",
  "unlabeled",
  "unlocked",
  "unpublished",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function githubEventName(header: string | undefined): string {
  const value = header?.trim() ?? "";
  return GITHUB_EVENT_NAMES.has(value) ? value : "event";
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value : undefined;
}

function githubDeliveryMetadata(
  event: string,
  payload: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = { event };
  const repository = record(payload.repository);
  const sender = record(payload.sender);
  const installation = record(payload.installation);
  const organization = record(payload.organization);
  const pullRequest = record(payload.pull_request);
  const issue = record(payload.issue);
  const comment = record(payload.comment);
  const workflowRun = record(payload.workflow_run);
  const release = record(payload.release);

  const fields: Array<[string, unknown]> = [
    ["repositoryId", repository?.id],
    ["senderId", sender?.id],
    ["installationId", installation?.id],
    ["organizationId", organization?.id],
    ["number", payload.number],
    ["pullRequestId", pullRequest?.id],
    ["issueId", issue?.id],
    ["commentId", comment?.id],
    ["workflowRunId", workflowRun?.id],
    ["releaseId", release?.id],
  ];
  for (const [key, value] of fields) {
    const integer = safeInteger(value);
    if (integer !== undefined) metadata[key] = integer;
  }

  if (typeof payload.action === "string" && GITHUB_ACTIONS.has(payload.action)) {
    metadata.action = payload.action;
  }
  for (const [key, value] of [
    ["created", payload.created],
    ["deleted", payload.deleted],
    ["forced", payload.forced],
    ["draft", pullRequest?.draft],
    ["merged", pullRequest?.merged],
    ["releaseDraft", release?.draft],
    ["prerelease", release?.prerelease],
  ] as const) {
    if (typeof value === "boolean") metadata[key] = value;
  }
  for (const [key, value] of [
    ["before", payload.before],
    ["after", payload.after],
    ["headSha", record(pullRequest?.head)?.sha],
    ["baseSha", record(pullRequest?.base)?.sha],
    ["workflowHeadSha", workflowRun?.head_sha],
  ] as const) {
    const sha = safeSha(value);
    if (sha) metadata[key] = sha;
  }

  return metadata;
}

/** A commit check or pull request head read from a delivery, ready to record in the Space. */
export type CommitCheckUpdate =
  | { kind: "check"; report: Omit<CommitCheckReport, "spaceId"> }
  | { kind: "pullRequest"; report: Omit<PullRequestHeadReport, "spaceId"> };

/** Host and full name, lowercased, so a link's address and a delivery name the same repository. */
function repositoryKey(repository: Record<string, unknown> | undefined): string | undefined {
  const fullName = typeof repository?.full_name === "string" ? repository.full_name : undefined;
  const htmlUrl = typeof repository?.html_url === "string" ? repository.html_url : undefined;
  if (!fullName || !htmlUrl) return undefined;
  try {
    return `${new URL(htmlUrl).host}/${fullName}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function checkState(check: Record<string, unknown>): CommitCheckState | undefined {
  if (check.status === "queued") return "queued";
  if (check.status === "in_progress") return "running";
  if (check.status !== "completed") return undefined;
  if (check.conclusion === "success") return "passed";
  if (check.conclusion === "neutral" || check.conclusion === "skipped") return "skipped";
  if (check.conclusion === "stale" || check.conclusion === null) return "skipped";
  return "failed";
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads the commit checks and pull request heads a delivery reports. Other events, and
 * deliveries missing what a row needs, give nothing. Commit statuses are not read yet.
 */
export function commitCheckUpdate(
  event: string,
  payload: Record<string, unknown>,
): CommitCheckUpdate | undefined {
  const repository = repositoryKey(record(payload.repository));
  if (!repository) return undefined;
  if (event === "check_run") {
    const check = record(payload.check_run);
    const state = check && checkState(check);
    const headSha = safeSha(check?.head_sha);
    const name = typeof check?.name === "string" ? check.name.slice(0, 300) : undefined;
    const checkRunId = safeInteger(check?.id);
    if (!check || !state || !headSha || !name || checkRunId === undefined) return undefined;
    return {
      kind: "check",
      report: {
        repository,
        headSha: headSha.toLowerCase(),
        name,
        checkRunId: BigInt(checkRunId),
        state,
        url: typeof check.html_url === "string" ? check.html_url : null,
        startedAt: isoDate(check.started_at),
        completedAt: isoDate(check.completed_at),
      },
    };
  }
  if (event === "pull_request") {
    const pullRequest = record(payload.pull_request);
    const headSha = safeSha(record(pullRequest?.head)?.sha);
    const updatedAt = isoDate(pullRequest?.updated_at);
    const number = safeInteger(payload.number);
    if (!headSha || !updatedAt || number === undefined || number === 0) return undefined;
    return {
      kind: "pullRequest",
      report: { repository, number, headSha: headSha.toLowerCase(), updatedAt },
    };
  }
  return undefined;
}

/**
 * Records what a delivery says about checks, and tells the Space's apps to read again only when
 * something changed. A failure is logged and never holds up the bot's own delivery.
 */
export async function recordGithubCommitChecks(
  deps: Pick<WebhookDeps, "prisma" | "events">,
  spaceId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const update = commitCheckUpdate(event, payload);
  if (!update) return;
  const changed = await bestEffort(
    "record commit check",
    update.kind === "check"
      ? recordCommitCheck(deps.prisma, { ...update.report, spaceId })
      : recordPullRequestHead(deps.prisma, { ...update.report, spaceId }),
  );
  if (changed) await deps.events.publishSpaceChange?.(spaceId, "checks");
}

export function formatGithubEventPrompt(event: string, payload: Record<string, unknown>): string {
  return githubEventMetadataPrompt(event, githubDeliveryMetadata(event, payload));
}

/** The state a pull request event leaves its pull request in, for tickets that link it. */
export function githubPullRequestState(
  event: string,
  payload: Record<string, unknown>,
): { url: string; state: TicketPullRequestState } | null {
  if (event !== "pull_request") return null;
  const pullRequest = record(payload.pull_request);
  const url = pullRequest?.html_url;
  if (typeof url !== "string") return null;
  if (payload.action === "closed") {
    return { url, state: pullRequest?.merged === true ? "merged" : "closed" };
  }
  if (payload.action === "reopened") return { url, state: "open" };
  return null;
}

/** The state an issues event leaves its issue in, for tickets that link it. */
export function githubIssueState(
  event: string,
  payload: Record<string, unknown>,
): { url: string; state: TicketIssueState } | null {
  if (event !== "issues") return null;
  const url = record(payload.issue)?.html_url;
  if (typeof url !== "string") return null;
  if (payload.action === "closed") return { url, state: "closed" };
  if (payload.action === "reopened") return { url, state: "open" };
  return null;
}

export function mountGithubWebhookRoute(
  app: Hono,
  deps: WebhookDeps,
  secretCache: WebhookSecretCache,
) {
  app.post("/api/v1/bots/:botId/github", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);

    // Reject oversized bodies before target lookup so size limits do not reveal active bots.
    // The signature covers the bytes GitHub sent, so keep them: decoding first would let a
    // body that is not valid UTF-8 change between what was signed and what is verified.
    // It runs before authentication, so it must not allocate from an unauthenticated length.
    const raw = await readBoundedBytes(c.req.raw, WEBHOOK_MAX_BODY_BYTES, {
      preallocateFromContentLength: false,
    });
    if (raw === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    let target: Awaited<ReturnType<typeof loadWebhookTarget>>;
    try {
      target = await loadWebhookTarget(deps, secretCache, c.req.param("botId"));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return c.json({ error: "Service unavailable" }, 503);
      }
      throw error;
    }
    if (!target) return unauthorized();
    if (!hasValidGithubSignature(c.req.header("x-hub-signature-256"), target.expected, raw)) {
      return unauthorized();
    }

    const contentType = c.req.header("content-type");
    // GitHub's default form content type sends the JSON in the `payload` field.
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    const text = new TextDecoder().decode(raw);
    const body =
      mediaType === "application/x-www-form-urlencoded"
        ? (new URLSearchParams(text).get("payload") ?? "")
        : text;
    const payload = parseWebhookPayload(body, contentType);
    const githubEvent = githubEventName(c.req.header("x-github-event"));

    // Tickets in the bot's Space follow the pull requests and issues they link, with or without a
    // routine.
    const pullRequest = githubPullRequestState(githubEvent, payload);
    if (pullRequest) {
      await recordTicketPullRequestState(deps, { spaceId: target.bot.spaceId, ...pullRequest });
    }
    const issue = githubIssueState(githubEvent, payload);
    if (issue) await recordTicketIssueState(deps, { spaceId: target.bot.spaceId, ...issue });
    // Checks are recorded for every bot on the repository, before a bot without routines ignores it.
    await recordGithubCommitChecks(deps, target.bot.spaceId, githubEvent, payload);

    const githubRoutines = await deps.prisma.routine.findMany({
      where: {
        botId: target.bot.id,
        spaceId: target.bot.spaceId,
        // The delivery runs as the bot's creator, so only their own routines may ride on it.
        userId: target.bot.userId,
        active: true,
        githubEnabled: true,
      },
      select: {
        id: true,
        name: true,
        prompt: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    if (githubRoutines.length === 0) {
      return c.json({ ok: true, ignored: true });
    }

    const eventPrompt = formatGithubEventPrompt(githubEvent, payload);

    return webhookDeliveryResponse(
      c,
      deliverWebhookEvent(deps, target, {
        prompt: eventPrompt,
        routines: githubRoutines,
        source: "github",
        // The signature covers only the body, so key on it: a replay with a fresh delivery id still dedupes.
        idempotencyKey: text,
      }),
    );
  });
}
