import { describe, expect, it } from "vitest";
import {
  applyComposerReference,
  composerReferenceOptionsFrom,
  filterComposerReferences,
  findComposerReferenceQuery,
} from "./composer-references.js";

describe("findComposerReferenceQuery", () => {
  it("opens on a bare # after the start, a space, or CJK text", () => {
    expect(findComposerReferenceQuery("#", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findComposerReferenceQuery("see #418", 8)).toEqual({ start: 4, end: 8, query: "418" });
    expect(findComposerReferenceQuery("#task-418", 9)?.query).toBe("task-418");
    expect(findComposerReferenceQuery("fix #oauth", 10)?.query).toBe("oauth");
    expect(findComposerReferenceQuery("请#418", 5)).toEqual({ start: 1, end: 5, query: "418" });
    expect(findComposerReferenceQuery("#wake/249", 9)?.query).toBe("wake/249");
    expect(findComposerReferenceQuery("#anxiety471/wake#249", 20)?.query).toBe(
      "anxiety471/wake#249",
    );
  });

  it("returns the exact # index when the caret is mid-text", () => {
    const text = "look #oauth now";
    expect(findComposerReferenceQuery(text, 11)).toEqual({ start: 5, end: 11, query: "oauth" });
  });

  it("returns null for a non-collapsed selection, markdown headings, mid-word #, and closed refs", () => {
    expect(findComposerReferenceQuery("#418", 0, 4)).toBeNull();
    expect(findComposerReferenceQuery("##", 2)).toBeNull();
    expect(findComposerReferenceQuery("## Title #", 10)?.query).toBe("");
    expect(findComposerReferenceQuery("foo#bar", 7)).toBeNull();
    expect(findComposerReferenceQuery("#418 ", 5)).toBeNull();
    expect(findComposerReferenceQuery("#418,", 5)).toBeNull();
    expect(findComposerReferenceQuery("(#418)", 6)).toBeNull();
  });
});

const tickets = [
  {
    ref: "TASK-418",
    title: "Refresh OAuth tokens",
    status: "open",
    decision: { question: "Ship it?" },
    pullRequests: [{ url: "https://github.com/anxiety471/wake/pull/249", state: "open" }],
  },
  {
    ref: "TASK-405",
    title: "Tidy logs",
    status: "in_progress",
  },
  {
    ref: "TASK-411",
    title: "Old migration",
    status: "done",
    pullRequests: [{ url: "https://github.com/anxiety471/wake/pull/241", state: "merged" }],
  },
  {
    ref: "TASK-420",
    title: "Answered question",
    status: "open",
    decision: { question: "Which?", answer: "Option B" },
    pullRequests: [{ url: "https://github.com/anxiety471/wake/pull/249", state: "open" }],
  },
];

describe("composerReferenceOptionsFrom and filterComposerReferences", () => {
  const options = composerReferenceOptionsFrom(tickets);

  it("pins pending-decision tickets first, then open tickets, then open PRs, then closed items", () => {
    const keys = options.map((option) => option.key);
    expect(keys).toEqual([
      "ticket:TASK-418",
      "ticket:TASK-420",
      "ticket:TASK-405",
      "pr:https://github.com/anxiety471/wake/pull/249",
      "pr:https://github.com/anxiety471/wake/pull/241",
      "ticket:TASK-411",
    ]);
    expect(options[0]).toMatchObject({ pendingDecision: true, closed: false });
    expect(options[1]).toMatchObject({ pendingDecision: false });
    expect(options[5]).toMatchObject({ kind: "ticket", closed: true });
  });

  it("deduplicates PRs by url and labels them owner/repo#number", () => {
    const prs = options.filter((option) => option.kind === "pull_request");
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      insertText: "anxiety471/wake#249",
      label: "anxiety471/wake#249",
      number: 249,
      ticketRef: "TASK-418",
    });
  });

  it("empty query shows open items first and leaves out closed ones", () => {
    const result = filterComposerReferences(options, "");
    expect(result.map((option) => option.insertText)).toEqual([
      "TASK-418",
      "TASK-420",
      "TASK-405",
      "anxiety471/wake#249",
    ]);
  });

  it("finds a done ticket by number", () => {
    const result = filterComposerReferences(options, "411");
    expect(result[0]).toMatchObject({ kind: "ticket", ref: "TASK-411" });
  });

  it("finds tickets by title words", () => {
    const result = filterComposerReferences(options, "oauth");
    expect(result[0]).toMatchObject({ ref: "TASK-418" });
  });

  it("finds the PR by its number and ranks it first", () => {
    const result = filterComposerReferences(options, "249");
    expect(result[0]).toMatchObject({ kind: "pull_request", number: 249 });
  });

  it("keeps a PR whose URL has a mixed-case owner", () => {
    const mixed = composerReferenceOptionsFrom([
      {
        ref: "TASK-500",
        status: "open",
        pullRequests: [{ url: " https://example.com/Anxiety471/wake/pull/249 ", state: "open" }],
      },
    ]).filter((option) => option.kind === "pull_request");
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({ insertText: "anxiety471/wake#249", number: 249 });
  });

  it("matches a repository-qualified PR label", () => {
    const result = filterComposerReferences(options, "anxiety471/wake#249");
    expect(result[0]).toMatchObject({ kind: "pull_request", number: 249 });
  });

  it("ranks an exact number above a title word match", () => {
    expect(filterComposerReferences(options, "418")[0]).toMatchObject({ ref: "TASK-418" });
    expect(filterComposerReferences(options, "logs")[0]).toMatchObject({ ref: "TASK-405" });
  });

  it("returns nothing when no term matches", () => {
    expect(filterComposerReferences(options, "zzz")).toEqual([]);
  });

  it("caps results at the limit", () => {
    expect(filterComposerReferences(options, "", 2)).toHaveLength(2);
  });
});

describe("applyComposerReference", () => {
  const query = { start: 4, end: 8, query: "418" };

  it("inserts the reference and one trailing space", () => {
    const result = applyComposerReference("fix #418", query, { insertText: "TASK-418" });
    expect(result).toEqual({ text: "fix TASK-418 ", cursor: 13 });
  });

  it("does not add a second space when one already follows", () => {
    const result = applyComposerReference("fix #418 please", query, { insertText: "TASK-418" });
    expect(result).toEqual({ text: "fix TASK-418 please", cursor: 13 });
  });

  it("places the cursor after the inserted reference and its space", () => {
    const text = "a #4 b";
    const result = applyComposerReference(
      text,
      { start: 2, end: 4, query: "4" },
      {
        insertText: "owner/repo#249",
      },
    );
    expect(result.text).toBe("a owner/repo#249 b");
    expect(result.text[result.cursor - 1]).toBe(" ");
    expect(result.cursor).toBe(2 + "owner/repo#249".length + 1);
  });
});
