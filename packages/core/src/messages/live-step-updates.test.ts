import { describe, expect, it } from "vitest";
import { appendToolCallSegment, projectMessages, withToolStepOutcomes } from "./events.js";

describe("live and finalized step skill tracking", () => {
  it("tracks and deduplicates called skills across live events, completions, and outcomes", () => {
    const projected = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: {
          name: "code_mode",
          detail: "skill_read, shell",
          skills: ["pr-watch"],
          runSkills: ["Weekly report"],
          startedAtMs: 1_000,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.completed",
        runId: "r1",
        payload: {
          name: "code_mode",
          durationMs: 300,
          outcome: "succeeded",
          detail: "skill_read, shell",
          skills: ["PR-Watch", "deploy-check"],
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(projected[0]?.blocks).toEqual([
      {
        kind: "steps",
        skills: ["Weekly report", "pr-watch", "deploy-check"],
        steps: [
          {
            label: "Code mode",
            count: 1,
            detail: "skill_read, shell",
            skills: ["pr-watch", "deploy-check"],
            startedAtMs: 1_000,
            durationMs: 300,
            status: "done",
          },
        ],
      },
    ]);

    const finalized = withToolStepOutcomes(
      appendToolCallSegment([], "code_mode", "skill_read", { startedAtMs: 1_000 }, ["pr-watch"]),
      [
        {
          label: "Code mode",
          outcome: "succeeded",
          durationMs: 300,
          startedAtMs: 1_000,
          skills: ["deploy-check", "PR-WATCH"],
        },
      ],
      ["Weekly report"],
    );
    expect(finalized).toEqual([
      {
        kind: "steps",
        skills: ["pr-watch", "Weekly report", "deploy-check"],
        steps: [
          {
            label: "Code mode",
            count: 1,
            detail: "skill_read",
            skills: ["pr-watch", "deploy-check"],
            startedAtMs: 1_000,
            durationMs: 300,
            status: "done",
            outcomes: { succeeded: 1 },
          },
        ],
      },
    ]);
  });
});
