import { describe, expect, it } from "vitest";
import { extractProseChoiceQuestion } from "./prose-choice-question.js";

const SCREENSHOT_MESSAGE = `One account is a work account (\`systemsadministration.unit@gmail.com\`) marked in USER.md as "sends only, never signed in." Connecting it would go against that.

Which do you want?

- **Publish the OAuth app first, then add the three accounts.** This is my recommendation. It stops the 7-day expiry for all four accounts. Publishing needs your OK, and Google may ask for branding setup or scope verification.
- **Add the three accounts now, in Testing mode.** They'll expire around 2026-12-04, the same as the first account.
- **Add only the two personal accounts.** Skip \`systemsadministration.unit\`, which stays sends-only as USER.md says.`;

describe("extractProseChoiceQuestion", () => {
  it("promotes the bulleted choice with its preamble, description, and recommendation", () => {
    const result = extractProseChoiceQuestion(SCREENSHOT_MESSAGE);
    expect(result).toEqual({
      preamble:
        'One account is a work account (`systemsadministration.unit@gmail.com`) marked in USER.md as "sends only, never signed in." Connecting it would go against that.',
      question: "Which do you want?",
      actions: [
        {
          id: "choice-1",
          label: "Publish the OAuth app first, then add the three accounts",
          description:
            "It stops the 7-day expiry for all four accounts. Publishing needs your OK, and Google may ask for branding setup or scope verification.",
          recommended: true,
        },
        {
          id: "choice-2",
          label: "Add the three accounts now, in Testing mode",
          description: "They'll expire around 2026-12-04, the same as the first account.",
        },
        {
          id: "choice-3",
          label: "Add only the two personal accounts",
          description: "Skip `systemsadministration.unit`, which stays sends-only as USER.md says.",
        },
      ],
    });
  });

  it("reads a numbered list with (Recommended) on option 2", () => {
    const result = extractProseChoiceQuestion(
      [
        "The build is green but the migration is not yet decided.",
        "",
        "Which way should we go?",
        "",
        "1. Keep the current schema",
        "2. Split the table now (Recommended)",
        "3. Defer the decision",
      ].join("\n"),
    );
    expect(result).toEqual({
      preamble: "The build is green but the migration is not yet decided.",
      question: "Which way should we go?",
      actions: [
        { id: "choice-1", label: "Keep the current schema" },
        { id: "choice-2", label: "Split the table now", recommended: true },
        { id: "choice-3", label: "Defer the decision" },
      ],
    });
  });

  it("marks the option a trailing recommendation line names", () => {
    const result = extractProseChoiceQuestion(
      [
        "Which do you want?",
        "",
        "- Option A: keep the old flow",
        "- Option B: move to the new flow",
        "",
        "My recommendation is option 2.",
      ].join("\n"),
    );
    expect(result?.actions).toEqual([
      { id: "choice-1", label: "Option A", description: "keep the old flow" },
      { id: "choice-2", label: "Option B", description: "move to the new flow", recommended: true },
    ]);
    expect(result?.preamble).toBeUndefined();
  });

  it("reads plain short options without bold or descriptions", () => {
    const result = extractProseChoiceQuestion(
      ["Want me to retry now?", "", "- Retry now", "- Wait an hour", "- Drop it"].join("\n"),
    );
    expect(result).toEqual({
      question: "Want me to retry now?",
      actions: [
        { id: "choice-1", label: "Retry now" },
        { id: "choice-2", label: "Wait an hour" },
        { id: "choice-3", label: "Drop it" },
      ],
    });
  });

  it("keeps a header-style menu only when one option is recommended", () => {
    const recommended = extractProseChoiceQuestion(
      ["Pick one:", "", "- Ship today (recommended)", "- Ship Monday"].join("\n"),
    );
    expect(recommended?.question).toBe("Pick one:");
    expect(recommended?.actions[0]).toEqual({
      id: "choice-1",
      label: "Ship today",
      recommended: true,
    });

    expect(
      extractProseChoiceQuestion(["Options:", "", "- Ship today", "- Ship Monday"].join("\n")),
    ).toBeNull();
  });

  it("returns null for a status list headed by Still open", () => {
    expect(
      extractProseChoiceQuestion(
        [
          "Still open:",
          "1. #249 wake delivery retries",
          "2. After #249, the webhook cleanup",
          "3. TASK-362 billing export",
          "4. TASK-388 mobile sign-in",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("returns null for an informational question followed by factual bullets", () => {
    expect(
      extractProseChoiceQuestion(
        ["What changed?", "", "- The migration ran cleanly", "- Two tests were renamed"].join("\n"),
      ),
    ).toBeNull();
    expect(
      extractProseChoiceQuestion(
        ["Which tests failed?", "", "- auth refresh", "- billing export"].join("\n"),
      ),
    ).toBeNull();
  });

  it("returns null for a list of five or of one", () => {
    expect(
      extractProseChoiceQuestion(
        ["Which do you want?", "", "- a", "- b", "- c", "- d", "- e"].join("\n"),
      ),
    ).toBeNull();
    expect(extractProseChoiceQuestion(["Which do you want?", "", "- a"].join("\n"))).toBeNull();
  });

  it("returns null when the list sits in a fenced code block", () => {
    expect(
      extractProseChoiceQuestion(
        ["Which do you want?", "", "```", "- Keep it", "- Drop it", "```"].join("\n"),
      ),
    ).toBeNull();
  });

  it("returns null when long prose follows the list", () => {
    const essay = `${"This closing paragraph keeps going about the tradeoffs. ".repeat(4)}`;
    expect(
      extractProseChoiceQuestion(
        ["Which do you want?", "", "- Keep it", "- Drop it", "", essay].join("\n"),
      ),
    ).toBeNull();
    expect(
      extractProseChoiceQuestion(
        ["Which do you want?", "", "- Keep it", "- Drop it", "", "One.", "", "Two."].join("\n"),
      ),
    ).toBeNull();
  });

  it("returns null when labels repeat or an option cannot yield a label", () => {
    expect(
      extractProseChoiceQuestion(["Which do you want?", "", "- Keep", "- keep"].join("\n")),
    ).toBeNull();
    expect(
      extractProseChoiceQuestion(["Which do you want?", "", "- x", "- Drop it"].join("\n")),
    ).toBeNull();
  });

  it("returns null for ordinary replies and summaries", () => {
    expect(extractProseChoiceQuestion("Done. The export is attached.")).toBeNull();
    expect(
      extractProseChoiceQuestion(
        ["Summary:", "", "- Two files changed", "- Tests pass"].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not guess when two options look recommended", () => {
    const result = extractProseChoiceQuestion(
      [
        "Which do you want?",
        "",
        "- **Keep it.** This is my recommendation.",
        "- **Drop it.** I recommend this.",
      ].join("\n"),
    );
    expect(result?.actions.some((action) => action.recommended)).toBe(false);
  });
});
