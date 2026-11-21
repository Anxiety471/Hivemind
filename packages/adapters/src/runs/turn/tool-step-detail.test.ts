import { describe, expect, it } from "vitest";
import { summarizeToolCallDetail, TOOL_STEP_DETAIL_MAX_CHARS } from "./tool-step-detail.js";

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
});
