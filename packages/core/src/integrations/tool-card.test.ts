import {
  JOB_CARD_FILE_DIFF_MAX_CHARS,
  JOB_CARD_MAX_FILES,
  JOB_CARD_MAX_STEPS,
  JOB_CARD_REPLY_MAX_CHARS,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { toolCardFromResult } from "./tool-card.js";

const card = {
  kind: "job",
  jobId: "job-1",
  title: "mcp-job-card",
  agent: "pi",
  branch: "example-org/job-card",
  state: "working",
  startedAt: 1_770_000_000_000,
  url: "https://orca.example.test",
};

const rich = {
  ...card,
  state: "finished",
  reply: "Ported the job card.",
  finishedAt: 1_770_000_060_000,
  turn: 3,
  repo: "example-org/example-repo",
  workspacePath: "/work/orca/worktrees/pr-1",
  commit: "fakesha0000",
  model: "gpt-5.5",
  effort: "high",
  summary: "Adds the coding details to the job card.",
  currentActivity: "Running the API tests",
  error: "go test ./... failed",
  prUrl: "https://github.com/example-org/example-repo/pull/1",
  prLabel: "#1",
  stats: {
    filesChanged: 4,
    insertions: 120,
    deletions: 9,
    toolCalls: 37,
    inputTokens: 20_000,
    outputTokens: 3_100,
    costUsd: 0.42,
  },
  files: [
    {
      path: "packages/contracts/src/integrations/tool-card.ts",
      status: "modified",
      insertions: 60,
      deletions: 2,
      diff: "@@ -1,3 +1,5 @@\n+export const JOB_CARD_MAX_FILES = 40;",
    },
    { path: "packages/core/src/integrations/tool-card.ts", status: "modified" },
  ],
  steps: [
    { kind: "tool", name: "grep", status: "ok", durationMs: 12 },
    { kind: "command", name: "pnpm test", detail: "34 passed", status: "running" },
  ],
};

const result = (structuredContent: unknown, isError = false) => ({
  content: [{ type: "text", text: "started" }],
  structuredContent,
  ...(isError ? { isError: true } : {}),
});

const read = (value: unknown) => toolCardFromResult(result({ card: value }));

describe("toolCardFromResult", () => {
  it("reads the card a tool result carried", () => {
    expect(toolCardFromResult(result({ card }))).toEqual(card);
  });

  it("reads every coding detail a rich card carries", () => {
    expect(read(rich)).toEqual(rich);
  });

  it("keeps the card but drops a link that is not https", () => {
    const { url: _url, ...withoutUrl } = card;
    expect(toolCardFromResult(result({ card: { ...card, url: "http://127.0.0.1:3422" } }))).toEqual(
      withoutUrl,
    );
    expect(
      toolCardFromResult(result({ card: { ...card, url: "https://user:pw@example.test" } })),
    ).toEqual(withoutUrl);
    expect(toolCardFromResult(result({ card: { ...card, url: "orca.example.test" } }))).toEqual(
      withoutUrl,
    );
  });

  it("drops a pull request link that is not https without losing the card", () => {
    const { prUrl: _prUrl, ...withoutPr } = rich;
    for (const prUrl of ["http://github.com/a/b/pull/1", "https://u:p@github.com/a/b/pull/1"]) {
      expect(read({ ...rich, prUrl })).toEqual(withoutPr);
    }
  });

  it("keeps a pull request link that is https", () => {
    expect(read({ ...card, prUrl: rich.prUrl })?.prUrl).toBe(rich.prUrl);
  });

  it("cuts a long reply to the card's cap instead of dropping the card", () => {
    const reply = "x".repeat(JOB_CARD_REPLY_MAX_CHARS + 50);
    const parsed = toolCardFromResult(result({ card: { ...card, state: "finished", reply } }));
    expect(parsed?.reply).toHaveLength(JOB_CARD_REPLY_MAX_CHARS);
    expect(parsed?.state).toBe("finished");
  });

  it("clips a long reply without splitting a surrogate pair", () => {
    const reply = `a${"😀".repeat(2_500)}`;
    const parsed = read({ ...card, state: "finished", reply });
    expect(parsed?.reply).toHaveLength(JOB_CARD_REPLY_MAX_CHARS - 1);
    // The dangling half of the pair is dropped with it, so the cuts land on a whole emoji.
    expect(parsed?.reply?.endsWith("😀")).toBe(true);
  });

  it("clips the short details to their caps", () => {
    const parsed = read({
      ...card,
      summary: "s".repeat(500),
      currentActivity: "a".repeat(300),
      error: "e".repeat(900),
    });
    expect(parsed?.summary).toHaveLength(400);
    expect(parsed?.currentActivity).toHaveLength(240);
    expect(parsed?.error).toHaveLength(600);
  });

  it("drops a detail that is empty once trimmed", () => {
    const parsed = read({ ...card, summary: "  ", currentActivity: "\n\t", error: " e " });
    expect(parsed?.summary).toBeUndefined();
    expect(parsed?.currentActivity).toBeUndefined();
    expect(parsed?.error).toBe("e");
  });

  it("keeps the first files of a long list, each diff cut to its cap", () => {
    const files = Array.from({ length: JOB_CARD_MAX_FILES + 5 }, (_value, index) => ({
      path: `src/file-${index}.ts`,
      diff: "d".repeat(JOB_CARD_FILE_DIFF_MAX_CHARS + 20),
    }));
    const parsed = read({ ...card, files });
    expect(parsed?.files).toHaveLength(JOB_CARD_MAX_FILES);
    expect(parsed?.files?.[0]?.path).toBe("src/file-0.ts");
    expect(parsed?.files?.[JOB_CARD_MAX_FILES - 1]?.path).toBe(
      `src/file-${JOB_CARD_MAX_FILES - 1}.ts`,
    );
    expect(parsed?.files?.[0]?.diff).toHaveLength(JOB_CARD_FILE_DIFF_MAX_CHARS);
  });

  it("keeps the most recent steps and cuts a long detail", () => {
    const steps = Array.from({ length: JOB_CARD_MAX_STEPS + 7 }, (_value, index) => ({
      kind: "tool" as const,
      name: `step-${index}`,
      detail: "x".repeat(500),
    }));
    const parsed = read({ ...card, steps });
    expect(parsed?.steps).toHaveLength(JOB_CARD_MAX_STEPS);
    expect(parsed?.steps?.[0]?.name).toBe("step-7");
    expect(parsed?.steps?.[JOB_CARD_MAX_STEPS - 1]?.name).toBe(`step-${JOB_CARD_MAX_STEPS + 6}`);
    expect(parsed?.steps?.[0]?.detail).toHaveLength(400);
  });

  it("keeps every state the contract names", () => {
    for (const state of ["starting", "working", "finished", "needs_input", "exited", "timed_out"]) {
      expect(toolCardFromResult(result({ card: { ...card, state } }))?.state).toBe(state);
    }
  });

  it("strips keys the contract does not name", () => {
    const parsed = read({ ...card, surprise: "extra" });
    expect(parsed).toEqual(card);
    expect(parsed).not.toHaveProperty("surprise");
  });

  it("shows nothing for a card this host cannot read", () => {
    expect(toolCardFromResult(result({ card: { ...card, state: "paused" } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: { ...card, jobId: "" } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: { ...card, title: undefined } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: "working" }))).toBeUndefined();
    expect(toolCardFromResult(result({}))).toBeUndefined();
    expect(toolCardFromResult(result({ card }, true))).toBeUndefined();
    expect(toolCardFromResult({ content: [] })).toBeUndefined();
    expect(toolCardFromResult(undefined)).toBeUndefined();
  });

  it("still drops the whole card for a detail of the wrong shape", () => {
    expect(read({ ...card, steps: "grep" })).toBeUndefined();
    expect(read({ ...card, files: [{ status: "modified" }] })).toBeUndefined();
    expect(read({ ...card, stats: { costUsd: -0.01 } })).toBeUndefined();
    expect(read({ ...card, turn: 0 })).toBeUndefined();
    expect(read({ ...card, finishedAt: -1 })).toBeUndefined();
  });
});
