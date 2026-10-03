// Run with: bun test test/issues.test.ts   (or: node --experimental-strip-types --test test/issues.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestry, childrenIndex, descendants, draftPlan, groupOf, indentRow, issueKey, matches, subProgress } from "../src/issues.ts";

type T = { id: string; parent_id: string | null; status: any; objective: string; owner: string | null; reviewer: string | null };
const t = (id: string, parent_id: string | null, status = "running"): T => ({
  id,
  parent_id,
  status,
  objective: `do ${id}`,
  owner: null,
  reviewer: null,
});

const tree = [t("root", null), t("a", "root", "completed"), t("b", "root"), t("b1", "b", "completed"), t("b1x", "b1", "cancelled"), t("b2", "b")];

test("children nest to any depth", () => {
  const index = childrenIndex(tree);
  assert.deepEqual(index.get("root")!.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(descendants("root", index).map((x) => x.id), ["a", "b", "b1", "b2", "b1x"]);
  assert.deepEqual(descendants("b2", index), []);
});

test("progress counts every level and skips cancelled work", () => {
  const index = childrenIndex(tree);
  assert.deepEqual(subProgress("root", index), { done: 2, total: 4 });
  assert.deepEqual(subProgress("b", index), { done: 1, total: 2 });
});

test("ancestry walks up to the root and survives cycles", () => {
  const byId = new Map(tree.map((x) => [x.id, x]));
  assert.deepEqual(ancestry("b1x", byId).map((x) => x.id), ["root", "b", "b1"]);
  assert.deepEqual(ancestry("root", byId), []);
  const loop = new Map([
    ["x", t("x", "y")],
    ["y", t("y", "x")],
  ]);
  assert.deepEqual(ancestry("x", loop).map((x) => x.id), ["x", "y"]);
});

test("issue keys are short and stable", () => {
  assert.match(issueKey("tk_0123456789abcdef00010002"), /^HM-[0-9A-Z]{4}$/);
  assert.equal(issueKey("tk_a"), issueKey("tk_a"));
  assert.notEqual(issueKey("tk_a"), issueKey("tk_b"));
});

test("statuses fall into Linear-style groups", () => {
  assert.equal(groupOf("running").label, "In Progress");
  assert.equal(groupOf("needs_input").key, "attention");
  assert.equal(groupOf("submitted").label, "Backlog");
});

test("search matches title, key and people", () => {
  const task = { ...t("tk_1", null), owner: "Front" };
  assert.ok(matches(task, "DO TK"));
  assert.ok(matches(task, issueKey("tk_1").toLowerCase()));
  assert.ok(matches(task, "front"));
  assert.ok(!matches(task, "backend"));
});

test("drafted rows become a nested plan with parent keys", () => {
  const plan = draftPlan([
    { title: "API", depth: 0 },
    { title: "Schema", depth: 1 },
    { title: "Migration", depth: 2 },
    { title: "  ", depth: 1 },
    { title: "Handler", depth: 1 },
    { title: "UI", depth: 0 },
  ]);
  assert.deepEqual(
    plan.map((t) => [t.key, t.objective, t.parent ?? null]),
    [
      ["sub-1", "API", null],
      ["sub-2", "Schema", "sub-1"],
      ["sub-3", "Migration", "sub-2"],
      ["sub-4", "Handler", "sub-1"],
      ["sub-5", "UI", null],
    ],
  );
  assert.deepEqual(plan[0].acceptance, ["API"]);
  // A blank parent does not orphan its children: they attach to the nearest real row above.
  assert.deepEqual(draftPlan([{ title: "", depth: 0 }, { title: "Child", depth: 1 }]).map((t) => t.parent ?? null), [null]);
});

test("indenting stays one level below the row above and carries children", () => {
  const rows = [
    { title: "a", depth: 0 },
    { title: "b", depth: 0 },
    { title: "c", depth: 1 },
  ];
  assert.deepEqual(indentRow(rows, 0, 1), rows, "the first row cannot indent");
  const once = indentRow(rows, 1, 1);
  assert.deepEqual(once.map((r) => r.depth), [0, 1, 2]);
  assert.deepEqual(indentRow(once, 1, 1).map((r) => r.depth), [0, 1, 2], "no deeper than one below the row above");
  assert.deepEqual(indentRow(once, 1, -1).map((r) => r.depth), [0, 0, 1]);
});
