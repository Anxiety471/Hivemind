import { describe, expect, it } from "vitest";
import {
  extractCodeModeCalls,
  formatCodeModeCallsSummary,
  formatCodeModeLintFindings,
  lintCodeModeScript,
  summarizeCodeModeCalls,
} from "./code-mode-lint.js";

describe("lintCodeModeScript", () => {
  it("flags static imports, side-effect imports, and dynamic import()", () => {
    const findings = lintCodeModeScript(
      [
        'import fs from "node:fs";',
        'import "dotenv/config";',
        'const mod = await import("node:path");',
      ].join("\n"),
    );
    expect(findings.map((f) => [f.rule, f.line])).toEqual([
      ["no-import", 1],
      ["no-import", 2],
      ["no-import", 3],
    ]);
  });

  it("flags require(), fetch(), timers, and host globals", () => {
    const findings = lintCodeModeScript(
      [
        'const fs = require("fs");',
        'await fetch("https://example.com");',
        "setTimeout(() => {}, 10);",
        "setInterval(() => {}, 10);",
        "console.log(process.env, Deno.version, Bun.version);",
        'new WebSocket("wss://example.com");',
      ].join("\n"),
    );
    expect(findings.map((f) => f.rule)).toEqual([
      "no-require",
      "no-fetch",
      "no-timers",
      "no-timers",
      "no-host-globals",
      "no-host-globals",
      "no-host-globals",
      "no-host-globals",
    ]);
  });

  it("flags nested command calls only in command mode", () => {
    const code = ['await codemode.cmd.other({ q: "x" });', 'await codemode["cmd"].other({});'].join(
      "\n",
    );
    expect(lintCodeModeScript(code, { mode: "script" })).toEqual([]);
    const commandFindings = lintCodeModeScript(code, { mode: "command" });
    expect(commandFindings).toHaveLength(2);
    expect(commandFindings.every((f) => f.rule === "no-nested-command")).toBe(true);
    expect(formatCodeModeLintFindings(commandFindings)).toContain(
      "A saved command cannot call another command.",
    );
  });

  it("flags unknown codemode.<tool>() calls with a close-match suggestion", () => {
    const findings = lintCodeModeScript('await codemode.demo_serch({ query: "x" });', {
      tools: ["demo_search", "demo_write", "search", "describe"],
      commandPrefix: "cmd.",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "no-unknown-tool", line: 1 });
    expect(findings[0]!.message).toContain("demo_search");
    expect(findings[0]!.message).toContain("codemode.search");
  });

  it("ignores strings, comments, regexes, property access, typeof, local shadows, and try blocks", () => {
    const clean = [
      '// import fs from "node:fs"; fetch("https://example.com");',
      "/* process.env.SECRET; setTimeout(() => {}, 1); */",
      'const msg = "import x from y; fetch(); require(); process.exit();";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: template literal is test input
      "const tpl = `fetch() and process.env ${1 + 2}`;",
      "const re = /fetch\\(|process\\.env|setTimeout\\(/;",
      "const obj = { fetch: () => 1, process: { env: {} }, import: () => 1 };",
      "obj.fetch(); obj.process.env; obj.import();",
      'console.log(typeof fetch, typeof require, typeof process, typeof globalThis.Deno, typeof import("node:fs"));',
      "const fetch = async () => 1; await fetch();",
      "try { await codemode.missing_tool({}); } catch {}",
      "const rows = await Promise.all([codemode.demo_search({ query: 'a' })]);",
      "console.log(JSON.stringify(rows));",
    ].join("\n");
    expect(
      lintCodeModeScript(clean, {
        mode: "script",
        tools: ["demo_search"],
        commandPrefix: "cmd.",
      }),
    ).toEqual([]);
  });

  it("still inspects expressions interpolated inside template literals", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: template literal is test input
    const findings = lintCodeModeScript('const out = `${await fetch("https://x.test")}`;');
    expect(findings).toEqual([expect.objectContaining({ rule: "no-fetch", line: 1 })]);
  });
});

describe("extractCodeModeCalls & summarizeCodeModeCalls", () => {
  it("extracts deduplicated tool and saved command calls while ignoring comments/strings", () => {
    const code = `
      // codemode.ignored_comment({});
      const s = "codemode.ignored_string({})";
      await codemode.cmd.weekly_report({ week: "w1" });
      await codemode.demo_search({ query: "a" });
      await codemode.demo_search({ query: "b" });
      await codemode["create_space"]({ name: "Finance" });
      await codemode["cmd"]["deploy_bot"]({});
    `;
    expect(extractCodeModeCalls(code)).toEqual([
      "cmd.weekly_report",
      "demo_search",
      "create_space",
      "cmd.deploy_bot",
    ]);
    expect(summarizeCodeModeCalls(code)).toBe(
      "cmd.weekly_report, demo_search, create_space, cmd.deploy_bot",
    );
    expect(summarizeCodeModeCalls(code, 2)).toBe("cmd.weekly_report, demo_search +2 more");
    expect(summarizeCodeModeCalls("console.log(1 + 2);")).toBeUndefined();
  });

  it("extracts destructured and aliased codemode / cmd calls", () => {
    const code = `
      const { board_tickets, list_fleet: bots, cmd: commands } = codemode;
      const { weekly_report, audit: check } = codemode.cmd;
      const cm = codemode;
      const cmds = codemode.cmd;
      await cm.drive_list({});
      await cmds.cleanup({});
      await commands.verify({});
    `;
    expect(extractCodeModeCalls(code)).toEqual([
      "board_tickets",
      "list_fleet",
      "cmd.weekly_report",
      "cmd.audit",
      "drive_list",
      "cmd.cleanup",
      "cmd.verify",
    ]);
    expect(formatCodeModeCallsSummary(["a", "a", "b"], 4)).toBe("a, b");
    expect(formatCodeModeCallsSummary([])).toBeUndefined();
  });
});
