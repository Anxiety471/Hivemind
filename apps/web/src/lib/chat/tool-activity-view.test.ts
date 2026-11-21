import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activityBlocks,
  activityDurationMs,
  activityStepCount,
  activitySummaryParts,
  isToolOnlyNarration,
  latestActivity,
  messageHasVisibleBlocks,
  renderableMessageBlocks,
  STEP_DETAIL_EXPAND_THRESHOLD,
  stepDisplayInfo,
  toolStepCount,
} from "./tool-activity-view";

const stepsBlock: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const stepsNoDuration: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 1 }] };
const textBlock: MessageBlock = { kind: "text", text: "Here you go." };
const liveActivity: MessageBlock = { kind: "progress", text: "Using shell", activity: true };
const narration: MessageBlock = { kind: "progress", text: "Let me check that." };
const thinkingBlock: MessageBlock = {
  kind: "thinking",
  durationMs: 1_200,
  lines: ["Checking the totals.", "They match."],
};

describe("tool step count", () => {
  it("sums each row's count", () => {
    expect(toolStepCount([{ count: 1 }, { count: 3 }])).toBe(4);
    expect(toolStepCount([])).toBe(0);
  });
});

describe("activity selection", () => {
  it("picks the reasoning and steps blocks in order", () => {
    const blocks = [textBlock, thinkingBlock, stepsBlock, liveActivity, narration];
    expect(activityBlocks(blocks)).toEqual([thinkingBlock, stepsBlock]);
  });

  it("counts every tool call behind the panel's steps rows", () => {
    const extra: MessageBlock = { kind: "steps", steps: [{ label: "Save", count: 3 }] };
    expect(activityStepCount([thinkingBlock, stepsBlock, extra])).toBe(5);
    expect(activityStepCount([thinkingBlock])).toBe(0);
  });

  it("takes the run time from the steps block that kept it", () => {
    expect(activityDurationMs([thinkingBlock, stepsBlock])).toBeUndefined();
    expect(
      activityDurationMs([thinkingBlock, stepsBlock, { ...stepsNoDuration, durationMs: 900 }]),
    ).toBe(900);
  });
});

describe("activity summary parts", () => {
  it("counts recognized actions and keeps the readable order", () => {
    const blocks: MessageBlock = {
      kind: "steps",
      steps: [
        { label: "Web search", count: 2 },
        { label: "Web fetch", count: 1 },
        { label: "Shell", count: 3 },
      ],
    };
    expect(activitySummaryParts([blocks])).toEqual([
      { kind: "pages", count: 1 },
      { kind: "search", count: 2 },
      { kind: "commands", count: 3 },
    ]);
  });

  it("adds up an action split across steps blocks", () => {
    const first: MessageBlock = { kind: "steps", steps: [{ label: "Web fetch", count: 1 }] };
    const second: MessageBlock = { kind: "steps", steps: [{ label: "Web fetch", count: 2 }] };
    expect(activitySummaryParts([first, thinkingBlock, second])).toEqual([
      { kind: "pages", count: 3 },
    ]);
  });

  it("leaves unrecognized calls to the plain latest line", () => {
    expect(
      activitySummaryParts([{ kind: "steps", steps: [{ label: "Open calendar", count: 1 }] }]),
    ).toEqual([]);
    expect(activitySummaryParts([thinkingBlock])).toEqual([]);
  });

  it("keeps a summary to the clauses a trigger can read", () => {
    const blocks: MessageBlock = {
      kind: "steps",
      steps: [
        { label: "Web fetch", count: 1 },
        { label: "Web search", count: 1 },
        { label: "Shell", count: 1 },
        { label: "Write file", count: 1 },
      ],
    };
    expect(activitySummaryParts([blocks])).toHaveLength(3);
  });
});

describe("latest activity sentence", () => {
  it("reads the newest activity block only", () => {
    expect(latestActivity([stepsBlock])).toBe("Shell ×2");
    expect(latestActivity([thinkingBlock, stepsBlock])).toBe("Shell ×2");
    expect(latestActivity([stepsBlock, thinkingBlock])).toBe("They match.");
    expect(latestActivity([thinkingBlock, liveActivity])).toBe("Using shell");
  });

  it("ignores authored narration and message text", () => {
    expect(latestActivity([textBlock, narration])).toBeUndefined();
  });

  it("keeps the last non-empty reasoning line, and no empty one", () => {
    const empty: MessageBlock = { kind: "thinking", durationMs: 1, lines: ["", "  "] };
    expect(latestActivity([empty])).toBeUndefined();
    expect(latestActivity([thinkingBlock])).toBe("They match.");
  });
});

describe("visible blocks under the activity preference", () => {
  it("keeps text order and drops hidden activity per preference", () => {
    const blocks = [textBlock, stepsBlock, liveActivity, narration];
    expect(renderableMessageBlocks(blocks, true)).toEqual([textBlock, stepsBlock, narration]);
    expect(renderableMessageBlocks(blocks, false)).toEqual([textBlock, narration]);
    expect(renderableMessageBlocks([thinkingBlock], true)).toEqual([thinkingBlock]);
    expect(renderableMessageBlocks([thinkingBlock], false)).toEqual([]);
  });

  it("never surfaces a progress block marked as activity", () => {
    expect(messageHasVisibleBlocks([liveActivity], true)).toBe(false);
    expect(messageHasVisibleBlocks([liveActivity], false)).toBe(false);
  });

  it("keeps an activity-only message visible only when the preference is on", () => {
    expect(messageHasVisibleBlocks([stepsNoDuration], true)).toBe(true);
    expect(messageHasVisibleBlocks([stepsNoDuration], false)).toBe(false);
    expect(messageHasVisibleBlocks([thinkingBlock], true)).toBe(true);
    expect(messageHasVisibleBlocks([textBlock], false)).toBe(true);
  });
});

describe("activity-only narration", () => {
  it("is true for a live run that has only reasoned or called tools", () => {
    expect(isToolOnlyNarration([liveActivity, stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([thinkingBlock], true)).toBe(true);
    expect(isToolOnlyNarration([thinkingBlock, stepsNoDuration], true)).toBe(true);
  });

  it("is false once the bot has written something, or when activity is hidden", () => {
    expect(isToolOnlyNarration([stepsBlock, textBlock], true)).toBe(false);
    expect(isToolOnlyNarration([narration, liveActivity, stepsBlock], true)).toBe(false);
    expect(isToolOnlyNarration([liveActivity, stepsBlock], false)).toBe(false);
    expect(isToolOnlyNarration([liveActivity], true)).toBe(false);
    expect(isToolOnlyNarration([thinkingBlock], false)).toBe(false);
  });
});

describe("a retired import checklist", () => {
  const item = { kind: "routine" as const, routineId: "routine-1", name: "morning" };
  const retired: MessageBlock[] = [
    // As Undo leaves it now, and as a marked one written before items were emptied.
    { kind: "import_setup", items: [], undone: true },
    { kind: "import_setup", items: [item], undone: true },
    { kind: "import_setup", items: [] },
  ];

  it("gives its message no row, in either tool-activity mode", () => {
    for (const block of retired) {
      for (const showToolActivity of [true, false]) {
        expect(messageHasVisibleBlocks([block], showToolActivity)).toBe(false);
        expect(renderableMessageBlocks([block], showToolActivity)).toEqual([]);
      }
    }
  });

  it("still shows a live checklist and anything beside a retired one", () => {
    const live: MessageBlock = { kind: "import_setup", items: [item] };
    expect(messageHasVisibleBlocks([live], false)).toBe(true);
    expect(renderableMessageBlocks([retired[0]!, textBlock], false)).toEqual([textBlock]);
  });
});

describe("stepDisplayInfo", () => {
  it("extracts hostnames for fetched and navigated URLs", () => {
    expect(stepDisplayInfo({ label: "Web fetch", detail: "https://www.bend-lang.com/" })).toEqual({
      action: { kind: "fetch", host: "bend-lang.com" },
      target: "https://www.bend-lang.com/",
      detail: "https://www.bend-lang.com/",
      expandable: false,
    });
    expect(
      stepDisplayInfo({
        label: "Browser navigate",
        detail: "https://github.com/HigherOrderCO/Bend",
      }),
    ).toEqual({
      action: { kind: "browser_navigate", host: "github.com" },
      target: "https://github.com/HigherOrderCO/Bend",
      detail: "https://github.com/HigherOrderCO/Bend",
      expandable: false,
    });
  });

  it("maps file, search, and shell steps and leaves unknown tools verbatim", () => {
    expect(stepDisplayInfo({ label: "Web search", detail: "Bend language" })).toMatchObject({
      action: { kind: "search" },
      target: "Bend language",
      expandable: false,
    });
    expect(stepDisplayInfo({ label: "Write file", detail: "src/app.ts" })).toMatchObject({
      action: { kind: "write_file", hasTarget: true },
      target: "src/app.ts",
    });
    expect(stepDisplayInfo({ label: "Shell", detail: "pnpm test" })).toMatchObject({
      action: { kind: "shell", hasTarget: true },
      target: "pnpm test",
    });
    expect(stepDisplayInfo({ label: "Open calendar" })).toMatchObject({
      action: { kind: "raw", label: "Open calendar" },
      expandable: false,
    });
  });

  it("marks steps expandable when they carry a note or a long detail", () => {
    expect(
      stepDisplayInfo({ label: "Web search", detail: "short query", note: "Checking results." }),
    ).toMatchObject({ target: "short query", expandable: true });
    expect(
      stepDisplayInfo({ label: "Shell", detail: "x".repeat(STEP_DETAIL_EXPAND_THRESHOLD + 1) }),
    ).toMatchObject({ expandable: true });
  });
});
