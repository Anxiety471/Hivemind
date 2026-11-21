import { describe, expect, it } from "vitest";
import {
  helperCardMessageId,
  helperThreadParams,
  helperThreadStatus,
  helperThreadStatusAfterEvent,
  helperThreadTarget,
  helperThreadTargetFromParams,
} from "./helper-thread";

describe("helper card lookup", () => {
  it("names a saved card's thread, but not a live turn's synthetic card", () => {
    expect(helperCardMessageId({ id: "message-1", botId: "bot-1" })).toBe("message-1");
    expect(helperCardMessageId({ id: "subagent:run-1", botId: "bot-1" })).toBeUndefined();
    expect(helperCardMessageId({ id: "message-1" })).toBeUndefined();
  });
});

describe("helper thread target", () => {
  it("keeps a stopped helper apart from a failed one", () => {
    expect(
      helperThreadTarget("message-1", { name: "Scout", status: "failed", result: "stopped" }),
    ).toEqual({ messageId: "message-1", name: "Scout", task: "", status: "stopped" });
    expect(
      helperThreadTarget("message-1", { name: "Scout", status: "failed", result: "no access" }),
    ).toEqual({ messageId: "message-1", name: "Scout", task: "", status: "failed" });
  });

  it("carries the card's terminal status and omits an empty task from the route", () => {
    expect(
      helperThreadParams(
        helperThreadTarget("message-1", {
          name: "Scout",
          task: "read the logs",
          status: "running",
        }),
      ),
    ).toEqual({
      messageId: "message-1",
      name: "Scout",
      task: "read the logs",
      status: "running",
    });
    expect(
      helperThreadParams({ messageId: "m", name: "N", task: "", status: "completed" }),
    ).toEqual({ messageId: "m", name: "N", status: "completed" });
  });

  it("reads pushed params, including arrays, and defaults an unknown status to running", () => {
    expect(
      helperThreadTargetFromParams({
        messageId: ["message-1"],
        name: " Scout ",
        task: "read",
        status: "stopped",
      }),
    ).toEqual({ messageId: "message-1", name: "Scout", task: "read", status: "stopped" });
    expect(helperThreadTargetFromParams({ messageId: "message-1", status: "weird" })).toEqual({
      messageId: "message-1",
      name: "",
      task: "",
      status: "running",
    });
    expect(helperThreadTargetFromParams({})).toBeUndefined();
  });
});

describe("helper thread status", () => {
  it("is running while any of the helper's runs is active or waiting on the user", () => {
    expect(helperThreadStatus({ run: { status: "queued" } }, "completed")).toBe("running");
    expect(
      helperThreadStatus({ run: null, activeRuns: [{ status: "waiting_input" }] }, "completed"),
    ).toBe("running");
  });

  it("reports failure and cancellation, and settles a finished helper from the snapshot", () => {
    expect(helperThreadStatus({ run: { status: "failed" } }, "running")).toBe("failed");
    expect(helperThreadStatus({ run: { status: "cancelled" } }, "running")).toBe("stopped");
    expect(helperThreadStatus({ run: null }, "completed")).toBe("completed");
    expect(helperThreadStatus({ run: null }, "running")).toBe("completed");
    expect(helperThreadStatus({ run: null }, "failed")).toBe("failed");
    expect(helperThreadStatus({ run: null }, "stopped")).toBe("stopped");
    expect(helperThreadStatus(null, "running")).toBe("running");
  });

  it("settles on terminal events and lets later progress mark a live run running", () => {
    expect(helperThreadStatusAfterEvent("running", { type: "run.completed" })).toBe("completed");
    expect(helperThreadStatusAfterEvent("running", { type: "run.failed" })).toBe("failed");
    expect(helperThreadStatusAfterEvent("running", { type: "run.cancelled" })).toBe("stopped");
    expect(helperThreadStatusAfterEvent("completed", { type: "thread.progress" })).toBe("running");
    expect(helperThreadStatusAfterEvent("running", { type: "agent.tool.called" })).toBe("running");
    expect(helperThreadStatusAfterEvent("stopped", { type: "run.started" })).toBe("running");
  });
});
