import { describe, expect, it } from "vitest";
import type { ChatReferenceContext } from "./references";
import {
  deriveRepositoryBaseUrl,
  describeChatReference,
  markdownTicketRef,
  planPlainChatReferences,
  repositoryCommitUrl,
  repositoryPullRequestUrl,
  resolveJobCommitUrl,
  withBlockChatReferences,
  withChatReferences,
} from "./references";

const HIVEMIND = "https://git.example.test/acme/hivemind";
const WAKE = "https://git.example.test/acme/wake";
const SHA = "ffc2c036f5804d114af39ea6b91c8a75b9cbe55b";

const twoRepos: ChatReferenceContext = {
  ticketPrefix: "TASK",
  repositories: [{ url: HIVEMIND }, { url: WAKE }],
  tickets: [
    { ref: "TASK-397", repository: HIVEMIND, pullRequests: [{ url: `${HIVEMIND}/pull/19` }] },
  ],
};

describe("URL helpers", () => {
  it("derives the repository base from a home, PR, MR, issue or commit URL over https", () => {
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}/`)).toBe(HIVEMIND);
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}/pull/19`)).toBe(HIVEMIND);
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}.git`)).toBe(HIVEMIND);
    expect(
      deriveRepositoryBaseUrl("https://git.example.test/group/sub/app/-/merge_requests/3"),
    ).toBe("https://git.example.test/group/sub/app");
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}/commit/${SHA}`)).toBe(HIVEMIND);
    expect(deriveRepositoryBaseUrl("http://git.example.test/acme/hivemind")).toBeNull();
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}/actions/runs/1`)).toBe(HIVEMIND);
    expect(deriveRepositoryBaseUrl(`${HIVEMIND}/tree/main/src`)).toBe(HIVEMIND);
    expect(deriveRepositoryBaseUrl(undefined)).toBeNull();
  });

  it("builds repository commit and pull request URLs in either style", () => {
    expect(repositoryCommitUrl(HIVEMIND, SHA)).toBe(`${HIVEMIND}/commit/${SHA}`);
    expect(repositoryCommitUrl(HIVEMIND, SHA, "dash")).toBe(`${HIVEMIND}/-/commit/${SHA}`);
    expect(repositoryPullRequestUrl(HIVEMIND, 19)).toBe(`${HIVEMIND}/pull/19`);
    expect(repositoryPullRequestUrl(HIVEMIND, 19, "-/merge_requests")).toBe(
      `${HIVEMIND}/-/merge_requests/19`,
    );
  });

  it("reads ticket refs from ticket links only", () => {
    expect(markdownTicketRef("rakazo-ticket:TASK-397")).toBe("TASK-397");
    expect(markdownTicketRef("rakazo-ticket:bad ref")).toBeUndefined();
    expect(markdownTicketRef("rakazo-mention:TASK-397")).toBeUndefined();
    expect(markdownTicketRef(undefined)).toBeUndefined();
  });
});

describe("withChatReferences", () => {
  it("resolves every reference in a multi-repo message to the repository it names", () => {
    const message = [
      "Hivemind PR #19",
      "Head SHA: `ffc2c036f5804d114af39ea6b91c8a75b9cbe55b`",
      "Run 45952746540",
      "TASK-397",
      "`cmwymb8zz01sx6akusf2unhzw`",
      "PR #18",
      "only `acme/wake`",
      'Reply "merge #19" and then `ffc2c036`',
      "1. #249 wake merge authority: `24a7cbd8` then `d612a5e` then `24a7cbd`",
      "2. After #249 lands: #247 and #239",
      "3. TASK-362",
      "4. TASK-388",
    ].join("\n");
    expect(withChatReferences(message, twoRepos)).toBe(
      [
        `Hivemind [PR #19](<${HIVEMIND}/pull/19>)`,
        `Head SHA: [\`${SHA}\`](<${HIVEMIND}/commit/${SHA}>)`,
        "Run 45952746540",
        "[TASK-397](rakazo-ticket:TASK-397)",
        "`cmwymb8zz01sx6akusf2unhzw`",
        `[PR #18](<${HIVEMIND}/pull/18>)`,
        "only `acme/wake`",
        `Reply "merge [#19](<${HIVEMIND}/pull/19>)" and then [\`ffc2c036\`](<${HIVEMIND}/commit/ffc2c036>)`,
        `1. [#249](<${WAKE}/pull/249>) wake merge authority: [\`24a7cbd8\`](<${WAKE}/commit/24a7cbd8>) then [\`d612a5e\`](<${WAKE}/commit/d612a5e>) then [\`24a7cbd\`](<${WAKE}/commit/24a7cbd>)`,
        `2. After [#249](<${WAKE}/pull/249>) lands: [#247](<${WAKE}/pull/247>) and [#239](<${WAKE}/pull/239>)`,
        "3. [TASK-362](rakazo-ticket:TASK-362)",
        "4. [TASK-388](rakazo-ticket:TASK-388)",
      ].join("\n"),
    );
  });

  it("leaves numbers, identifiers, fenced code and existing links untouched", () => {
    const message = [
      "```",
      "PR #7 `ffc2c036` TASK-1 acme/wake#3",
      "```",
      "Run 45952746540, id cmwymb8zz01sx6akusf2unhzw, word deadbeef",
      "[#19](https://example.test/x) and `ffc2c036`",
    ].join("\n");
    // Nothing names a repository for the bare SHA, so the message comes back unchanged.
    expect(withChatReferences(message, twoRepos)).toBe(message);
  });

  it("links a ticket only with the configured prefix", () => {
    const text = "HIT-42 TASK-1 UTF-8 and xHIT-3";
    expect(withChatReferences(text, { ticketPrefix: "HIT" })).toBe(
      "[HIT-42](rakazo-ticket:HIT-42) TASK-1 UTF-8 and xHIT-3",
    );
    expect(withChatReferences(text, {})).toBe(text);
    expect(withChatReferences("TASK-1", { ticketPrefix: "TASK" })).toBe(
      "[TASK-1](rakazo-ticket:TASK-1)",
    );
  });

  it("matches a ticket's pull request, including the dashed merge request path form", () => {
    const group = "https://git.example.test/group/app";
    const context: ChatReferenceContext = {
      ticketPrefix: "TASK",
      tickets: [
        {
          ref: "TASK-5",
          repository: group,
          pullRequests: [{ url: `${group}/-/merge_requests/19` }],
        },
      ],
    };
    expect(withChatReferences("TASK-5 is in PR #19", context)).toBe(
      `[TASK-5](rakazo-ticket:TASK-5) is in [PR #19](<${group}/-/merge_requests/19>)`,
    );
  });

  it("links a commit and a pull request from a job card", () => {
    const context: ChatReferenceContext = {
      repositories: [{ url: WAKE }],
      jobs: [
        {
          repo: "acme/wake",
          prUrl: `${WAKE}/pull/249`,
          commit: "24a7cbd8e1f0a9b2c3d4e5f60718293a4b5c6d7e",
        },
      ],
    };
    expect(withChatReferences("job `24a7cbd` for #249", context)).toBe(
      `job [\`24a7cbd\`](<${WAKE}/commit/24a7cbd>) for [#249](<${WAKE}/pull/249>)`,
    );
  });

  it("keeps an ambiguous PR number or SHA as plain text", () => {
    const text = "PR #19 and `ffc2c036`";
    expect(withChatReferences(text, {})).toBe(text);
    expect(withChatReferences(text, { repositories: [{ url: HIVEMIND }, { url: WAKE }] })).toBe(
      text,
    );
  });

  it("uses the repository of a single repository and the default", () => {
    expect(withChatReferences("PR #3", { repositories: [{ url: WAKE }] })).toBe(
      `[PR #3](<${WAKE}/pull/3>)`,
    );
    expect(
      withChatReferences("PR #3", {
        repositories: [{ url: HIVEMIND }, { url: WAKE, isDefault: true }],
      }),
    ).toBe(`[PR #3](<${WAKE}/pull/3>)`);
  });

  it("links an explicit owner/repo reference only for a known repository", () => {
    expect(withChatReferences("acme/wake#12 and other/app#4", twoRepos)).toBe(
      `[acme/wake#12](<${WAKE}/pull/12>) and other/app#4`,
    );
  });
});

describe("withBlockChatReferences", () => {
  it("shares repository context across prose blocks and leaves tool activity alone", () => {
    const blocks = withBlockChatReferences(
      [
        { kind: "text", text: "Hivemind PR #19" },
        { kind: "progress", text: "#19", activity: true },
        { kind: "text", text: "merge #19 later" },
      ] as never,
      twoRepos,
    );
    expect(blocks).toEqual([
      { kind: "text", text: `Hivemind [PR #19](<${HIVEMIND}/pull/19>)` },
      { kind: "progress", text: "#19", activity: true },
      { kind: "text", text: `merge [#19](<${HIVEMIND}/pull/19>) later` },
    ]);
  });
});

describe("resolveJobCommitUrl", () => {
  it("derives a job's commit link from its PR, its URL, or its repo", () => {
    const commit = "24a7cbd8e1f0a9b2c3d4e5f60718293a4b5c6d7e";
    expect(resolveJobCommitUrl({ commit, prUrl: `${WAKE}/pull/249` })).toBe(
      `${WAKE}/commit/${commit}`,
    );
    expect(resolveJobCommitUrl({ commit, url: `${WAKE}/commit/${commit}` })).toBe(
      `${WAKE}/commit/${commit}`,
    );
    expect(resolveJobCommitUrl({ commit, repo: "acme/wake" }, [{ url: WAKE }])).toBe(
      `${WAKE}/commit/${commit}`,
    );
    expect(resolveJobCommitUrl({ commit, repo: "acme/wake" })).toBeUndefined();
    expect(resolveJobCommitUrl({ commit: "45952746540", prUrl: `${WAKE}/pull/1` })).toBeUndefined();
    expect(resolveJobCommitUrl({ commit: "deadbeef", prUrl: `${WAKE}/pull/1` })).toBeUndefined();
  });
});

describe("planPlainChatReferences", () => {
  it("skips the given ranges and resolves the rest", () => {
    const text = "PR #19 and TASK-397 and https://example.test/x";
    expect(planPlainChatReferences(text, [{ start: 38, end: text.length }], twoRepos)).toEqual([
      { start: 0, end: 6, kind: "link", href: `${HIVEMIND}/pull/19` },
      { start: 11, end: 19, kind: "ticket", ticketRef: "TASK-397" },
    ]);
  });
});

describe("describeChatReference", () => {
  const board: ChatReferenceContext = {
    ticketPrefix: "TASK",
    tickets: [
      {
        ref: "TASK-397",
        title: "Hover cards",
        status: "doing",
        priority: "high",
        assigneeName: "Grok Bot",
        repository: `${HIVEMIND}.git`,
        pullRequests: [{ url: `${HIVEMIND}/pull/19`, state: "merged" }],
      },
    ],
    jobs: [
      {
        repo: "acme/hivemind",
        commit: SHA,
        title: "Hover card work",
        branch: "feat/hover",
      },
    ],
  };

  it("describes a ticket from the board, with its repository and PR count", () => {
    expect(describeChatReference("rakazo-ticket:TASK-397", board)).toEqual({
      kind: "ticket",
      ref: "TASK-397",
      title: "Hover cards",
      status: "doing",
      priority: "high",
      assigneeName: "Grok Bot",
      repoLabel: "acme/hivemind",
      pullRequestCount: 1,
    });
  });

  it("still describes a ticket the board does not list, so its card shows the ref", () => {
    expect(describeChatReference("rakazo-ticket:TASK-12", board)).toEqual({
      kind: "ticket",
      ref: "TASK-12",
      pullRequestCount: 0,
    });
  });

  it("describes a pull request with its state and the ticket it belongs to", () => {
    expect(describeChatReference(`${HIVEMIND}/pull/19`, board)).toEqual({
      kind: "pull_request",
      number: 19,
      repoLabel: "acme/hivemind",
      host: "git.example.test",
      state: "merged",
      ticketRef: "TASK-397",
      ticketTitle: "Hover cards",
    });
  });

  it("matches a merge request URL against the board's pull request by host, repo and number", () => {
    const merged: ChatReferenceContext = {
      tickets: [
        {
          ref: "TASK-5",
          title: "Lab fix",
          pullRequests: [
            { url: "https://git.example.test/Acme/Hivemind/-/merge_requests/7", state: "open" },
          ],
        },
      ],
    };
    expect(
      describeChatReference("https://git.example.test/acme/hivemind/-/merge_requests/7", merged),
    ).toMatchObject({
      kind: "pull_request",
      number: 7,
      state: "open",
      ticketRef: "TASK-5",
      ticketTitle: "Lab fix",
    });
    expect(
      describeChatReference("https://git.example.test/acme/hivemind/pull/8", merged),
    ).toMatchObject({
      kind: "pull_request",
      number: 8,
      state: undefined,
      ticketRef: undefined,
    });
  });

  it("describes a commit with its full SHA, branch and job title from the job card", () => {
    expect(describeChatReference(`${HIVEMIND}/commit/ffc2c036`, board)).toEqual({
      kind: "commit",
      sha: SHA,
      shortSha: "ffc2c03",
      repoLabel: "acme/hivemind",
      host: "git.example.test",
      branch: "feat/hover",
      jobTitle: "Hover card work",
    });
  });

  it("keeps a commit's own SHA when no job card matches it", () => {
    const other = "1234567890abcdef1234567890abcdef12345678";
    expect(describeChatReference(`${HIVEMIND}/-/commit/${other}`, board)).toEqual({
      kind: "commit",
      sha: other,
      shortSha: "1234567",
      repoLabel: "acme/hivemind",
      host: "git.example.test",
      branch: undefined,
      jobTitle: undefined,
    });
  });

  it("leaves an ordinary website without a preview", () => {
    expect(describeChatReference("https://docs.example.test/guide/setup", board)).toBeUndefined();
    expect(describeChatReference(undefined, board)).toBeUndefined();
  });
});
