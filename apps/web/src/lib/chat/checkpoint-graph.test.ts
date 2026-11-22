import { describe, expect, it } from "vitest";
import type { ToolStep } from "./checkpoint-graph";
import {
  buildCheckpointGraph,
  formatClockDuration,
  formatCostUsd,
  formatModelTitle,
  formatStepDuration,
  stepCategory,
} from "./checkpoint-graph";

describe("checkpoint formatting helpers", () => {
  it("formats elapsed clocks, step durations, costs, and generic model titles", () => {
    expect(formatClockDuration(0)).toBe("0:00");
    expect(formatClockDuration(8_900)).toBe("0:08");
    expect(formatClockDuration(74_000)).toBe("1:14");

    expect(formatStepDuration(45)).toBe("45ms");
    expect(formatStepDuration(2_340)).toBe("2.3s");
    expect(formatStepDuration(65_000)).toBe("1m 5s");

    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.055)).toBe("$0.055");
    expect(formatCostUsd(1.256)).toBe("$1.26");
    expect(formatCostUsd(null)).toBe("");

    expect(formatModelTitle("provider/claude-opus-5-5-20260101", "Bot")).toBe("Claude Opus 5.5");
    expect(formatModelTitle("", "Release agent")).toBe("Release agent");
  });

  it("categorizes humanized step labels cleanly", () => {
    expect(stepCategory("Shell", "pnpm build")).toBe("terminal");
    expect(stepCategory("Compared commits", "v3.1...main")).toBe("git");
    expect(stepCategory("Drafted the release notes", "Releases / v3.2")).toBe("docs");
    expect(stepCategory("Collected 14 issues")).toBe("search");
    expect(stepCategory("Web fetch", "https://example.com")).toBe("web");
  });
});

describe("buildCheckpointGraph", () => {
  it("assigns lanes, fork roots, shares, and attempt badges across rewound branches", () => {
    const steps: ToolStep[] = [
      {
        label: "Compared commits",
        count: 1,
        detail: "v3.1...main",
        startedAtMs: 1_000,
        durationMs: 2_300,
        attempt: 1,
        status: "done",
      },
      {
        label: "Drafted notes",
        count: 1,
        startedAtMs: 3_300,
        durationMs: 2_800,
        attempt: 1,
        status: "stopped",
      },
      {
        label: "Build preview",
        count: 1,
        startedAtMs: 6_100,
        durationMs: 2_600,
        attempt: 1,
        status: "stopped",
      },
      {
        label: "Drafted notes",
        count: 1,
        startedAtMs: 9_000,
        durationMs: 2_300,
        attempt: 2,
        forkedFromStep: 0,
        status: "done",
      },
      {
        label: "Build preview",
        count: 1,
        startedAtMs: 11_300,
        attempt: 2,
        status: "running",
      },
    ];

    const graph = buildCheckpointGraph(steps, {
      runStartedAtMs: 1_000,
      runAttempts: 2,
      runStatus: "running",
      nowMs: 13_300,
    });

    expect(graph.hasBranching).toBe(true);
    expect(graph.totalAttempts).toBe(2);
    expect(graph.maxLane).toBe(1);
    expect(graph.nodes[0]).toMatchObject({
      lane: 0,
      state: "done",
      startedOffsetMs: 0,
      isAbandonedBranch: false,
    });
    expect(graph.nodes[1]).toMatchObject({
      lane: 1,
      state: "stopped",
      isAbandonedBranch: true,
      isBranchRoot: true,
      forkFromIndex: 0,
    });
    expect(graph.nodes[2]).toMatchObject({
      lane: 1,
      state: "stopped",
      isAbandonedBranch: true,
      isBranchRoot: false,
    });
    expect(graph.nodes[3]).toMatchObject({
      lane: 0,
      state: "done",
      attemptBadge: 2,
      forkFromIndex: 0,
      isAbandonedBranch: false,
    });
    expect(graph.nodes[4]).toMatchObject({
      lane: 0,
      state: "running",
      durationMs: 2_000,
    });
    expect(graph.completedCount).toBe(2);
    expect(graph.totalCount).toBe(3);
  });
});
