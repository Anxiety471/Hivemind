import { describe, expect, it, vi } from "vitest";
import { CODE_MODE_OUTPUT_MAX_CHARS, runCodeModeScript } from "./code-mode-sandbox.js";

const tools = ["demo_list", "demo_read"];

describe("runCodeModeScript", () => {
  it("runs TypeScript, chains calls and returns only what the script prints", async () => {
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "demo_list") return { items: [{ id: "a" }, { id: "b" }] };
      return { id: args.id, body: "x".repeat(1_000) };
    });
    const result = await runCodeModeScript({
      code: `
        const { items }: { items: Array<{ id: string }> } = await codemode.demo_list({});
        const bodies = await Promise.all(items.map((item) => codemode.demo_read({ id: item.id })));
        console.log(JSON.stringify({ count: bodies.length, ids: items.map((item) => item.id) }));
      `,
      tools,
      call,
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('{"count":2,"ids":["a","b"]}');
    expect(result.calls).toEqual(["demo_list", "demo_read", "demo_read"]);
    // Serialized: the second read starts only after the first finished.
    expect(call.mock.calls.map(([name]) => name)).toEqual(["demo_list", "demo_read", "demo_read"]);
  });

  it("hands a tool rejection to the script as a catchable error with its code", async () => {
    const result = await runCodeModeScript({
      code: `
        try {
          await codemode.demo_read({ id: "missing" });
        } catch (error) {
          console.log("failed", (error as { code?: string }).code, (error as Error).message);
        }
      `,
      tools,
      call: async () => {
        throw Object.assign(new Error("no such record"), { name: "ToolFailed" });
      },
    });
    expect(result.output).toBe("failed ToolFailed no such record");
    expect(result.error).toBeUndefined();
  });

  it("refuses a name that is not installed instead of calling it", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const result = await runCodeModeScript({
      code: `
        try {
          await codemode.not_a_tool({});
        } catch (error) {
          console.log((error as { code?: string }).code);
        }
      `,
      tools,
      call,
    });
    expect(result.output).toBe("ToolUnavailable");
    expect(call).not.toHaveBeenCalled();
  });

  it("leaves every other capability undefined", async () => {
    const result = await runCodeModeScript({
      code: `
        console.log(
          typeof fetch,
          typeof require,
          typeof process,
          typeof globalThis.Deno,
          typeof import("node:fs"),
        );
      `,
      tools,
      call: async () => null,
    });
    // `import()` is a syntax-level function in the isolate, so it exists but cannot resolve;
    // nothing else does.
    expect(result.output.startsWith("undefined undefined undefined undefined")).toBe(true);
  });

  it("stops a script that never finishes", async () => {
    const result = await runCodeModeScript({
      code: "while (true) {}",
      tools,
      call: async () => null,
      timeoutMs: 100,
    });
    expect(result.error?.name).toBe("TimeoutError");
    expect(result.error?.message).toContain("100ms");
  }, 30_000);

  it("caps console output and reports truncation", async () => {
    const result = await runCodeModeScript({
      code: `console.log("x".repeat(${CODE_MODE_OUTPUT_MAX_CHARS + 5_000}));`,
      tools,
      call: async () => null,
    });
    expect(result.truncated).toBe(true);
    expect(result.output).toHaveLength(CODE_MODE_OUTPUT_MAX_CHARS);
    expect(result.error).toBeUndefined();
  });

  it("bounds the number of tool calls a script can make", async () => {
    const result = await runCodeModeScript({
      code: `
        for (let i = 0; i < 5; i += 1) {
          try { await codemode.demo_read({ id: String(i) }); } catch {}
        }
        console.log("done");
      `,
      tools,
      call: async () => ({ ok: true }),
      maxCalls: 2,
    });
    // Only the calls that ran are listed; the rest were refused at the cap.
    expect(result.calls).toHaveLength(2);
    expect(result.error?.message).toContain("at most 2 tool calls");
  });

  it("rejects a result that is not JSON", async () => {
    const result = await runCodeModeScript({
      code: "await codemode.demo_read({ id: 'x' });",
      tools,
      call: async () => ({
        circular: (() => {
          const value: Record<string, unknown> = {};
          value.self = value;
          return value;
        })(),
      }),
    });
    expect(result.error?.name).toBe("Error");
    expect(result.error?.message).toContain("not JSON");
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    const pending = runCodeModeScript({
      code: "await codemode.demo_read({ id: 'slow' }); console.log('finished');",
      tools,
      signal: controller.signal,
      timeoutMs: 10_000,
      call: () => new Promise(() => undefined),
    });
    controller.abort();
    const result = await pending;
    expect(result.error?.name).toBe("AbortError");
  });
});
