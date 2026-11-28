// @vitest-environment jsdom
import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, Suspense } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolStep } from "../../lib/chat/checkpoint-graph";
import type { ActivityPanelProps } from "./ActivityPanel";
import {
  ActivityOnlyNarration,
  ActivityPanel,
  LiveRunMonitorCard,
  StandaloneActivity,
} from "./ActivityPanel";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    value === 1 ? one : other.replace("#", String(value)),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

const thinking = (lines: string[], durationMs = 2_000): MessageBlock => ({
  kind: "thinking",
  lines,
  durationMs,
});

const step = (label: string, overrides: Partial<ToolStep> = {}): ToolStep => ({
  label,
  count: 1,
  ...overrides,
});

const stepsBlock = (
  steps: ToolStep[],
  extra: Partial<Extract<MessageBlock, { kind: "steps" }>> = {},
): MessageBlock => ({
  kind: "steps",
  steps,
  ...extra,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderPanel(props: ActivityPanelProps) {
  act(() => {
    flushSync(() =>
      root.render(
        <Suspense fallback={null}>
          <ActivityPanel {...props} />
        </Suspense>,
      ),
    );
  });
}

function panelRoot(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="tool-activity"]');
  if (!el) throw new Error('Missing [data-testid="tool-activity"]');
  return el;
}

function triggerButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-testid="activity-trigger"]');
  if (!el) throw new Error('Missing [data-testid="activity-trigger"]');
  return el;
}

describe("ActivityPanel", () => {
  it("renders expanded Monitor card while live with model title, cost, clock, segments, and Cancel", () => {
    const onStop = vi.fn();
    renderPanel({
      live: true,
      blocks: [
        stepsBlock([
          step("Compared 38 commits", {
            startedAtMs: 1_000,
            durationMs: 2_300,
            status: "done",
            detail: "git log v3.1..main",
          }),
          step("Drafting the release notes", {
            startedAtMs: 3_500,
            status: "running",
          }),
        ]),
      ],
      runMeta: {
        botName: "Release agent",
        modelId: "claude-opus-5-5",
        costUsd: 0.039,
        startedAt: new Date(Date.now() - 6_000).toISOString(),
        status: "running",
      },
      onStop,
    });

    const panel = panelRoot();
    expect(panel.className).toContain("@container");
    expect(panel.className).toContain("w-full");
    expect(panel.className).not.toContain("max-w-[440px]");
    expect(triggerButton().getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("Claude Opus 5.5");
    expect(panel.textContent).toContain("Release agent");
    expect(panel.textContent).toContain("$0.039");
    expect(panel.textContent).toContain("Running");
    expect(panel.textContent).toContain("Drafting the release notes");
    expect(panel.textContent).toContain("Compared 38 commits");
    expect(panel.querySelector('[data-testid="tool-rows"]')?.textContent).toContain(
      "git log v3.1..main",
    );
    expect(panel.textContent).toContain("2.3s");
    expect(panel.textContent).toContain("1/2");
    expect(panel.querySelectorAll('[aria-label="Step timeline progress"] button')).toHaveLength(2);

    const cancelButton = Array.from(panel.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Cancel"),
    );
    expect(cancelButton).toBeTruthy();
    act(() => {
      cancelButton?.click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps manual collapse across live updates and renders settled turns as a collapsed pill", () => {
    const firstBlocks = [stepsBlock([step("Open calendar"), step("Read events")])];
    renderPanel({
      live: true,
      blocks: firstBlocks,
      runMeta: { modelId: "claude-opus-5-5", costUsd: 0.015 },
    });

    act(() => {
      triggerButton().click();
    });
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");

    renderPanel({
      live: true,
      blocks: [stepsBlock([step("Open calendar"), step("Read events"), step("Check conflicts")])],
      runMeta: { modelId: "claude-opus-5-5", costUsd: 0.022 },
    });
    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
    expect(panelRoot().textContent).toContain("$0.022");

    const sevenSteps = [
      "Open calendar",
      "Read events",
      "Search inbox",
      "Read message",
      "Check zones",
      "Draft invite",
      "Check conflicts",
    ].map((label, idx) => step(label, { status: "done", durationMs: 1_500 + idx * 100 }));

    renderPanel({
      live: false,
      blocks: [stepsBlock(sevenSteps, { durationMs: 12_400, costUsd: 0.055 })],
      runMeta: { modelId: "claude-opus-5-5", status: "completed" },
    });

    expect(triggerButton().getAttribute("aria-expanded")).toBe("false");
    const panel = panelRoot();
    expect(panel.querySelector('[data-testid="tool-rows"]')).toBeNull();
    expect(panel.textContent).toContain("Claude Opus 5.5");
    expect(panel.textContent).toContain("+2");
    expect(panel.textContent).toContain("$0.055");
    expect(panel.textContent).toContain("0:12");

    act(() => {
      triggerButton().click();
    });
    expect(triggerButton().getAttribute("aria-expanded")).toBe("true");
    expect(panel.querySelector('[data-testid="tool-rows"]')).not.toBeNull();
  });

  it("renders expanded completed summary without duplicate duration or footer category text", () => {
    renderPanel({
      live: false,
      blocks: [
        stepsBlock([step("Shell", { detail: "git status", durationMs: 4_000, status: "done" })], {
          durationMs: 4_000,
          costUsd: 0.01,
        }),
      ],
      runMeta: { modelId: "claude-opus-5-5", status: "completed" },
    });
    act(() => {
      triggerButton().click();
    });
    const completedText = panelRoot().textContent ?? "";
    expect(completedText).not.toContain("Finished in");
    expect(completedText).not.toContain("Terminal");
    expect(completedText).toContain("ran a command");
    expect(completedText).toContain("git status");
    expect(completedText).toContain("0:04");
  });

  it("renders a one-line thought without a trigger and expands a multi-line thought on click", () => {
    renderPanel({
      live: true,
      blocks: [thinking(["Checking the calendar."]), stepsBlock([step("Open calendar")])],
    });
    expect(container.querySelector('[data-testid="thinking-row"]')?.textContent).toContain(
      "Checking the calendar.",
    );
    expect(container.querySelector('[data-testid="thinking-trigger"]')).toBeNull();

    renderPanel({
      live: true,
      blocks: [
        thinking(["Checking the calendar.", "Comparing Tuesday afternoon slots."]),
        stepsBlock([step("Open calendar")]),
      ],
    });
    const thinkTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="thinking-trigger"]',
    );
    expect(thinkTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="thinking-detail"]')).toBeNull();

    act(() => {
      thinkTrigger?.click();
    });
    expect(thinkTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="thinking-detail"]')?.textContent).toContain(
      "Comparing Tuesday afternoon slots.",
    );
  });

  it("opens Step Inspector popover with timing/share/note/detail and supports Escape close and Rewind", async () => {
    const onRewind = vi.fn(async () => undefined);
    const firstStep = step("Compared 38 commits", {
      startedAtMs: 1_000,
      durationMs: 2_300,
      status: "done",
      detail: "git log v3.1..main",
      note: "Found **3 release PRs** to include.",
    });
    const secondStep = step("Drafted release notes", {
      startedAtMs: 3_500,
      durationMs: 2_700,
      status: "done",
    });

    renderPanel({
      live: true,
      blocks: [stepsBlock([firstStep, secondStep])],
      runMeta: {
        startedAt: new Date(1_000).toISOString(),
        costUsd: 0.039,
      },
      onRewind,
    });

    const segmentButton = panelRoot().querySelector<HTMLButtonElement>(
      '[aria-label="Step timeline progress"] button[aria-label="Compared 38 commits"]',
    );
    expect(segmentButton).not.toBeNull();

    act(() => {
      segmentButton?.click();
    });

    const dialog = panelRoot().querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("Step inspector: Compared 38 commits");
    expect(dialog?.textContent).toContain("Started");
    expect(dialog?.textContent).toContain("Took");
    expect(dialog?.textContent).toContain("2.3s");
    expect(dialog?.textContent).toContain("Share");
    expect(dialog?.textContent).toContain("State");
    expect(dialog?.textContent).toContain("Done");
    expect(dialog?.textContent).toContain("Found 3 release PRs to include.");
    expect(dialog?.textContent).toContain("git log v3.1..main");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panelRoot().querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      segmentButton?.click();
    });
    const rewindButton = Array.from(
      panelRoot().querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((button) => button.textContent?.includes("Rewind to here"));
    expect(rewindButton).toBeTruthy();

    await act(async () => {
      rewindButton?.click();
      await Promise.resolve();
    });
    expect(onRewind).toHaveBeenCalledWith(0, firstStep);
    expect(panelRoot().querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders Needs you approval banner and handles Allow/Decline buttons and keyboard shortcuts", async () => {
    const onAnswer = vi.fn(async () => undefined);
    renderPanel({
      live: false,
      blocks: [
        stepsBlock([step("Built preview", { durationMs: 2_600, status: "done" })], {
          costUsd: 0.055,
        }),
      ],
      runMeta: {
        botName: "Release agent",
        modelId: "claude-opus-5-5",
        status: "waiting_input",
      },
      pendingApproval: {
        canAnswer: true,
        block: {
          kind: "ask",
          text: "Ready to ship",
          detail: "gh release create v3.2.0",
          actions: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Decline" },
          ],
        },
        onAnswer,
      },
    });

    const panel = panelRoot();
    expect(triggerButton().getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("Needs you");
    expect(panel.textContent).toContain("Ready to ship");
    expect(panel.querySelector("code")?.textContent).toBe("gh release create v3.2.0");

    const allowButton = panel.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Enter"]');
    const declineButton = panel.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="Escape"]',
    );
    expect(allowButton?.querySelector('[aria-hidden="true"]')?.textContent).toBe("↵");
    expect(declineButton?.querySelector('[aria-hidden="true"]')?.textContent).toBe("Esc");

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onAnswer).not.toHaveBeenCalled();
    input.remove();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith("allow");

    await act(async () => {
      declineButton?.click();
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith("deny");
  });

  it("renders multi-attempt SVG git-graph with Stopped branch and Attempt 2 badge and supports row Rewind", async () => {
    const onRewind = vi.fn(async () => undefined);
    const branchStep1 = step("Open calendar", { attempt: 1, status: "done", durationMs: 1_100 });
    const branchStep2 = step("Read old inbox", { attempt: 1, status: "stopped", durationMs: 900 });
    const retryStep = step("Compare updated slots", {
      attempt: 2,
      forkedFromStep: 0,
      status: "done",
      durationMs: 1_800,
    });

    renderPanel({
      live: true,
      blocks: [
        stepsBlock([branchStep1, branchStep2, retryStep], {
          attempts: 2,
          costUsd: 0.064,
        }),
      ],
      onRewind,
    });

    const toolRows = container.querySelector('[data-testid="tool-rows"]');
    expect(toolRows?.querySelector("svg")).not.toBeNull();
    expect(toolRows?.textContent).toContain("Stopped");
    expect(toolRows?.textContent).toContain("Attempt 2");
    expect(panelRoot().textContent).toContain("2 attempts");

    const rewindBtn = toolRows?.querySelector<HTMLButtonElement>(
      'button[aria-label="Rewind to Open calendar"]',
    );
    expect(rewindBtn).not.toBeNull();

    await act(async () => {
      rewindBtn?.click();
      await Promise.resolve();
    });
    expect(onRewind).toHaveBeenCalledWith(0, branchStep1);
  });

  it("opens the lazy RunLogSheet with execution trace and reasoning when Log is clicked", async () => {
    renderPanel({
      live: true,
      blocks: [
        thinking(["Planning release tag."]),
        stepsBlock([step("Checked tags", { durationMs: 1_400, status: "done" })]),
      ],
      runMeta: { modelId: "claude-opus-5-5", costUsd: 0.012 },
    });

    const logButton = panelRoot().querySelector<HTMLButtonElement>(
      'button[aria-label="Open execution log"]',
    );
    expect(logButton).not.toBeNull();

    act(() => {
      logButton?.click();
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Execution trace");
    });
    expect(document.body.textContent).toContain("Reasoning");
    expect(document.body.textContent).toContain("Planning release tag.");
    expect(document.body.textContent).toContain("Checked tags");
  });

  it("renders StandaloneActivity, ActivityOnlyNarration, and LiveRunMonitorCard wrappers", () => {
    act(() => {
      flushSync(() =>
        root.render(
          <Suspense fallback={null}>
            <StandaloneActivity
              blocks={[stepsBlock([step("Shell")], { durationMs: 4_000 })]}
              live={false}
            />
            <ActivityOnlyNarration
              blocks={[
                thinking(["Checking the calendar."]),
                stepsBlock([step("Open calendar")], { durationMs: 12_000 }),
              ]}
              live={false}
            />
            <LiveRunMonitorCard
              runMeta={{ botName: "Chief", modelId: "claude-opus-5-5" }}
              label="Preparing run…"
            />
          </Suspense>,
        ),
      );
    });

    expect(container.querySelectorAll('[data-testid="tool-activity-line"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(3);
    expect(container.textContent).toContain("Preparing run…");
  });

  it("shows the active step detail in the live status banner for code_mode runs", () => {
    renderPanel({
      live: true,
      blocks: [
        stepsBlock([
          step("Code mode", {
            startedAtMs: 1_000,
            status: "running",
            detail: "cmd.weekly_report, list_fleet",
          }),
        ]),
      ],
      runMeta: { modelId: "claude-opus-5-5", status: "running" },
    });

    const bannerCode = panelRoot().querySelector("code");
    expect(bannerCode?.textContent).toBe("cmd.weekly_report, list_fleet");
  });

  it("renders called and active skills in the card, timeline, inspector, and RunLogSheet", async () => {
    renderPanel({
      live: true,
      blocks: [
        stepsBlock(
          [
            step("Skill read", {
              startedAtMs: 1_000,
              durationMs: 400,
              status: "done",
              detail: "pr-watch",
            }),
            step("Code mode", {
              startedAtMs: 1_500,
              status: "running",
              detail: "skill_read, shell",
              skills: ["deploy-check"],
            }),
          ],
          { skills: ["Weekly report"] },
        ),
      ],
      runMeta: { modelId: "claude-opus-5-5", status: "running" },
    });

    const panel = panelRoot();
    const skillsRow = panel.querySelector('[data-testid="activity-skills"]');
    expect(skillsRow?.textContent).toContain("Skills");
    expect(skillsRow?.textContent).toContain("Weekly report");
    expect(skillsRow?.textContent).toContain("pr-watch");
    expect(skillsRow?.textContent).toContain("deploy-check");

    // Only deploy-check is on the currently running step, so only its chip has the live pulse dot.
    const chips = Array.from(skillsRow?.children ?? []).slice(1);
    const activeChip = chips.find((el) => el.textContent?.includes("deploy-check"));
    const doneChip = chips.find((el) => el.textContent?.includes("pr-watch"));
    expect(activeChip?.querySelector(".animate-pulse")).not.toBeNull();
    expect(doneChip?.querySelector(".animate-pulse")).toBeNull();

    // Code mode timeline row shows its inline skill badge.
    const toolRows = panel.querySelector('[data-testid="tool-rows"]');
    expect(toolRows?.textContent).toContain("deploy-check");

    // Clicking the Code mode row opens StepInspectorPopover with Skills.
    const codeModeBtn = Array.from(
      toolRows?.querySelectorAll<HTMLButtonElement>("button[data-step-inspector-trigger]") ?? [],
    ).find((btn) => btn.textContent?.includes("Code mode"));
    act(() => {
      codeModeBtn?.click();
    });
    expect(panel.querySelector('[data-testid="step-inspector-skills"]')?.textContent).toContain(
      "deploy-check",
    );

    // Opening RunLogSheet shows the Skills section.
    const logButton = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Open execution log"]',
    );
    act(() => {
      logButton?.click();
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Execution trace");
    });
    expect(document.body.textContent).toContain("Weekly report");
    expect(document.body.textContent).toContain("pr-watch");
    expect(document.body.textContent).toContain("deploy-check");
  });

  it("omits the skills row when no skills were called and summarizes legacy skill_read on settled cards", () => {
    renderPanel({
      live: true,
      blocks: [stepsBlock([step("Shell", { detail: "ls", status: "running" })])],
      runMeta: { modelId: "claude-opus-5-5", status: "running" },
    });
    expect(panelRoot().querySelector('[data-testid="activity-skills"]')).toBeNull();

    renderPanel({
      live: false,
      blocks: [
        stepsBlock([
          step("Skill read", { detail: "Tasks", status: "done", durationMs: 200 }),
          step("Shell", { detail: "gh pr view", status: "done", durationMs: 1_500 }),
        ]),
      ],
      runMeta: { modelId: "claude-opus-5-5", status: "completed" },
    });
    act(() => {
      triggerButton().click();
    });
    expect(panelRoot().textContent).toContain("used a skill");
    expect(panelRoot().querySelector('[data-testid="activity-skills"]')?.textContent).toContain(
      "Tasks",
    );
  });
});
