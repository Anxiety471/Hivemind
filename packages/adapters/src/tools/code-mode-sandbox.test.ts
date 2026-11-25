import { deferred } from "@rakazo/core/test-async";
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

  it("runs concurrent-safe calls in parallel while keeping exclusive calls as FIFO barriers", async () => {
    const events: string[] = [];
    const read1 = deferred<string>();
    const read2 = deferred<string>();
    const write = deferred<string>();
    const read3 = deferred<string>();
    const gates = [read1, read2, write, read3];
    let index = 0;
    const pending = runCodeModeScript({
      code: `
        const p1 = codemode.demo_read({ id: "1" });
        const p2 = codemode.demo_read({ id: "2" });
        const p3 = codemode.demo_write({ id: "3" });
        const p4 = codemode.demo_read({ id: "4" });
        console.log(JSON.stringify(await Promise.all([p1, p2, p3, p4])));
      `,
      tools: ["demo_read", "demo_write"],
      canRunConcurrently: (name) => name === "demo_read",
      call: async (name, args) => {
        const tag = `${name}:${args.id}`;
        events.push(`start:${tag}`);
        const value = await gates[index++]!.promise;
        events.push(`end:${tag}`);
        return value;
      },
    });
    await vi.waitFor(() => {
      expect(events).toEqual(["start:demo_read:1", "start:demo_read:2"]);
    });
    read2.resolve("r2");
    read1.resolve("r1");
    await vi.waitFor(() => {
      expect(events).toContain("start:demo_write:3");
    });
    expect(events).not.toContain("start:demo_read:4");
    write.resolve("w3");
    await vi.waitFor(() => {
      expect(events).toContain("start:demo_read:4");
    });
    read3.resolve("r4");
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('["r1","r2","w3","r4"]');
    expect(result.calls).toEqual(["demo_read", "demo_read", "demo_write", "demo_read"]);
  });

  it("handles late host settlement after abort without throwing", async () => {
    const controller = new AbortController();
    const slow = deferred<{ ok: boolean }>();
    const pending = runCodeModeScript({
      code: "await codemode.demo_read({ id: 'slow' });",
      tools,
      signal: controller.signal,
      timeoutMs: 10_000,
      call: () => slow.promise,
    });
    await vi.waitFor(() => {
      // wait until the call is in flight
      controller.abort();
    });
    const result = await pending;
    expect(result.error?.name).toBe("AbortError");
    slow.resolve({ ok: true });
    await Promise.resolve();
  });

  it("returns SyntaxError instead of throwing on invalid TypeScript", async () => {
    const result = await runCodeModeScript({
      code: "const x = ;",
      tools,
      call: async () => null,
    });
    expect(result.error?.name).toBe("SyntaxError");
    expect(result.calls).toEqual([]);
  });

  it("fails fast when a script leaves an unresolved promise with no host calls", async () => {
    const result = await runCodeModeScript({
      code: "await new Promise(() => {});",
      tools,
      timeoutMs: 10_000,
      call: async () => null,
    });
    expect(result.error?.name).toBe("Error");
    expect(result.error?.message).toContain("unresolved promise");
  });

  it("supports warn/info, errors, undefined, circular logs and accurate newline truncation", async () => {
    const exact = await runCodeModeScript({
      code: `console.log("x".repeat(${CODE_MODE_OUTPUT_MAX_CHARS}));`,
      tools,
      call: async () => null,
    });
    expect(exact.truncated).toBe(false);
    expect(exact.output).toHaveLength(CODE_MODE_OUTPUT_MAX_CHARS);

    const multiline = await runCodeModeScript({
      code: `
        console.warn("a".repeat(${CODE_MODE_OUTPUT_MAX_CHARS - 2}));
        console.info("bcdef");
      `,
      tools,
      call: async () => null,
    });
    expect(multiline.truncated).toBe(true);
    expect(multiline.output.length).toBeLessThanOrEqual(CODE_MODE_OUTPUT_MAX_CHARS);

    const formatted = await runCodeModeScript({
      code: `
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        console.log(undefined, new Error("boom"), circular);
      `,
      tools,
      call: async () => null,
    });
    expect(formatted.error).toBeUndefined();
    expect(formatted.output).toContain("undefined");
    expect(formatted.output).toContain("Error: boom");
    expect(formatted.output).toContain("[object Object]");
  });

  it("injects globals cleanly across repeated executions", async () => {
    const script = `console.log(JSON.stringify(globalThis.__args));`;
    const first = await runCodeModeScript({
      code: script,
      tools,
      globals: { __args: { n: 1 } },
      call: async () => null,
    });
    const second = await runCodeModeScript({
      code: script,
      tools,
      globals: { __args: { n: 2 } },
      call: async () => null,
    });
    expect(first.output).toBe('{"n":1}');
    expect(second.output).toBe('{"n":2}');
  });

  it("captures top-level return values for scripts without touching command mode", async () => {
    const obj = await runCodeModeScript({
      code: "return { ok: true, count: 3 };",
      tools,
      call: async () => null,
    });
    expect(obj.error).toBeUndefined();
    expect(obj.output).toBe("");
    expect(obj.returnValue).toBe('{"ok":true,"count":3}');

    const str = await runCodeModeScript({
      code: 'console.log("step"); return "done";',
      tools,
      call: async () => null,
    });
    expect(str.output).toBe("step");
    expect(str.returnValue).toBe("done");

    const none = await runCodeModeScript({
      code: 'console.log("only log");',
      tools,
      call: async () => null,
    });
    expect(none.returnValue).toBeUndefined();
  });

  it("forwards call args to canRunConcurrently", async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    await runCodeModeScript({
      code: 'await codemode.demo_read({ id: "42" });',
      tools,
      canRunConcurrently: (name, args) => {
        seen.push([name, args]);
        return true;
      },
      call: async () => ({ ok: true }),
    });
    expect(seen).toEqual([["demo_read", { id: "42" }]]);
  });
});
