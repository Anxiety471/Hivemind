import { describe, expect, it } from "vitest";
import type { LiveTicketFact } from "./ticket-fact-check.js";
import { findTicketFactMismatches, formatTicketFactCheckNote } from "./ticket-fact-check.js";

const PREFIX = "TASK";

function board(...facts: LiveTicketFact[]): Map<string, LiveTicketFact> {
  return new Map(facts.map((fact) => [fact.ref, fact]));
}

const done411: LiveTicketFact = {
  ref: "TASK-411",
  title: "Access model",
  status: "done",
  decision: { question: "Which permissions?", answer: "option-a" },
};

const blocked418: LiveTicketFact = {
  ref: "TASK-418",
  title: "Export format",
  status: "blocked",
  decision: { question: "CSV or JSON?" },
};

describe("findTicketFactMismatches", () => {
  it("catches a done ticket described as still open in the reply", () => {
    const text =
      "The access model isn't chosen yet. TASK-411 is still open, so I don't know which permissions each account should grant.";
    expect(findTicketFactMismatches(text, PREFIX, board(done411))).toEqual([
      { kind: "closed_claimed_open", ref: "TASK-411", live: done411 },
    ]);
  });

  it("does not flag a correction that says the ticket is done, not open", () => {
    expect(findTicketFactMismatches("TASK-411 is done, not open.", PREFIX, board(done411))).toEqual(
      [],
    );
    expect(
      findTicketFactMismatches(
        "TASK-411 was open earlier and is now done.",
        PREFIX,
        board(done411),
      ),
    ).toEqual([]);
  });

  it("reports a referenced ticket that is not on the board", () => {
    expect(findTicketFactMismatches("TASK-999 is ready to ship.", PREFIX, board())).toEqual([
      { kind: "missing", ref: "TASK-999" },
    ]);
  });

  it("does not report a missing ticket the sentence says does not exist", () => {
    expect(
      findTicketFactMismatches("TASK-999 does not exist, so I skipped it.", PREFIX, board()),
    ).toEqual([]);
  });

  it("catches an open ticket claimed done and carries its pending decision", () => {
    const mismatches = findTicketFactMismatches("TASK-418 is now done.", PREFIX, board(blocked418));
    expect(mismatches).toEqual([
      { kind: "open_claimed_closed", ref: "TASK-418", live: blocked418 },
    ]);
    expect(formatTicketFactCheckNote(mismatches)).toBe(
      "> **Board check:** **TASK-418** is **blocked** on the board (Export format) — decision pending: CSV or JSON?.",
    );
  });

  it("ignores negated, conditional, and future completion phrasings", () => {
    expect(
      findTicketFactMismatches("Once TASK-418 is done, we can merge.", PREFIX, board(blocked418)),
    ).toEqual([]);
    expect(
      findTicketFactMismatches("TASK-418 is not done yet.", PREFIX, board(blocked418)),
    ).toEqual([]);
    expect(
      findTicketFactMismatches("TASK-418 will be done after review.", PREFIX, board(blocked418)),
    ).toEqual([]);
  });

  it("ignores ticket claims inside fenced code blocks", () => {
    const text = ["Here is the log:", "```", "TASK-411 is still open", "```"].join("\n");
    expect(findTicketFactMismatches(text, PREFIX, board(done411))).toEqual([]);
  });

  it("judges each bullet only against its own ticket", () => {
    const text =
      "- TASK-411 is closed out.\n- TASK-418 is still open, waiting on the export choice.";
    expect(findTicketFactMismatches(text, PREFIX, board(done411, blocked418))).toEqual([]);
  });
});

describe("formatTicketFactCheckNote", () => {
  it("joins several corrections under one board-check blockquote", () => {
    expect(
      formatTicketFactCheckNote([
        { kind: "missing", ref: "TASK-999" },
        { kind: "closed_claimed_open", ref: "TASK-411", live: done411 },
      ]),
    ).toBe(
      "> **Board check:** **TASK-999** does not exist on this board.\n> **TASK-411** is **done** on the board (Access model) — decision answered.",
    );
  });
});
