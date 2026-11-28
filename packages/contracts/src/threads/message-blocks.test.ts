import { describe, expect, it } from "vitest";
import { AskItemSchema, MessageBlock } from "./message-blocks.js";

describe("ask blocks with batch items", () => {
  it("keeps single-question asks valid without items", () => {
    const block = {
      kind: "ask",
      text: "Which city?",
      status: "pending",
      actions: [{ id: "choice-1", label: "Berlin", recommended: true }],
    };
    expect(MessageBlock.parse(block)).toEqual(block);
  });

  it("accepts actionable and FYI items on one ask", () => {
    const block = {
      kind: "ask",
      text: "Still open",
      status: "pending",
      items: [
        {
          id: "item-1",
          question: "Ship the notes?",
          detail: "Draft is in the thread.",
          ticketRef: "OPS-12",
          actions: [{ id: "choice-1", label: "Ship", recommended: true }],
        },
        { id: "item-2", question: "Nightly build passed" },
      ],
    };
    expect(MessageBlock.parse(block)).toEqual(block);
  });

  it("rejects an item without an id or question", () => {
    expect(AskItemSchema.safeParse({ question: "Missing id" }).success).toBe(false);
    expect(AskItemSchema.safeParse({ id: "item-1" }).success).toBe(false);
  });
});
