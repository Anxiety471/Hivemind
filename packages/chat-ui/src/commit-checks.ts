import type { CommitCheck } from "@rakazo/contracts";
import { createContext } from "react";

/** A commit or a pull request whose checks a link in a message names, keyed as the server keys them. */
export type CommitCheckTarget =
  | { kind: "commit"; repository: string; sha: string }
  | { kind: "pullRequest"; repository: string; number: number };

const PULL_REQUEST_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d{0,8})(?:\/|$)/;
const COMMIT_PATH = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,64})(?:\/|$)/i;

/**
 * The commit or pull request a link points at, when its address has the shape of one. Only https
 * addresses count; the host and repository are lowercased so they match what the server stored.
 */
export function commitCheckTarget(href: string): CommitCheckTarget | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const pull = PULL_REQUEST_PATH.exec(url.pathname);
  if (pull) {
    return {
      kind: "pullRequest",
      repository: repositoryOf(url, pull[1]!, pull[2]!),
      number: Number(pull[3]),
    };
  }
  const commit = COMMIT_PATH.exec(url.pathname);
  if (commit) {
    return {
      kind: "commit",
      repository: repositoryOf(url, commit[1]!, commit[2]!),
      sha: commit[3]!.toLowerCase(),
    };
  }
  return undefined;
}

function repositoryOf(url: URL, owner: string, name: string): string {
  return `${url.host}/${owner}/${name}`.toLowerCase();
}

export type CommitChecksSummary = {
  /** Failed wins over running, and running over passed. */
  tone: "running" | "failed" | "passed";
  /** Passed and skipped checks; a skipped check does not hold the commit back. */
  passed: number;
  total: number;
};

/** What the status glyph shows, or nothing when there are no checks to show. */
export function summarizeCommitChecks(
  checks: readonly CommitCheck[] | undefined,
): CommitChecksSummary | undefined {
  if (!checks || checks.length === 0) return undefined;
  const failed = checks.some((check) => check.state === "failed");
  const pending = checks.some((check) => check.state === "queued" || check.state === "running");
  return {
    tone: failed ? "failed" : pending ? "running" : "passed",
    passed: checks.filter((check) => check.state === "passed" || check.state === "skipped").length,
    total: checks.length,
  };
}

/** How long a finished check took, in whole seconds, or undefined while it has not both started and ended. */
export function commitCheckSeconds(check: CommitCheck): number | undefined {
  if (!check.startedAt || !check.completedAt) return undefined;
  const seconds = (Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : undefined;
}

/**
 * How the app reads a target's checks. The app supplies it with live reads, so chat-ui keeps no
 * query state of its own; `undefined` means nothing to show yet, or no data.
 */
export type CommitChecksSource = {
  use(target: CommitCheckTarget): readonly CommitCheck[] | undefined;
  /** Where a platform without a popover lists the checks, such as a native sheet. */
  open?(target: CommitCheckTarget, checks: readonly CommitCheck[], label: string): void;
};

export const CommitChecksContext = createContext<CommitChecksSource>({ use: () => undefined });
