import { JOB_CARD_REPLY_MAX_CHARS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { toolCardFromResult } from "./tool-card.js";

const card = {
  kind: "job",
  jobId: "job-1",
  title: "mcp-job-card",
  agent: "pi",
  branch: "Anxiety471/mcp-job-card",
  state: "working",
  startedAt: 1_770_000_000_000,
  url: "https://code.bocchi.trade",
};

const result = (structuredContent: unknown, isError = false) => ({
  content: [{ type: "text", text: "started" }],
  structuredContent,
  ...(isError ? { isError: true } : {}),
});

describe("toolCardFromResult", () => {
  it("reads the card a tool result carried", () => {
    expect(toolCardFromResult(result({ card }))).toEqual(card);
  });

  it("keeps the card but drops a link that is not https", () => {
    const { url: _url, ...withoutUrl } = card;
    expect(toolCardFromResult(result({ card: { ...card, url: "http://127.0.0.1:3422" } }))).toEqual(
      withoutUrl,
    );
    expect(
      toolCardFromResult(result({ card: { ...card, url: "https://user:pw@example.test" } })),
    ).toEqual(withoutUrl);
  });

  it("cuts a long reply to the card's cap instead of dropping the card", () => {
    const reply = "x".repeat(JOB_CARD_REPLY_MAX_CHARS + 50);
    const parsed = toolCardFromResult(result({ card: { ...card, state: "finished", reply } }));
    expect(parsed?.reply).toHaveLength(JOB_CARD_REPLY_MAX_CHARS);
    expect(parsed?.state).toBe("finished");
  });

  it("keeps every state the contract names", () => {
    for (const state of ["starting", "working", "finished", "needs_input", "exited", "timed_out"]) {
      expect(toolCardFromResult(result({ card: { ...card, state } }))?.state).toBe(state);
    }
  });

  it("shows nothing for a card this host cannot read", () => {
    expect(toolCardFromResult(result({ card: { ...card, state: "paused" } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: { ...card, jobId: "" } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: { ...card, title: undefined } }))).toBeUndefined();
    expect(toolCardFromResult(result({ card: "working" }))).toBeUndefined();
    expect(toolCardFromResult(result({}))).toBeUndefined();
    expect(toolCardFromResult(result({ card }, true))).toBeUndefined();
    expect(toolCardFromResult({ content: [] })).toBeUndefined();
    expect(toolCardFromResult(undefined)).toBeUndefined();
  });
});
