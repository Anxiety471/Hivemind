import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { withoutSupersededJobCards } from "./job-cards.js";

function job(jobId: string, state: "working" | "finished", title = "mcp-job-card"): MessageBlock {
  return { kind: "job", jobId, title, state };
}

function message(id: string, seq: number | undefined, blocks: MessageBlock[]) {
  return { id, seq, blocks };
}

const ids = (messages: readonly { id: string }[]) => messages.map((message) => message.id);

describe("withoutSupersededJobCards", () => {
  it("keeps only the newest card of a job and hides the message it was alone in", () => {
    const working = message("card-1", 1, [job("job-1", "working")]);
    const finished = message("card-2", 2, [job("job-1", "finished")]);
    const messages = [message("text-1", 3, [{ kind: "text", text: "Done." }]), working, finished];

    expect(ids(withoutSupersededJobCards(messages))).toEqual(["text-1", "card-2"]);
  });

  it("keeps a card of every job, and the chat's other messages untouched", () => {
    const first = message("card-1", 1, [job("job-1", "working")]);
    const other = message("card-2", 2, [job("job-2", "working", "billing-worker")]);
    const chat = message("text-1", 3, [{ kind: "text", text: "Both started." }]);
    const messages = [first, other, chat];

    const kept = withoutSupersededJobCards(messages);

    expect(ids(kept)).toEqual(["card-1", "card-2", "text-1"]);
    // A thread with nothing to hide keeps its own array, so the chat does not redraw.
    expect(kept).toBe(messages);
  });

  it("drops only the stale card from a message that also has text", () => {
    const messages = [
      message("reply-1", 1, [job("job-1", "working"), { kind: "text", text: "Started it." }]),
      message("card-2", 2, [job("job-1", "finished")]),
    ];

    expect(withoutSupersededJobCards(messages)).toEqual([
      { id: "reply-1", seq: 1, blocks: [{ kind: "text", text: "Started it." }] },
      { id: "card-2", seq: 2, blocks: [job("job-1", "finished")] },
    ]);
  });

  it("orders cards by seq, so a newest-first list hides the same card", () => {
    const working = message("card-1", 1, [job("job-1", "working")]);
    const finished = message("card-2", 2, [job("job-1", "finished")]);

    expect(ids(withoutSupersededJobCards([finished, working]))).toEqual(["card-2"]);
  });

  it("ranks a live row after every stored row, so a low index cannot look old", () => {
    const stored = message("card-1", 300, [job("job-1", "working")]);
    const live = message("progress:run", undefined, [job("job-1", "finished")]);

    expect(ids(withoutSupersededJobCards([stored, live]))).toEqual(["progress:run"]);
    // A newest-first list puts that live row first; it is still the newest card.
    expect(ids(withoutSupersededJobCards([live, stored]))).toEqual(["progress:run"]);
  });
});
