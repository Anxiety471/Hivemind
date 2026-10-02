// Run with: node --experimental-strip-types --test test/mentions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMention, filterParticipants, getMentionMatch } from "../src/mentions.ts";
import type { Participant } from "../src/api.ts";

test("getMentionMatch detects @ at start of input", () => {
  const match = getMentionMatch("@", 1);
  assert.deepEqual(match, { query: "", atIndex: 0 });
});

test("getMentionMatch detects @ with query at start of input", () => {
  const match = getMentionMatch("@eng", 4);
  assert.deepEqual(match, { query: "eng", atIndex: 0 });
});

test("getMentionMatch detects @ preceded by whitespace", () => {
  const match = getMentionMatch("hello @rev", 10);
  assert.deepEqual(match, { query: "rev", atIndex: 6 });
});

test("getMentionMatch detects @ preceded by newline", () => {
  const match = getMentionMatch("line 1\n@test", 12);
  assert.deepEqual(match, { query: "test", atIndex: 7 });
});

test("getMentionMatch detects @ preceded by punctuation like parenthesis", () => {
  const match = getMentionMatch("(@agent", 7);
  assert.deepEqual(match, { query: "agent", atIndex: 1 });
});

test("getMentionMatch ignores email addresses", () => {
  const match = getMentionMatch("user@example.com", 16);
  assert.equal(match, null);
});

test("getMentionMatch ignores mention followed by space when cursor is after space", () => {
  const match = getMentionMatch("@agent ", 7);
  assert.equal(match, null);
});

test("filterParticipants excludes user and deduplicates", () => {
  const participants: Participant[] = [
    { persona_id: "user", role: null },
    { persona_id: "Engineer", role: "backend" },
    { persona_id: "Engineer", role: "backend" },
    { persona_id: "Reviewer", role: "reviewer" },
  ];
  const result = filterParticipants(participants, "");
  assert.equal(result.length, 2);
  assert.equal(result[0].persona_id, "Engineer");
  assert.equal(result[1].persona_id, "Reviewer");
});

test("filterParticipants filters by persona_id or role and prioritizes prefix match", () => {
  const participants: Participant[] = [
    { persona_id: "SeniorReviewer", role: "lead" },
    { persona_id: "Reviewer", role: "code review" },
    { persona_id: "Engineer", role: "software engineer" },
  ];
  const byPrefix = filterParticipants(participants, "rev");
  assert.equal(byPrefix.length, 2);
  // Reviewer starts with rev, SeniorReviewer contains rev
  assert.equal(byPrefix[0].persona_id, "Reviewer");
  assert.equal(byPrefix[1].persona_id, "SeniorReviewer");

  const byRole = filterParticipants(participants, "soft");
  assert.equal(byRole.length, 1);
  assert.equal(byRole[0].persona_id, "Engineer");
});

test("applyMention inserts mention at end of input", () => {
  const text = "hello @eng";
  const match = { query: "eng", atIndex: 6 };
  const result = applyMention(text, 10, match, "Engineer");
  assert.equal(result.text, "hello @Engineer ");
  assert.equal(result.cursor, 16);
});

test("applyMention replaces mid-word mention without duplicate spaces", () => {
  const text = "ask @eng for review";
  const match = { query: "eng", atIndex: 4 };
  const result = applyMention(text, 8, match, "Engineer");
  assert.equal(result.text, "ask @Engineer for review");
  assert.equal(result.cursor, 14);
});

test("applyMention replaces existing mention when cursor is inside the word", () => {
  const text = "ask @Engineer for review";
  // Cursor is right after '@Eng' (index 8)
  const match = { query: "Eng", atIndex: 4 };
  const result = applyMention(text, 8, match, "Reviewer");
  assert.equal(result.text, "ask @Reviewer for review");
  assert.equal(result.cursor, 14);
});
