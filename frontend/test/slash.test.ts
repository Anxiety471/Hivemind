// Run with: bun test test/slash.test.ts   (or: node --experimental-strip-types --test test/slash.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { completions, parseSlash, skillPrompt } from "../src/slash.ts";

test("only a leading slash makes a command; a double slash escapes it", () => {
  assert.deepEqual(parseSlash("hello /skills"), { kind: "message", text: "hello /skills" });
  assert.deepEqual(parseSlash("//etc/hosts is a file"), { kind: "message", text: "/etc/hosts is a file" });
  assert.deepEqual(parseSlash("  /skill:Banner-Design  make one \n for me "), {
    kind: "command",
    name: "skill:Banner-Design",
    args: "make one \n for me",
  });
  assert.deepEqual(parseSlash("/"), { kind: "command", name: "", args: "" });
});

test("completion lists commands, then /skill:<name> rows, as the name is typed", () => {
  const skills = [
    { name: "banner-design", description: "banners" },
    { name: "brand", description: "voice" },
  ];
  assert.deepEqual(completions("/", skills).map((c) => c.insert), [
    "/help",
    "/skills",
    "/tools",
    "/skill:banner-design ",
    "/skill:brand ",
  ]);
  assert.deepEqual(completions("/sk", skills).map((c) => c.insert), [
    "/skills",
    "/skill:banner-design ",
    "/skill:brand ",
  ]);
  assert.deepEqual(completions("/skill:ba", skills).map((c) => c.label), ["/skill:banner-design"]);
  assert.deepEqual(completions("/bra", skills).map((c) => c.label), ["/skill:brand"]);
  assert.deepEqual(completions("/skill:brand extra words", skills), []);
  assert.deepEqual(completions("plain text", skills), []);
});

test("skill prompt names the skill and keeps the request", () => {
  assert.match(skillPrompt("brand", ""), /"brand" skill/);
  assert.ok(skillPrompt("brand", "write a tagline").endsWith("\n\nwrite a tagline"));
});
