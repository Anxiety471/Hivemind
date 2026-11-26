import { buildSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { SearchableSkill } from "../../tools/skill-search.js";
import { matchRelevantSkillsForPrompt } from "../../tools/skill-search.js";
import {
  previousMessageAt,
  previousPromptMessages,
  skillHintText,
} from "./run-assembly-context.js";

describe("previousMessageAt", () => {
  it("takes the newest message other than the current turn, in any order", () => {
    const messages = [
      { id: "now", createdAt: new Date("2026-11-12T08:54:00Z") },
      { id: "b", createdAt: new Date("2026-11-11T21:42:00Z") },
      { id: "a", createdAt: new Date("2026-11-11T21:40:00Z") },
    ];
    expect(previousMessageAt(messages, "now")?.toISOString()).toBe("2026-11-11T21:42:00.000Z");
  });

  it("is undefined for a first message", () => {
    expect(previousMessageAt([{ id: "now", createdAt: new Date() }], "now")).toBe(undefined);
  });
});

describe("skill hint context", () => {
  const corpus: SearchableSkill[] = [
    {
      id: "user:reply-watch",
      name: "Reply Watch",
      description: "Watch a thread for replies and draft the follow-up email",
      source: "user",
      readOnly: false,
      content: buildSkillMd({
        name: "Reply Watch",
        description: "Watch a thread for replies and draft the follow-up email",
        body: "## Watch\nThe reply watch routine checks the email draft and watches the thread for replies.",
        frontmatter: { triggers: ["reply watch", "watch email draft"] },
      }),
    },
  ];
  const hintNames = (text: string) =>
    matchRelevantSkillsForPrompt(text, corpus).map((hint) => hint.name);

  it("lets a short follow-up match through the ticket and its earlier replies", () => {
    expect(
      hintNames(
        skillHintText("Done sending", {
          ticket:
            "Ticket: Reply watch\nWatch the email thread for replies and draft the follow-up email.",
          previousMessages: ["I will watch the email draft for replies before sending."],
        }),
      ),
    ).toContain("Reply Watch");
  });

  it("keeps casual chat and a long request from borrowing unrelated context", () => {
    expect(hintNames(skillHintText("hi", {}))).toEqual([]);
    expect(hintNames(skillHintText("thanks", {}))).toEqual([]);
    expect(
      hintNames(
        skillHintText(
          "Please write a short calm haiku about rain falling on the roof while everyone sleeps",
          { ticket: "Reply watch email draft" },
        ),
      ),
    ).toEqual([]);
  });

  it("reads the last two replies before this turn, skipping the current message", () => {
    const messages = ["first", "second", "third", "now"].map((id) => ({
      id,
      blocks: [{ kind: "text" as const, text: id }],
    }));
    expect(previousPromptMessages(messages, "now")).toEqual(["second", "third"]);
  });
});
