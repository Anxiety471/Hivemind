import { describe, expect, it, vi } from "vitest";
import { commitCheckUpdate, recordGithubCommitChecks } from "./github-webhook.js";
import type { WebhookDeps } from "./webhook-inbound.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const repository = {
  full_name: "Acme/App",
  html_url: "https://Host.Example/Acme/App",
};

function checkRunPayload(check: Record<string, unknown>) {
  return { repository, check_run: { id: 4_000_000_001, name: "build", head_sha: SHA, ...check } };
}

describe("commitCheckUpdate", () => {
  it("reads a check run's state, url and times, with the repository as host and name", () => {
    expect(
      commitCheckUpdate(
        "check_run",
        checkRunPayload({
          status: "completed",
          conclusion: "failure",
          html_url: "https://host.example/acme/app/runs/1",
          started_at: "2026-03-01T10:00:00Z",
          completed_at: "2026-03-01T10:05:00Z",
        }),
      ),
    ).toEqual({
      kind: "check",
      report: {
        repository: "host.example/acme/app",
        headSha: SHA,
        name: "build",
        checkRunId: 4_000_000_001n,
        state: "failed",
        url: "https://host.example/acme/app/runs/1",
        startedAt: new Date("2026-03-01T10:00:00Z"),
        completedAt: new Date("2026-03-01T10:05:00Z"),
      },
    });
  });

  it("maps in-flight, passing and skipped conclusions to the states the app shows", () => {
    const stateOf = (check: Record<string, unknown>) => {
      const update = commitCheckUpdate("check_run", checkRunPayload(check));
      return update?.kind === "check" ? update.report.state : undefined;
    };
    expect(stateOf({ status: "queued" })).toBe("queued");
    expect(stateOf({ status: "in_progress" })).toBe("running");
    expect(stateOf({ status: "completed", conclusion: "success" })).toBe("passed");
    expect(stateOf({ status: "completed", conclusion: "neutral" })).toBe("skipped");
    expect(stateOf({ status: "completed", conclusion: "skipped" })).toBe("skipped");
    expect(stateOf({ status: "completed", conclusion: "timed_out" })).toBe("failed");
    expect(stateOf({ status: "completed", conclusion: "cancelled" })).toBe("failed");
    expect(stateOf({ status: "waiting" })).toBeUndefined();
  });

  it("reads a pull request's head commit and its own update time", () => {
    expect(
      commitCheckUpdate("pull_request", {
        repository,
        number: 12,
        pull_request: {
          head: { sha: SHA.toUpperCase() },
          updated_at: "2026-03-02T09:00:00Z",
        },
      }),
    ).toEqual({
      kind: "pullRequest",
      report: {
        repository: "host.example/acme/app",
        number: 12,
        headSha: SHA,
        updatedAt: new Date("2026-03-02T09:00:00Z"),
      },
    });
  });

  it("gives nothing for other events or deliveries missing what a row needs", () => {
    expect(commitCheckUpdate("push", { repository, after: SHA })).toBeUndefined();
    expect(commitCheckUpdate("check_run", { check_run: { id: 1 } })).toBeUndefined();
    expect(
      commitCheckUpdate("check_run", { check_run: { id: 1, name: "x" }, repository: {} }),
    ).toBeUndefined();
    expect(
      commitCheckUpdate("pull_request", { repository, number: 1, pull_request: {} }),
    ).toBeUndefined();
  });
});

function deps(changes: boolean[]) {
  const $executeRaw = vi.fn();
  for (const changed of changes) $executeRaw.mockResolvedValueOnce(changed ? 1 : 0);
  const publishSpaceChange = vi.fn(async () => undefined);
  return {
    deps: {
      prisma: { $executeRaw } as unknown as WebhookDeps["prisma"],
      events: { publishSpaceChange } as unknown as WebhookDeps["events"],
    },
    $executeRaw,
    publishSpaceChange,
  };
}

describe("recordGithubCommitChecks", () => {
  const payload = checkRunPayload({ status: "in_progress" });

  it("signals the Space once for a change, and not for a duplicate or an older delivery", async () => {
    const { deps: fake, $executeRaw, publishSpaceChange } = deps([true, false, false]);
    await recordGithubCommitChecks(fake, "space-1", "check_run", payload);
    await recordGithubCommitChecks(fake, "space-1", "check_run", payload);
    await recordGithubCommitChecks(fake, "space-1", "check_run", payload);
    expect($executeRaw).toHaveBeenCalledTimes(3);
    expect(publishSpaceChange).toHaveBeenCalledTimes(1);
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "checks");
  });

  it("writes nothing for events it does not read", async () => {
    const { deps: fake, $executeRaw, publishSpaceChange } = deps([]);
    await recordGithubCommitChecks(fake, "space-1", "workflow_run", payload);
    expect($executeRaw).not.toHaveBeenCalled();
    expect(publishSpaceChange).not.toHaveBeenCalled();
  });

  it("does not fail the delivery when the write fails", async () => {
    const $executeRaw = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const publishSpaceChange = vi.fn(async () => undefined);
    await expect(
      recordGithubCommitChecks(
        {
          prisma: { $executeRaw } as unknown as WebhookDeps["prisma"],
          events: { publishSpaceChange } as unknown as WebhookDeps["events"],
        },
        "space-1",
        "check_run",
        payload,
      ),
    ).resolves.toBeUndefined();
    expect(publishSpaceChange).not.toHaveBeenCalled();
  });
});
