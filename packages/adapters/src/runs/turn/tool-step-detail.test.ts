import { describe, expect, it } from "vitest";
import {
  summarizeToolCallDetail,
  summarizeToolCallSkills,
  summarizeToolCompletionDetail,
  summarizeToolCompletionSkills,
  TOOL_STEP_DETAIL_MAX_CHARS,
} from "./tool-step-detail.js";

describe("summarizeToolCallDetail", () => {
  it("extracts clean targets for web, file, shell, and browser tools", () => {
    expect(summarizeToolCallDetail("web_fetch", { url: "https://bend-lang.com/" })).toBe(
      "https://bend-lang.com/",
    );
    expect(
      summarizeToolCallDetail("web_search", {
        query: "Bend language HigherOrderCO production ready limitations",
      }),
    ).toBe("Bend language HigherOrderCO production ready limitations");
    expect(
      summarizeToolCallDetail("write_file", { path: "src/app.ts", content: "secret body" }),
    ).toBe("src/app.ts");
    expect(summarizeToolCallDetail("read_file", { path: "README.md" })).toBe("README.md");
    expect(summarizeToolCallDetail("shell", { command: "pnpm test" })).toBe("pnpm test");
    expect(
      summarizeToolCallDetail("browser_navigate", { url: "https://github.com/HigherOrderCO/Bend" }),
    ).toBe("https://github.com/HigherOrderCO/Bend");
  });

  it("summarizes multi-line shell commands to their first non-comment line", () => {
    expect(
      summarizeToolCallDetail("shell", { command: "# comment\n\npnpm build\npnpm test" }),
    ).toBe("pnpm build …");
  });

  it("unwraps use_tool calls to summarize the underlying tool", () => {
    expect(
      summarizeToolCallDetail("use_tool", {
        name: "web_fetch",
        arguments: { url: "https://example.com/docs" },
      }),
    ).toBe("https://example.com/docs");
  });

  it("never surfaces arguments for secret or GUI input tools", () => {
    expect(summarizeToolCallDetail("request_secret", { label: "API Key" })).toBeUndefined();
    expect(
      summarizeToolCallDetail("secret_request", { url: "https://api.example.com" }),
    ).toBeUndefined();
    expect(
      summarizeToolCallDetail("browser_act", { actions: [{ kind: "fill", text: "sensitive" }] }),
    ).toBeUndefined();
    expect(
      summarizeToolCallDetail("computer_act", { actions: [{ kind: "type", text: "hunter2" }] }),
    ).toBeUndefined();
  });

  it("redacts run secrets, URL credentials, sensitive query params, and inline shell secrets", () => {
    expect(
      summarizeToolCallDetail(
        "web_fetch",
        { url: "https://user:pass@api.example.com/v1?api_key=abc123&page=2" },
        ["abc123"],
      ),
    ).toBe("https://api.example.com/v1?api_key=[redacted]&page=2");

    expect(
      summarizeToolCallDetail("shell", {
        command: "API_TOKEN=supersecret curl https://example.com",
      }),
    ).toBe("API_TOKEN=[redacted] curl https://example.com");

    expect(
      summarizeToolCallDetail("web_search", { query: "lookup my-live-secret" }, ["my-live-secret"]),
    ).not.toContain("my-live-secret");
  });

  it("clamps overly long details to a bounded single line", () => {
    const detail = summarizeToolCallDetail("web_search", { query: "a".repeat(300) });
    expect(detail).toBeDefined();
    expect(detail!.length).toBeLessThanOrEqual(TOOL_STEP_DETAIL_MAX_CHARS);
    expect(detail!.endsWith("…")).toBe(true);
  });

  it("summarizes code_mode tool/command calls and command_save/command_delete names", () => {
    expect(
      summarizeToolCallDetail("code_mode", {
        code: 'await codemode.cmd.weekly_report({ week: "w1" });',
      }),
    ).toBe("cmd.weekly_report");
    expect(
      summarizeToolCallDetail("code_mode", {
        code: `
          await codemode.board_tickets({});
          await codemode.list_fleet({});
          await codemode.list_history({});
          await codemode.drive_list({});
          await codemode.web_search({ query: "x" });
        `,
      }),
    ).toBe("board_tickets, list_fleet, list_history, drive_list +1 more");
    expect(summarizeToolCallDetail("code_mode", { code: "console.log(1 + 2);" })).toBeUndefined();
    expect(summarizeToolCallDetail("command_save", { name: "weekly_report" })).toBe(
      "cmd.weekly_report",
    );
    expect(summarizeToolCallDetail("command_delete", { name: "weekly_report" })).toBe(
      "cmd.weekly_report",
    );
  });

  it("extracts runtime calls detail from code_mode completions in both Pi and direct shapes", () => {
    expect(
      summarizeToolCompletionDetail({
        name: "code_mode",
        result: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "{}" }],
          details: { output: "ok", calls: ["board_tickets", "cmd.weekly_report", "board_tickets"] },
        },
      }),
    ).toBe("board_tickets, cmd.weekly_report");

    expect(
      summarizeToolCompletionDetail({
        name: "code_mode",
        result: { output: "ok", calls: ["a", "b", "c", "d", "e"] },
      }),
    ).toBe("a, b, c, d +1 more");

    expect(
      summarizeToolCompletionDetail({
        name: "shell",
        result: { calls: ["ignored"] },
      }),
    ).toBeUndefined();
  });

  it("extracts called skills from skill_read, use_tool, code_mode, and completions", () => {
    expect(summarizeToolCallSkills("skill_read", { name: "pr-watch" })).toEqual(["pr-watch"]);
    expect(
      summarizeToolCallSkills("use_tool", {
        name: "skill_read",
        arguments: { name: "Tasks" },
      }),
    ).toEqual(["Tasks"]);
    expect(
      summarizeToolCallSkills("code_mode", {
        code: 'await codemode.skill_read({ name: "pr-watch" }); await codemode.shell({ command: "ls" });',
      }),
    ).toEqual(["pr-watch"]);
    expect(summarizeToolCallSkills("shell", { command: "ls" })).toBeUndefined();

    expect(
      summarizeToolCompletionSkills({
        name: "skill_read",
        result: { name: "PR Watch", content: "..." },
      }),
    ).toEqual(["PR Watch"]);
    expect(
      summarizeToolCompletionSkills({
        name: "code_mode",
        result: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "{}" }],
          details: { output: "ok", skills: ["pr-watch", "PR-Watch", "deploy"] },
        },
      }),
    ).toEqual(["pr-watch", "deploy"]);
    expect(
      summarizeToolCompletionDetail({
        name: "skill_read",
        result: { name: "PR Watch" },
      }),
    ).toBe("PR Watch");
  });
});
