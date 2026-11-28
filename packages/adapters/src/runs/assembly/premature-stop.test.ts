import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { detectPrematureStopReason } from "./premature-stop.js";

describe("detectPrematureStopReason flags self-admitted unfinished tool work", () => {
  it.each([
    [
      "an unchecked list with a promise to finish",
      "Not checked yet: the 2 remaining commits.\nNext I'll finish checking the commits.",
      "unchecked_list",
    ],
    ["a bold unchecked label", "**Not checked yet:** the release tag.", "unchecked_list"],
    ["a heading unchecked label", "### Not verified yet:\n- staging logs", "unchecked_list"],
    ["a not confirmed label", "Not confirmed: whether the ticket closed.", "unchecked_list"],
    [
      "a what-I-haven't-verified label",
      "What I haven't verified: the mobile build output.",
      "unchecked_list",
    ],
    ["a still-to-check label", "Still to check: the migration status.", "unchecked_list"],
    [
      "a label followed by a self-executable admission",
      "Not checked yet: the linked PR.\nI haven't checked that. I'd need to search commits.",
      "unchecked_list",
    ],
    [
      "a promise with Next I'll",
      "Updated the ticket title. Next I'll finish the remaining checks.",
      "future_promise",
    ],
    ["a promise with Next, I will", "Next, I will check the remaining logs.", "future_promise"],
    ["a promise to reopen", "I'll reopen the ticket and fix the status.", "future_promise"],
    ["a promise with an adverb", "I'll now verify the deployed build.", "future_promise"],
    ["an I will promise", "I will check the remaining files.", "future_promise"],
    ["a let me promise", "Let me check the Drive folder first.", "future_promise"],
    [
      "a promise after the first sentence on a new line",
      "Found two of three commits.\nNext I'll look at the third one.",
      "future_promise",
    ],
    [
      "an admitted unexecuted action",
      "I said I'd reopen it, but I haven't changed it yet.",
      "unexecuted_action",
    ],
    [
      "an unexecuted update paired with an earlier intent",
      "I planned to update the ticket. I haven't updated it yet.",
      "unexecuted_action",
    ],
  ])("flags %s", (_name, text, reason) => {
    expect(detectPrematureStopReason(text)).toBe(reason);
  });
});

describe("detectPrematureStopReason leaves finished, gated and blocked replies alone", () => {
  it.each([
    ["a conditional offer", "If you want, I'll check the other repo too."],
    ["a conditional offer with can", "If you'd like, I can rerun the tests."],
    ["an offer to ask", "Let me know if you want me to upload the file."],
    ["a user-gated promise", "Once you confirm, I'll upload the final file."],
    ["an approval-gated promise", "After you approve, I will publish the release."],
    ["a decision-gated promise", "When you decide, I'll update the ticket."],
    ["a wait-gated promise", "Until you answer, I'll hold the deploy."],
    ["a statement of waiting", "Waiting on your decision before the next step."],
    ["a gated next step", "Next I'll upload it after you approve the file."],
    ["a check after asking the user", "Next I'll confirm with you before I change anything."],
    [
      "a blocked reply with a not-checked label",
      "Not checked yet: the staging logs. I don't have access to that host, so I can't check them.",
    ],
    [
      "a blocked reply with an unexecuted action",
      "I planned to update the ticket, but I haven't updated it yet because I need your approval.",
    ],
    ["a blocked-on-you heading", "Blocked on you: I need your token to read the repo."],
    [
      "a completed report",
      "All checks passed. I updated the ticket and verified the three commits.",
    ],
    ["a completed report with a note", "Done. I'll note that the earlier check was completed."],
    [
      "a past intent that was done",
      "I said I'd reopen it, and I reopened it and verified the fix.",
    ],
    ["a plain answer", "The release is live on the staging host and passes smoke tests."],
  ])("does not flag %s", (_name, text) => {
    expect(detectPrematureStopReason(text)).toBeNull();
  });

  it("does not flag empty, very short or silent replies", () => {
    expect(detectPrematureStopReason("")).toBeNull();
    expect(detectPrematureStopReason("   \n  ")).toBeNull();
    expect(detectPrematureStopReason("Done.")).toBeNull();
    expect(detectPrematureStopReason("NO_RESPONSE")).toBeNull();
    expect(detectPrematureStopReason("  NO_RESPONSE\n")).toBeNull();
  });

  it("does not flag a promise that appears mid-sentence", () => {
    expect(
      detectPrematureStopReason("The commit is merged, and I'll check the deploy after that."),
    ).toBeNull();
  });

  it("scans long input in linear time", () => {
    const long = `${"Next I'll ".repeat(20_000)}without a verb`;
    const long2 = `${"haven't ".repeat(20_000)}yet`;
    expectLinearTime(() => {
      expect(detectPrematureStopReason(long)).toBeNull();
      expect(detectPrematureStopReason(long2)).toBeNull();
    });
  });
});
