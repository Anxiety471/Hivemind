import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/api.ts";
import { compareIssues, inIssueView, issueGroup } from "../src/views/issueList.ts";

const task = (status: Task["status"], paused = false, priority: Task["issue"]["priority"] = "normal", number = 1) => ({ status, paused, updated_at: number, issue: { priority, number } }) as Task;

test("issue groups reflect scheduler states, including paused and terminal work", () => {
  for (const [status, expected] of Object.entries({ submitted: "Todo", ready: "Todo", planning: "In Progress", running: "In Progress", review: "In Review", blocked: "Blocked", needs_input: "Blocked", completed: "Done", failed: "Failed", cancelled: "Cancelled" })) {
    assert.equal(issueGroup(task(status as Task["status"])), expected);
  }
  assert.equal(issueGroup(task("running", true)), "Backlog");
  assert.equal(issueGroup(task("completed", true)), "Done");
  assert.equal(issueGroup(task("failed", true)), "Failed");
});

test("active and backlog exclude terminal tickets; all and closed retain them", () => {
  assert.equal(inIssueView(task("running"), "active"), true);
  assert.equal(inIssueView(task("running", true), "active"), false);
  assert.equal(inIssueView(task("submitted", true), "backlog"), true);
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(inIssueView(task(status, true), "backlog"), false);
    assert.equal(inIssueView(task(status), "active"), false);
    assert.equal(inIssueView(task(status), "closed"), true);
    assert.equal(inIssueView(task(status), "all"), true);
  }
});

test("priority precedes recency and issue number within a status group", () => {
  const rows = [task("submitted", true, "low", 4), task("submitted", true, "urgent", 1), task("submitted", true, "high", 2), task("submitted", true, "high", 3)];
  assert.deepEqual(rows.sort(compareIssues).map((row) => row.issue.number), [1, 3, 2, 4]);
});
