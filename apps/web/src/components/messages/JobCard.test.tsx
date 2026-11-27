// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <>{children}</>,
}));

import { JobCard } from "./JobCard";

type JobBlock = Extract<MessageBlock, { kind: "job" }>;

const job: JobBlock = {
  kind: "job",
  jobId: "job-1",
  title: "mcp-job-card",
  agent: "pi",
  branch: "Anxiety471/mcp-job-card",
  state: "working",
  startedAt: 0,
  url: "https://code.example.test",
};

/** A finished coding job with every detail a card can carry. */
const richJob: JobBlock = {
  kind: "job",
  jobId: "job-rich",
  title: "Upgrade the billing worker",
  repo: "rakazo/billing",
  agent: "pi",
  model: "deepseek-v4.1-flash",
  effort: "max",
  branch: "t/billing-worker",
  commit: "163daa2f1c9d",
  state: "finished",
  startedAt: 1_000_000,
  finishedAt: 1_000_000 + 125_000,
  url: "https://code.example.test/job-rich",
  prUrl: "https://github.com/rakazo/billing/pull/812",
  prLabel: "#812",
  workspacePath: "/home/hitori/orca/worktrees/billing-worker",
  summary: "Retry failed charges before the invoice closes",
  reply: `## What changed

- Retried failed charges with a bounded backoff
- Added a regression test for the retry window

\`\`\`ts
const retry = createRetry({ attempts: 3 });
\`\`\`
`,
  stats: {
    filesChanged: 3,
    insertions: 142,
    deletions: 28,
    inputTokens: 41_200,
    outputTokens: 7_000,
    costUsd: 0.04,
  },
  files: [
    {
      path: "apps/api/src/billing/retry.ts",
      status: "added",
      insertions: 96,
      deletions: 0,
      diff: "@@ -0,0 +1,3 @@\n+export const retry = 3;\n+export const backoff = 250;\n context line",
    },
    {
      path: "apps/api/src/billing/invoice.ts",
      status: "modified",
      insertions: 46,
      deletions: 28,
      diff: "@@ -12,2 +12,2 @@\n-old line\n+new line",
    },
    { path: "apps/web/src/lib/legacy.ts", status: "deleted", insertions: 0, deletions: 0 },
  ],
  steps: [
    {
      kind: "command",
      name: "pnpm test billing",
      status: "ok",
      durationMs: 1_400,
      detail: "pnpm test billing --reporter=dot",
    },
    { kind: "edit", name: "retry.ts", status: "ok", durationMs: 80 },
    { kind: "tool", name: "read lodash source", status: "error" },
  ],
};

function mountCard(
  block: JobBlock,
  options: { readOnly?: boolean; onJobAction?: (text: string) => Promise<void> } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <JobCard block={block} readOnly={options.readOnly} onJobAction={options.onJobAction} />,
    ),
  );
  const card = () => container.querySelector<HTMLElement>('[data-testid="job-card"]');
  const text = () => card()?.textContent ?? "";
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const button = (id: string) => byTestId(id) as HTMLButtonElement | null;
  const click = (id: string) => flushSync(() => button(id)?.click());
  return {
    container,
    card,
    text,
    byTestId,
    button,
    click,
    // The dialog portals out of the card, so it is looked up on the document.
    dialog: (id: string) =>
      document.querySelector<HTMLElement>(`[data-slot="dialog-content"] [data-testid="${id}"]`),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe("JobCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("counts a working job's elapsed time up while it runs", () => {
    const card = mountCard({ ...job, startedAt: 1_000_000 - 65_000, url: undefined });
    expect(card.text()).toContain("Working");
    expect(card.text()).toContain("1:05");
    act(() => vi.advanceTimersByTime(1_000));
    expect(card.text()).toContain("1:06");
    card.unmount();
  });

  it("shows the live status bar with the running command and its step count", () => {
    const card = mountCard({
      ...job,
      startedAt: 1_000_000 - 5_000,
      currentActivity: "pnpm exec vitest run apps/web",
      stats: { toolCalls: 12 },
    });
    const bar = card.byTestId("job-live-status");
    expect(bar).not.toBeNull();
    // The command reads as a command, in monospace, behind a spinner.
    expect(bar?.querySelector(".font-mono")?.textContent).toBe("pnpm exec vitest run apps/web");
    expect(bar?.querySelector(".animate-spin")).not.toBeNull();
    expect(card.byTestId("job-live-steps")?.textContent).toBe("12 tools");
    card.unmount();
  });

  it("falls back to a concise phase label while a job starts or works", () => {
    const starting = mountCard({ ...job, state: "starting", startedAt: 1_000_000 - 2_000 });
    expect(starting.byTestId("job-live-status")?.textContent).toContain("Starting agent…");
    expect(starting.byTestId("job-live-steps")).toBeNull();
    starting.unmount();

    const working = mountCard({ ...job, state: "working", startedAt: 1_000_000 - 2_000 });
    expect(working.byTestId("job-live-status")?.textContent).toContain("Working on task…");
    expect(working.byTestId("job-live-steps")).toBeNull();
    working.unmount();
  });

  it("counts the listed steps in the live status bar when the job reports no tool total", () => {
    const card = mountCard({
      ...job,
      startedAt: 1_000_000 - 2_000,
      steps: [
        { kind: "command", name: "pnpm lint", status: "ok" },
        { kind: "edit", name: "retry.ts", status: "running" },
        { kind: "tool", name: "read lodash source", status: "ok" },
      ],
    });
    expect(card.byTestId("job-live-steps")?.textContent).toBe("3 steps");
    card.unmount();
  });

  it("labels every state the contract names", () => {
    const labels = {
      starting: "Starting",
      working: "Working",
      finished: "Finished",
      needs_input: "Needs input",
      exited: "Exited",
      timed_out: "Timed out",
    } as const;
    for (const [state, label] of Object.entries(labels)) {
      const card = mountCard({ ...job, state: state as JobBlock["state"] });
      expect(card.byTestId("job-status")?.textContent).toContain(label);
      card.unmount();
    }
  });

  it("shows a finished job's final duration, and none when the job never reported an end", () => {
    const finished = mountCard({
      ...job,
      state: "finished",
      startedAt: 1_000_000 - 125_000,
      finishedAt: 1_000_000,
    });
    expect(finished.byTestId("job-status")?.textContent).toContain("2:05");
    finished.unmount();

    const open = mountCard({ ...job, state: "finished", startedAt: 1_000_000 - 125_000 });
    expect(open.byTestId("job-status")?.textContent).toBe("Finished");
    open.unmount();
  });

  it("shows a finished job's reply folded, and opens it on request", () => {
    const reply = "R".repeat(400);
    const card = mountCard({ ...job, state: "finished", reply, startedAt: undefined });
    expect(card.text()).toContain("Finished");
    expect(card.text()).not.toContain("0:00");
    expect(card.button("job-reply-toggle")?.getAttribute("aria-expanded")).toBe("false");
    card.click("job-reply-toggle");
    expect(card.button("job-reply-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(card.button("job-reply-toggle")?.textContent).toBe("Show less");
    card.unmount();
  });

  it("folds a short reply that runs to more than three lines", () => {
    const reply = "one\ntwo\nthree\nfour";
    const card = mountCard({ ...job, state: "finished", reply });
    expect(card.button("job-reply-toggle")).not.toBeNull();
    expect(card.button("job-reply-toggle")?.getAttribute("aria-expanded")).toBe("false");
    card.click("job-reply-toggle");
    expect(card.button("job-reply-toggle")?.textContent).toBe("Show less");
    card.unmount();
  });

  it("keeps a short single-line reply without a fold control", () => {
    const card = mountCard({ ...job, state: "finished", reply: "Done" });
    expect(card.byTestId("job-output")?.textContent).toContain("Done");
    expect(card.button("job-reply-toggle")).toBeNull();
    card.unmount();
  });

  it("shows the coding metadata: agent, model, effort, branch, commit, diff, tokens and cost", () => {
    const card = mountCard(richJob);
    expect(card.byTestId("job-meta-agent")?.textContent).toBe("pi · deepseek-v4.1-flash · max");
    const branch = card.byTestId("job-meta-branch");
    expect(branch?.textContent).toContain("t/billing-worker");
    expect(branch?.textContent).toContain("163daa2");
    expect(card.byTestId("job-meta-diff")?.textContent).toContain("3 files");
    expect(card.byTestId("job-meta-diff")?.textContent).toContain("+142");
    expect(card.byTestId("job-meta-diff")?.textContent).toContain("-28");
    expect(card.byTestId("job-meta-tokens")?.textContent).toContain("48.2k tok");
    expect(card.byTestId("job-meta-tokens")?.textContent).toContain("$0.04");
    expect(card.byTestId("job-pr-link")?.getAttribute("href")).toBe(
      "https://github.com/rakazo/billing/pull/812",
    );
    expect(card.byTestId("job-pr-link")?.textContent).toContain("#812");
    card.unmount();
  });

  it("flashes a check when the branch name is copied, then settles", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const card = mountCard(richJob);
    expect(card.byTestId("job-meta-branch")?.querySelector(".lucide-git-branch")).not.toBeNull();
    card.click("job-meta-branch");
    expect(writeText).toHaveBeenCalledWith("t/billing-worker");
    expect(card.byTestId("job-meta-branch")?.querySelector(".lucide-check")).not.toBeNull();
    expect(card.byTestId("job-meta-branch")?.textContent).toContain("t/billing-worker");
    // The flash ends after a moment, and the branch icon comes back.
    act(() => vi.advanceTimersByTime(1_600));
    expect(card.byTestId("job-meta-branch")?.querySelector(".lucide-check")).toBeNull();
    expect(card.byTestId("job-meta-branch")?.querySelector(".lucide-git-branch")).not.toBeNull();
    card.unmount();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("switches to the Files tab from the diff stat chip and expands a file's diff", () => {
    const card = mountCard(richJob);
    expect(card.byTestId("job-panel-output")).not.toBeNull();
    card.click("job-meta-diff");
    expect(card.byTestId("job-panel-files")).not.toBeNull();
    expect(card.button("job-tab-files")?.getAttribute("aria-selected")).toBe("true");

    const files = card.byTestId("job-panel-files")?.querySelectorAll('[data-testid="job-file"]');
    expect(files).toHaveLength(3);
    expect(files?.[0]?.textContent).toContain("apps/api/src/billing/retry.ts");
    expect(files?.[0]?.textContent).toContain("+96");

    flushSync(() =>
      card
        .byTestId("job-panel-files")
        ?.querySelector<HTMLButtonElement>('[data-testid="job-file"] button')
        ?.click(),
    );
    const diff = card.byTestId("job-panel-files")?.querySelector('[data-testid="job-diff"]');
    expect(diff?.textContent).toContain("@@ -0,0 +1,3 @@");
    expect(diff?.textContent).toContain("+export const retry = 3;");
    expect(diff?.textContent).toContain(" context line");
    card.unmount();
  });

  it("lists the job's steps with kind, status and duration", () => {
    const card = mountCard(richJob);
    card.click("job-tab-steps");
    const steps = card.byTestId("job-panel-steps")?.querySelectorAll('[data-testid="job-step"]');
    expect(steps).toHaveLength(3);
    expect(steps?.[0]?.textContent).toContain("pnpm test billing");
    expect(steps?.[0]?.textContent).toContain("1.4s");
    expect(steps?.[1]?.textContent).toContain("80ms");
    // Expanding a step shows its detail.
    flushSync(() => steps?.[0]?.querySelector<HTMLButtonElement>("button")?.click());
    expect(steps?.[0]?.textContent).toContain("pnpm test billing --reporter=dot");
    card.unmount();
  });

  it("opens the inspector with full details, files and their diffs", () => {
    const card = mountCard(richJob);
    card.click("job-inspect");
    expect(card.dialog("job-dialog-output")?.textContent).toContain("Retried failed charges");
    expect(card.dialog("job-workspace-path")?.textContent).toContain(
      "/home/hitori/orca/worktrees/billing-worker",
    );
    expect(card.dialog("job-dialog-files")?.textContent).toContain("apps/api/src/billing/retry.ts");
    flushSync(() =>
      card
        .dialog("job-dialog-files")
        ?.querySelector<HTMLButtonElement>('[data-testid="job-file"] button')
        ?.click(),
    );
    expect(card.dialog("job-dialog-files")?.textContent).toContain("+export const retry = 3;");
    expect(card.dialog("job-dialog-steps")?.textContent).toContain("pnpm test billing");
    card.unmount();
  });

  it("steers a live job through the inline composer", async () => {
    const onJobAction = vi.fn(async () => undefined);
    const card = mountCard({ ...job, startedAt: 1_000_000 - 5_000 }, { onJobAction });
    card.click("job-steer");
    const input = card.byTestId("job-composer-input") as HTMLTextAreaElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "Focus on the failing unit test");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      card.click("job-composer-send");
      await Promise.resolve();
    });
    expect(onJobAction).toHaveBeenCalledWith(
      'Steer Orca job "mcp-job-card" (job-1): Focus on the failing unit test',
    );
    // The composer closes once the instruction is accepted.
    expect(card.byTestId("job-composer")).toBeNull();
    card.unmount();
  });

  it("follows up on a finished job with a bracketed instruction", async () => {
    const onJobAction = vi.fn(async () => undefined);
    const card = mountCard(
      { ...job, state: "finished", startedAt: 1_000_000 - 9_000, finishedAt: 1_000_000 },
      { onJobAction },
    );
    expect(card.button("job-steer")?.textContent).toBe("Follow up");
    card.click("job-steer");
    const input = card.byTestId("job-composer-input") as HTMLTextAreaElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "Ship it");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      card.click("job-composer-send");
      await Promise.resolve();
    });
    expect(onJobAction).toHaveBeenCalledWith("[Job: mcp-job-card (job-1)] Ship it");
    card.unmount();
  });

  it("opens the composer with the caret in it, sends on Enter and closes on Escape", async () => {
    const onJobAction = vi.fn(async () => undefined);
    const card = mountCard({ ...job, state: "finished", reply: "Done" }, { onJobAction });
    card.click("job-steer");
    const input = card.byTestId("job-composer-input") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "Add a changelog entry");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onJobAction).toHaveBeenCalledWith("[Job: mcp-job-card (job-1)] Add a changelog entry");

    // Reopening and pressing Escape closes it without sending anything more.
    card.click("job-steer");
    const reopened = card.byTestId("job-composer-input") as HTMLTextAreaElement;
    flushSync(() => {
      reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card.byTestId("job-composer")).toBeNull();
    expect(card.button("job-steer")?.getAttribute("aria-expanded")).toBe("false");
    card.unmount();
  });

  it("stops a live job and checks on a timed-out one", async () => {
    const stop = vi.fn(async () => undefined);
    const live = mountCard({ ...job, startedAt: 1_000_000 - 5_000 }, { onJobAction: stop });
    await act(async () => {
      live.click("job-stop");
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith('Stop Orca job "mcp-job-card" (job-1).');
    live.unmount();

    const check = vi.fn(async () => undefined);
    const timedOut = mountCard(
      { ...job, state: "timed_out", startedAt: 1_000_000 - 5_000 },
      { onJobAction: check },
    );
    await act(async () => {
      timedOut.click("job-status-check");
      await Promise.resolve();
    });
    expect(check).toHaveBeenCalledWith('Check status of Orca job "mcp-job-card" (job-1).');
    timedOut.unmount();
  });

  it("shows an inline error when an action fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("The chat is busy.");
    });
    const card = mountCard({ ...job, startedAt: 1_000_000 - 5_000 }, { onJobAction: failing });
    await act(async () => {
      card.click("job-stop");
      await Promise.resolve();
    });
    expect(card.byTestId("job-action-error")?.textContent).toBe("The chat is busy.");
    card.unmount();
  });

  it("hides its actions in a read-only thread", () => {
    const card = mountCard(richJob, { readOnly: true, onJobAction: async () => undefined });
    expect(card.button("job-steer")).toBeNull();
    expect(card.button("job-stop")).toBeNull();
    expect(card.button("job-inspect")).not.toBeNull();
    card.unmount();
  });

  it("keeps one copy and one inspect control on the card, and copies inside the inspector", () => {
    const card = mountCard(richJob);
    // The header owns the inspect control; the footer's duplicate is gone.
    expect(card.button("job-inspect")).not.toBeNull();
    expect(card.button("job-details")).toBeNull();
    // The card's output body has no copy of its own: the footer has the one copy button.
    expect(card.button("job-output-copy")).toBeNull();
    expect(card.button("job-copy")).not.toBeNull();
    // The inspector has no footer, so its output keeps its own copy button.
    card.click("job-inspect");
    expect(card.dialog("job-output-copy")).not.toBeNull();
    card.unmount();
  });

  it("flashes a check when the footer copies the job's output, then settles", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const card = mountCard(richJob);
    card.click("job-copy");
    expect(writeText).toHaveBeenCalledWith(richJob.reply?.trim());
    expect(card.button("job-copy")?.querySelector(".lucide-check")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_600));
    expect(card.button("job-copy")?.querySelector(".lucide-check")).toBeNull();
    expect(card.button("job-copy")?.querySelector(".lucide-copy")).not.toBeNull();
    card.unmount();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("hides its actions when nothing can take them", () => {
    const card = mountCard({ ...job, startedAt: 1_000_000 - 5_000 });
    expect(card.button("job-steer")).toBeNull();
    expect(card.button("job-stop")).toBeNull();
    card.unmount();
  });

  it("opens a bare job origin at its own job, encoding an id that carries separators", () => {
    const card = mountCard({ ...job, state: "finished", url: "https://code.example.test" });
    expect(card.byTestId("job-open")?.getAttribute("href")).toBe(
      "https://code.example.test/?job=job-1",
    );
    card.unmount();

    const composite = mountCard({
      ...job,
      jobId: "wt-1:term-2",
      state: "finished",
      url: "https://code.example.test/",
    });
    expect(composite.byTestId("job-open")?.getAttribute("href")).toBe(
      "https://code.example.test/?job=wt-1%3Aterm-2",
    );
    composite.unmount();
  });

  it("keeps a stored deep link byte for byte instead of adding a second route", () => {
    const explicit = mountCard({
      ...job,
      state: "finished",
      url: "https://code.example.test/?worktree=w1&tab=t1",
    });
    expect(explicit.byTestId("job-open")?.getAttribute("href")).toBe(
      "https://code.example.test/?worktree=w1&tab=t1",
    );
    explicit.unmount();

    const path = mountCard({ ...job, state: "finished", url: "https://code.example.test/job-1" });
    expect(path.byTestId("job-open")?.getAttribute("href")).toBe("https://code.example.test/job-1");
    path.unmount();
  });

  it("offers no Open link for a job that only reported a plaintext address", () => {
    const card = mountCard({
      ...job,
      jobId: "wt-1:term-2",
      state: "finished",
      url: "http://code.example.test",
    });
    expect(card.button("job-open")).toBeNull();
    card.unmount();
  });

  it("links only an https job and pull request", () => {
    const card = mountCard({
      ...job,
      state: "finished",
      reply: "Done",
      url: "https://code.example.test/job-1",
      prUrl: "https://github.com/rakazo/billing/pull/1",
    });
    expect(card.byTestId("job-open")?.getAttribute("href")).toBe("https://code.example.test/job-1");
    expect(card.byTestId("job-pr-link")?.getAttribute("href")).toBe(
      "https://github.com/rakazo/billing/pull/1",
    );
    card.unmount();

    const plain = mountCard({
      ...job,
      state: "finished",
      url: "http://127.0.0.1:3422",
      prUrl: "http://127.0.0.1:3422/pull/1",
    });
    expect(plain.byTestId("job-open")).toBeNull();
    expect(plain.byTestId("job-pr-link")).toBeNull();
    plain.unmount();
  });

  it("renders a legacy minimal card without empty tabs or a broken footer", () => {
    const card = mountCard({
      kind: "job",
      jobId: "orca-e2e-test",
      title: "orca-e2e-test",
      agent: "omp",
      branch: "t/orca-e2e-test",
      state: "finished",
      reply: "queue ok.",
      url: "https://code.example.test",
    });
    expect(card.byTestId("job-status")?.textContent).toContain("Finished");
    expect(card.byTestId("job-output")?.textContent).toContain("queue ok.");
    // One section, so no tab bar and no empty activity or file list.
    expect(card.button("job-tab-files")).toBeNull();
    expect(card.byTestId("job-panel-files")).toBeNull();
    expect(card.byTestId("job-meta-branch")?.textContent).toContain("t/orca-e2e-test");
    expect(card.byTestId("job-copy")).not.toBeNull();
    expect(card.byTestId("job-open")).not.toBeNull();
    card.unmount();
  });

  it("shows a paused job's command and question with no Yes/No gate", () => {
    const card = mountCard(
      {
        ...job,
        state: "needs_input",
        currentActivity: "bash: prisma migrate deploy",
        reply: "The migration drops three columns. Run it against production now?",
      },
      { onJobAction: async () => undefined },
    );
    // Pure automation: no manual approval gate anywhere on the card.
    expect(card.button("job-answer-yes")).toBeNull();
    expect(card.button("job-answer-no")).toBeNull();
    expect(card.button("job-answer-reply")).toBeNull();
    expect(card.text()).not.toContain("Yes, proceed");
    expect(card.text()).not.toContain("No, cancel");
    expect(card.text()).not.toContain("Waiting for confirmation");
    expect(card.text()).not.toContain("Waiting for input");

    // One quiet strip carries the command, and the question is the card's ordinary output.
    const note = card.byTestId("job-status-note");
    expect(note).not.toBeNull();
    expect(note?.className).toContain("border-warning/25");
    expect(card.byTestId("job-status-activity")?.textContent).toBe("bash: prisma migrate deploy");
    expect(note?.textContent).not.toContain("Run it against production now?");
    expect(card.byTestId("job-panel-output")?.textContent).toContain(
      "Run it against production now?",
    );
    expect(card.text().match(/Run it against production now\?/g)).toHaveLength(1);

    // The same footer as every other state: reply, stop, copy, open.
    expect(card.button("job-steer")?.textContent).toBe("Reply");
    expect(card.button("job-stop")?.textContent).toBe("Stop");
    expect(card.button("job-copy")).not.toBeNull();
    expect(card.button("job-open")).not.toBeNull();
    card.unmount();
  });

  it("states the job's error inside the quiet status strip, once, with no second banner", () => {
    const card = mountCard(
      { ...job, state: "needs_input", error: "The migration would drop three columns." },
      { onJobAction: async () => undefined },
    );
    expect(card.byTestId("job-status-note")).not.toBeNull();
    expect(card.byTestId("job-error")?.textContent).toBe("The migration would drop three columns.");
    expect(card.text().match(/The migration would drop three columns\./g)).toHaveLength(1);
    expect(card.button("job-answer-yes")).toBeNull();
    expect(card.button("job-steer")?.textContent).toBe("Reply");
    card.unmount();
  });

  it("keeps a bare paused job quiet, and stops it from the footer", async () => {
    const onJobAction = vi.fn(async () => undefined);
    const card = mountCard({ ...job, state: "needs_input" }, { onJobAction });
    expect(card.byTestId("job-status-note")?.textContent).toContain(
      "Paused, waiting for your reply…",
    );
    expect(card.byTestId("job-panel-output")).toBeNull();
    expect(card.button("job-steer")?.textContent).toBe("Reply");
    expect(card.button("job-stop")?.textContent).toBe("Stop");
    await act(async () => {
      card.click("job-stop");
      await Promise.resolve();
    });
    expect(onJobAction).toHaveBeenCalledWith('Stop Orca job "mcp-job-card" (job-1).');
    card.unmount();
  });

  it("replies to a needs_input job through the footer composer", async () => {
    const onJobAction = vi.fn(async () => undefined);
    const card = mountCard(
      { ...job, state: "needs_input", reply: "Deploy to production?" },
      { onJobAction },
    );
    expect(card.byTestId("job-composer")).toBeNull();
    card.click("job-steer");
    const input = card.byTestId("job-composer-input") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    // The composer opens in the footer, right under the controls that opened it.
    expect(card.byTestId("job-status-note")?.contains(input)).toBe(false);
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "Run it after lunch");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      card.click("job-composer-send");
      await Promise.resolve();
    });
    expect(onJobAction).toHaveBeenCalledWith("[Job: mcp-job-card (job-1)] Run it after lunch");
    expect(card.byTestId("job-composer")).toBeNull();
    card.unmount();
  });

  it("shows an inline error and re-enables Stop when a paused job's action fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("The chat is busy.");
    });
    const card = mountCard({ ...job, state: "needs_input" }, { onJobAction: failing });
    await act(async () => {
      card.click("job-stop");
      await Promise.resolve();
    });
    expect(card.byTestId("job-action-error")?.textContent).toBe("The chat is busy.");
    expect(card.button("job-stop")?.disabled).toBe(false);
    card.unmount();
  });

  it("hides the paused job's controls in a read-only thread but keeps its context", () => {
    const card = mountCard(
      {
        ...job,
        state: "needs_input",
        currentActivity: "bash: prisma migrate deploy",
        reply: "Deploy to production?",
      },
      { readOnly: true, onJobAction: async () => undefined },
    );
    expect(card.byTestId("job-status-activity")?.textContent).toBe("bash: prisma migrate deploy");
    expect(card.byTestId("job-panel-output")?.textContent).toContain("Deploy to production?");
    expect(card.button("job-steer")).toBeNull();
    expect(card.button("job-stop")).toBeNull();
    expect(card.button("job-open")).not.toBeNull();
    expect(card.text()).toContain("Needs input");
    card.unmount();
  });

  it("renders the summary as the subtitle and never falls back to the job id", () => {
    const rich = mountCard(richJob);
    expect(rich.text()).toContain("Retry failed charges before the invoice closes");
    rich.unmount();

    const bare = mountCard({
      kind: "job",
      jobId: "job-id-only",
      title: "Bare job",
      state: "working",
    });
    expect(bare.text()).toContain("Bare job");
    // No summary, so the header carries no subtitle — and certainly not the job id.
    expect(bare.text()).not.toContain("job-id-only");
    bare.unmount();
  });
});
