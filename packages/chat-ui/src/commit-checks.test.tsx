import type { CommitCheck } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CommitCheckTarget } from "./commit-checks";
import {
  CommitChecksContext,
  commitCheckSeconds,
  commitCheckTarget,
  summarizeCommitChecks,
} from "./commit-checks";
import { CommitChecksBadge } from "./commit-checks-badge";
import { LinkifiedText } from "./markdown.web";

const SHA = "ABCDEF0123456789abcdef0123456789abcdef01";

function check(state: CommitCheck["state"], name: string = state): CommitCheck {
  return {
    name,
    state,
    url: `https://host.example/checks/${name}`,
    startedAt: null,
    completedAt: null,
  };
}

function withChecks(checks: readonly CommitCheck[] | undefined, children: React.ReactNode) {
  return (
    <CommitChecksContext.Provider value={{ use: () => checks }}>
      {children}
    </CommitChecksContext.Provider>
  );
}

describe("commitCheckTarget", () => {
  it("reads pull request and commit addresses, lowercased like the stored repository", () => {
    expect(commitCheckTarget("https://Host.Example/Acme/App/pull/42")).toEqual({
      kind: "pullRequest",
      repository: "host.example/acme/app",
      number: 42,
    });
    expect(commitCheckTarget(`https://host.example/acme/app/pull/42/files#diff`)).toEqual({
      kind: "pullRequest",
      repository: "host.example/acme/app",
      number: 42,
    });
    expect(commitCheckTarget(`https://host.example/acme/app/commit/${SHA}`)).toEqual({
      kind: "commit",
      repository: "host.example/acme/app",
      sha: SHA.toLowerCase(),
    });
  });

  it("gives nothing for other links, other schemes, and malformed numbers", () => {
    for (const href of [
      "https://host.example/acme/app",
      "https://host.example/acme/app/pull/0",
      "https://host.example/acme/app/pull/abc",
      "https://host.example/acme/app/commit/zz",
      "http://host.example/acme/app/pull/1",
      "not a url",
    ]) {
      expect(commitCheckTarget(href), href).toBeUndefined();
    }
  });
});

describe("summarizeCommitChecks", () => {
  it("shows nothing without checks", () => {
    expect(summarizeCommitChecks(undefined)).toBeUndefined();
    expect(summarizeCommitChecks([])).toBeUndefined();
  });

  it("is failed when any check failed, running while any waits, and passed otherwise", () => {
    expect(summarizeCommitChecks([check("passed"), check("failed")])?.tone).toBe("failed");
    expect(summarizeCommitChecks([check("passed"), check("running")])?.tone).toBe("running");
    expect(summarizeCommitChecks([check("queued"), check("failed")])?.tone).toBe("failed");
    expect(summarizeCommitChecks([check("passed"), check("skipped")])).toEqual({
      tone: "passed",
      passed: 2,
      total: 2,
    });
  });

  it("counts passed and skipped checks as passed out of all of them", () => {
    expect(
      summarizeCommitChecks([check("passed", "a"), check("running", "b"), check("skipped", "c")]),
    ).toEqual({ tone: "running", passed: 2, total: 3 });
  });
});

describe("commitCheckSeconds", () => {
  it("is the time between start and end, and nothing while a check has not ended", () => {
    const base = check("passed");
    expect(
      commitCheckSeconds({
        ...base,
        startedAt: "2026-03-01T10:00:00.000Z",
        completedAt: "2026-03-01T10:01:05.400Z",
      }),
    ).toBe(65);
    expect(commitCheckSeconds({ ...base, startedAt: "2026-03-01T10:00:00.000Z" })).toBeUndefined();
  });
});

describe("CommitChecksBadge", () => {
  const pr: CommitCheckTarget = { kind: "pullRequest", repository: "host.example/a/b", number: 1 };

  it("shows a spinning ring with the progress name while checks run", () => {
    const html = renderToStaticMarkup(
      withChecks([check("passed", "a"), check("running", "b")], <CommitChecksBadge target={pr} />),
    );
    expect(html).toContain('aria-label="Checks: 1 of 2 passed"');
    expect(html).toContain('data-tone="running"');
    expect(html).toContain("rk-check-ring");
  });

  it("shows a cross when a check failed, and a check when all passed", () => {
    const failed = renderToStaticMarkup(
      withChecks([check("failed")], <CommitChecksBadge target={pr} />),
    );
    expect(failed).toContain('aria-label="Checks failed"');
    const passed = renderToStaticMarkup(
      withChecks([check("passed")], <CommitChecksBadge target={pr} />),
    );
    expect(passed).toContain('aria-label="Checks passed"');
    expect(passed).toContain('data-tone="passed"');
  });

  it("renders nothing when there is no data", () => {
    expect(renderToStaticMarkup(withChecks(undefined, <CommitChecksBadge target={pr} />))).toBe("");
    expect(renderToStaticMarkup(withChecks([], <CommitChecksBadge target={pr} />))).toBe("");
  });

  it("sits beside a linked pull request in a message", () => {
    const html = renderToStaticMarkup(
      withChecks(
        [check("passed")],
        <LinkifiedText>{"see https://host.example/acme/app/pull/3"}</LinkifiedText>,
      ),
    );
    expect(html).toContain('href="https://host.example/acme/app/pull/3"');
    expect(html).toContain('aria-label="Checks passed"');
    expect(html.indexOf("rk-check-status")).toBeGreaterThan(html.indexOf("</a>"));
  });
});
