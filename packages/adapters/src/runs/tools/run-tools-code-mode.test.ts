import { deferred } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "../../approvals/approval-effect.js";

const pauses = vi.hoisted(() => ({ names: new Set<string>() }));
const paused = () => ({
  kind: "agent_tool_result",
  content: [{ type: "text", text: "Waiting for approval." }],
  details: { approval: "paused" },
  terminate: true,
});

vi.mock("./run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-tool-gate.js")>()),
  // Approval rules get their own tests; here the gate lets each call through so the
  // behavior under test is how code_mode bridges, pauses and reports.
  gateToolCall: vi.fn(
    async (
      _ctx: unknown,
      request: { name: string; args: unknown; executionId: string },
      observer?: unknown,
      commandTimeoutMs?: number,
    ): Promise<unknown> =>
      pauses.names.has(request.name)
        ? { result: paused() }
        : {
            call: {
              name: request.name,
              args: request.args,
              executionId: request.executionId,
              observer,
              commandTimeoutMs,
              connectorCall: {
                tool: request.name,
                args: request.args,
                executionId: request.executionId,
              },
              effectKey: `effect-${request.name}`,
              applied: undefined,
              nextApprovedTool: undefined,
              bypassApproval: false,
              claimedEffect: false,
              persistEffectResult: async () => true,
              finish: async (result: unknown) => result,
              claimOrReturn: async () => undefined,
            },
          },
  ),
  auditToolCall: vi.fn(async () => undefined),
}));

import { gateToolCall } from "./run-tool-gate.js";
import { applyTool } from "./run-tools.js";

const demoSearch = {
  name: "demo_search",
  description: "Search the demo records.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  readOnly: true,
  route: { connectorId: "demo", resourceId: "records", toolName: "search" },
};

const demoWrite = {
  name: "demo_write",
  description: "Create a demo record.",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
  readOnly: false,
  route: { connectorId: "demo", resourceId: "records", toolName: "create" },
};

const codeModeTool = {
  name: "code_mode",
  description: "Run TypeScript.",
  inputSchema: { type: "object", properties: { code: { type: "string" } } },
  readOnly: true,
};

function context(
  execute: () => AsyncGenerator<{ type: string; data: unknown }> = vi.fn(async function* () {
    yield { type: "result", data: { rows: [{ id: "r1" }, { id: "r2" }] } };
  }),
  commands: Record<string, { description: string; code: string }> = {},
) {
  const ctx = {
    deps: {
      prisma: {
        bot: { findUnique: async () => null },
        user: {
          findUniqueOrThrow: async () => ({
            timezone: "UTC" as string | null,
            marketingEmailOptOutAt: null,
          }),
        },
        steeringMessage: { findFirst: async () => null },
        codeCommand: {
          findMany: vi.fn(
            async (args?: {
              where?: { name?: { in?: string[] } };
              select?: { code?: boolean };
            }) => {
              const names = args?.where?.name?.in;
              const entries = names
                ? Object.entries(commands).filter(([name]) => names.includes(name))
                : Object.entries(commands);
              return entries.map(([name, row]) => ({
                name,
                description: row.description,
                parameters: null,
                ...(args?.select?.code ? { code: row.code } : {}),
              }));
            },
          ),
          findUnique: vi.fn(async ({ where }: { where: { name: string } }) => {
            const row = commands[where.name];
            return row ? { name: where.name, parameters: null, ...row } : null;
          }),
        },
      },
      connector: { execute },
    },
    run: { userId: "user-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    source: { ownerStartedRun: true },
    runId: "run-1",
    state: { tainted: false, handedOff: false, ownerSettingsRefused: false },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      receivedOutsideMessage: async () => false,
    },
    tools: {
      offered: [codeModeTool, demoSearch, demoWrite],
      builtins: [codeModeTool],
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
      connector: new Map<string, typeof demoSearch | typeof demoWrite>([
        ["demo_search", demoSearch],
        ["demo_write", demoWrite],
      ]),
      connectedPlugins: [],
    },
    context: { signal: new AbortController().signal },
    secrets: [],
  };
  return { ctx, execute };
}

beforeEach(() => {
  vi.mocked(gateToolCall).mockClear();
  pauses.names.clear();
});

describe("code_mode", () => {
  it("runs one script over the run's read-only connector tools and returns its output", async () => {
    const { ctx, execute } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          const { rows } = await codemode.demo_search({ query: "alpha" });
          const count = rows.length;
          console.log(JSON.stringify({ count, first: rows[0].id }));
        `,
      },
      "outer-1",
    )) as { output: string; calls: string[] };
    expect(result.output).toBe('{"count":2,"first":"r1"}');
    expect(result.calls).toEqual(["demo_search"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("gives each call its own stable execution id, in script order", async () => {
    const { ctx } = context();
    await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_search({ query: "one" });
          await codemode.demo_search({ query: "two" });
        `,
      },
      JSON.stringify(["pi-tool", "main", "provider-call-1"]),
    );
    const ids = vi
      .mocked(gateToolCall)
      .mock.calls.map(([, request]) => ("executionId" in request ? request.executionId : undefined))
      .slice(1);
    expect(ids).toEqual([
      JSON.stringify(["pi-tool", "main", "provider-call-1:code:0"]),
      JSON.stringify(["pi-tool", "main", "provider-call-1:code:1"]),
    ]);
  });

  it("stops the script and ends the turn when a call pauses for approval", async () => {
    const { ctx, execute } = context();
    pauses.names.add("demo_search");
    const result = await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_search({ query: "needs approval" });
          console.log("should not run");
        `,
      },
      "outer-1",
    );
    expect(result).toMatchObject({ details: { approval: "paused" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops at the pause even when the script catches the refusal", async () => {
    const { ctx, execute } = context();
    pauses.names.add("demo_search");
    const result = await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          try { await codemode.demo_search({ query: "needs approval" }); } catch {}
          await codemode.demo_search({ query: "after the pause" });
          console.log("continued");
        `,
      },
      "outer-1",
    );
    expect(result).toMatchObject({ details: { approval: "paused" } });
    expect(execute).not.toHaveBeenCalled();
    expect(vi.mocked(gateToolCall)).toHaveBeenCalledTimes(2);
  });

  it("does not install a tool the run does not offer", async () => {
    const { ctx } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: "try { await codemode.shell({ command: 'id' }); } catch (e) { console.log(e.code); }",
      },
      "outer-1",
    )) as { output: string };
    expect(result.output).toBe("ToolUnavailable");
  });

  it("runs a write tool through the same gate as a direct call", async () => {
    const { ctx, execute } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      { code: 'await codemode.demo_write({ title: "t" }); console.log("done");' },
      "outer-1",
    )) as { output: string; calls: string[] };
    expect(result.output).toBe("done");
    expect(result.calls).toEqual(["demo_write"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateToolCall).mock.calls.map(([, request]) => request.name)).toEqual([
      "code_mode",
      "demo_write",
    ]);
  });

  it("ends the turn when a write asks the person, after the reads before it ran", async () => {
    const { ctx, execute } = context();
    pauses.names.add("demo_write");
    const result = await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_search({ query: "a" });
          await codemode.demo_write({ title: "needs approval" });
          console.log("should not run");
        `,
      },
      "outer-1",
    );
    expect(result).toMatchObject({ details: { approval: "paused" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("lets a script make at most eight writes", async () => {
    const { ctx, execute } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          let made = 0;
          try {
            for (let i = 0; i < 20; i++) { await codemode.demo_write({ title: String(i) }); made++; }
          } catch (e) { console.log(e.code, made); }
        `,
      },
      "outer-1",
    )) as { output: string };
    expect(result.output).toBe("WriteLimitReached 8");
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("does not count reads against the write limit", async () => {
    const { ctx, execute } = context();
    await applyTool(
      ctx as never,
      "code_mode",
      { code: "for (let i = 0; i < 12; i++) await codemode.demo_search({ query: String(i) });" },
      "outer-1",
    );
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it("treats what an earlier call in the script read as outside content for the next call", async () => {
    const seen: boolean[] = [];
    const execute = vi.fn(async function* () {
      seen.push(ctx.state.tainted);
      yield { type: "result", data: { rows: [] } };
    });
    const { ctx } = context(execute);
    await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_search({ query: "a" });
          await codemode.demo_write({ title: "chosen after reading" });
        `,
      },
      "outer-1",
    );
    expect(seen).toEqual([false, true]);
  });

  it("answers codemode.search from the offered tools without running one", async () => {
    const { ctx, execute } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          const hits = await codemode.search({ query: "record" });
          console.log(JSON.stringify(hits.map((hit) => [hit.name, hit.writes])));
        `,
      },
      "outer-1",
    )) as { output: string };
    expect(result.output).toBe('[["demo_search",false],["demo_write",true]]');
    expect(execute).not.toHaveBeenCalled();
    expect(vi.mocked(gateToolCall)).toHaveBeenCalledTimes(1);
  });

  it("describes at most five names in one call", async () => {
    const { ctx } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `console.log((await codemode.describe({ names: ["a", "b", "c", "d", "e", "f", "g"] })).length);`,
      },
      "outer-1",
    )) as { output: string };
    expect(result.output.trim()).toBe("5");
  });

  it("returns the script's failure with the calls it made so far", async () => {
    const { ctx } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_search({ query: "one" });
          throw new Error("stop here");
        `,
      },
      "outer-1",
    )) as { error: string; calls: string[] };
    expect(result.error).toBe("Error: stop here");
    expect(result.calls).toEqual(["demo_search"]);
  });

  it("never installs a tool that acts on the person's own computer", async () => {
    const { ctx } = context();
    for (const name of ["user_computer_shell", "user_computer_observe", "user_computer_act"]) {
      ctx.tools.offered.push({ name, description: name, inputSchema: {} } as never);
    }
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          for (const name of ["user_computer_shell", "user_computer_observe", "user_computer_act"]) {
            try { await codemode[name]({}); console.log("ran " + name); } catch (e) { console.log(e.code); }
          }
        `,
      },
      "outer-1",
    )) as { output: string };
    expect(result.output).toBe("ToolUnavailable\nToolUnavailable\nToolUnavailable");
  });

  it("gives each call a shell time limit and the turn's observer for a command that keeps running", async () => {
    const { ctx } = context();
    const observer = { onShellStillRunning: vi.fn() };
    await applyTool(
      ctx as never,
      "code_mode",
      { code: 'await codemode.demo_search({ query: "a" });' },
      "outer-1",
      undefined,
      observer as never,
    );
    const inner = vi.mocked(gateToolCall).mock.calls[1];
    expect(inner?.[2]).toBe(observer);
    expect(inner?.[3]).toBe(45_000);
  });

  it("ends the script when a command is still running and tells the model not to run it again", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "result", data: { stdout: "building", stderr: "", code: null, running: true } };
    });
    const { ctx } = context(execute);
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          console.log("before");
          try { await codemode.demo_search({ query: "slow" }); } catch {}
          await codemode.demo_search({ query: "after" });
          console.log("after");
        `,
      },
      "outer-1",
    )) as { output: string; error: string; calls: string[] };
    expect(result.output).toBe("before");
    expect(result.error).toMatch(/^ShellStillRunning: .*Do not run it again\.$/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs read-only connector calls concurrently while keeping writes as barriers", async () => {
    const d1 = deferred<{ rows: string[] }>();
    const d2 = deferred<{ rows: string[] }>();
    const dw = deferred<{ ok: boolean }>();
    const events: string[] = [];
    let readIndex = 0;
    const execute = vi.fn(async function* (call: {
      tool: string;
      args: { query?: string; title?: string };
    }) {
      if (call.tool === "demo_search") {
        events.push(`start:read:${call.args.query}`);
        const data = await [d1, d2][readIndex++]!.promise;
        events.push(`end:read:${call.args.query}`);
        yield { type: "result", data };
      } else {
        events.push(`start:write:${call.args.title}`);
        const data = await dw.promise;
        events.push(`end:write:${call.args.title}`);
        yield { type: "result", data };
      }
    });
    const { ctx } = context(execute as never);
    const pending = applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          const p1 = codemode.demo_search({ query: "a" });
          const p2 = codemode.demo_search({ query: "b" });
          const p3 = codemode.demo_write({ title: "w" });
          await Promise.all([p1, p2, p3]);
          console.log("ok");
        `,
      },
      "outer-1",
    ) as Promise<{ output: string }>;
    await vi.waitFor(() => {
      expect(events).toEqual(["start:read:a", "start:read:b"]);
    });
    d2.resolve({ rows: ["2"] });
    d1.resolve({ rows: ["1"] });
    await vi.waitFor(() => {
      expect(events).toContain("start:write:w");
    });
    dw.resolve({ ok: true });
    const result = await pending;
    expect(result.output).toBe("ok");
  });

  it("lints forbidden capabilities before running earlier tools in the script", async () => {
    const { ctx, execute } = context();
    const result = (await applyTool(
      ctx as never,
      "code_mode",
      {
        code: `
          await codemode.demo_write({ title: "should not run" });
          await fetch("https://example.com");
        `,
      },
      "outer-1",
    )) as { error?: string; calls?: string[] };
    expect(result.error).toContain("LintError");
    expect(result.error).toContain("no-fetch");
    expect(result.calls).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("saved commands", () => {
  const commands = {
    count_rows: {
      description: "Count the demo rows matching a query.",
      code: `
        console.log("this prints nothing");
        const { rows } = await codemode.demo_search({ query: args.query });
        return { count: rows.length };
      `,
    },
    write_many: {
      description: "Create several demo records.",
      code: `
        for (let i = 0; i < args.n; i++) await codemode.demo_write({ title: String(i) });
        return "done";
      `,
    },
    calls_another: {
      description: "Calls a command.",
      code: `return await codemode.cmd.count_rows({ query: "x" });`,
    },
  };
  const run = (ctx: ReturnType<typeof context>["ctx"], code: string) =>
    applyTool(ctx as never, "code_mode", { code }, "outer-1") as Promise<{
      output?: string;
      error?: string;
      calls?: string[];
    }>;

  it("calls a command with arguments and returns what it returns, without its own output", async () => {
    const { ctx, execute } = context(undefined, commands);
    const result = await run(
      ctx,
      `console.log(JSON.stringify(await codemode.cmd.count_rows({ query: "alpha" })));`,
    );
    expect(result.output).toBe('{"count":2}');
    expect(result.calls).toEqual(["cmd.count_rows"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("counts reading a command's result as reading outside content", async () => {
    const { ctx } = context(undefined, commands);
    expect(ctx.state.tainted).toBe(false);
    await run(ctx, `await codemode.cmd.count_rows({ query: "alpha" });`);
    expect(ctx.state.tainted).toBe(true);
  });

  it("reports a command that does not exist, and does not taint the run", async () => {
    const { ctx } = context(undefined, commands);
    const result = await run(ctx, `await codemode.cmd.nothing_here({});`);
    expect(result.error).toMatch(/There is no saved command cmd\.nothing_here/);
    expect(ctx.state.tainted).toBe(false);
  });

  it("does not let a command call another command", async () => {
    const { ctx } = context(undefined, commands);
    const result = await run(ctx, `await codemode.cmd.calls_another({});`);
    expect(result.error).toMatch(/cannot call another command/);
  });

  it("counts the writes a command makes toward the script's limit", async () => {
    const { ctx, execute } = context(undefined, commands);
    const result = await run(ctx, `await codemode.cmd.write_many({ n: 9 });`);
    expect(result.error).toMatch(/at most 8 writes/);
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("stops the whole script when a call inside a command pauses", async () => {
    const { ctx, execute } = context(undefined, commands);
    pauses.names.add("demo_write");
    const result = await run(
      ctx,
      `await codemode.cmd.write_many({ n: 2 }); console.log("should not run");`,
    );
    expect(result).toMatchObject({ details: { approval: "paused" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("finds saved commands with codemode.search, named as they are called", async () => {
    const { ctx } = context(undefined, commands);
    const result = await run(
      ctx,
      `console.log(JSON.stringify(await codemode.search({ query: "several records" })));`,
    );
    expect(JSON.parse(result.output ?? "[]")).toEqual([
      expect.objectContaining({
        name: "cmd.write_many",
        description: "Create several demo records.",
      }),
    ]);
  });

  it("describes a command with its code, a tool with its full schema, and says what it cannot find", async () => {
    const { ctx, execute } = context(undefined, commands);
    const result = await run(
      ctx,
      `console.log(JSON.stringify(await codemode.describe({ names: ["cmd.write_many", "demo_search", "nothing", "cmd.missing"] })));`,
    );
    expect(JSON.parse(result.output ?? "[]")).toEqual([
      expect.objectContaining({
        name: "cmd.write_many",
        description: "Create several demo records.",
        code: expect.stringContaining("demo_write"),
      }),
      {
        name: "demo_search",
        description: "Search the demo records.",
        inputSchema: demoSearch.inputSchema,
        writes: false,
      },
      expect.objectContaining({
        name: "nothing",
        error: expect.stringContaining("codemode.search"),
      }),
      expect.objectContaining({
        name: "cmd.missing",
        error: expect.stringContaining("not a tool"),
      }),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("caches command lookups across searches/calls and batches describe queries", async () => {
    const { ctx } = context(undefined, commands);
    await run(
      ctx,
      `
        await codemode.search({ query: "count" });
        await codemode.search({ query: "write" });
        await codemode.describe({ names: ["cmd.count_rows", "cmd.write_many"] });
        await codemode.cmd.count_rows({ query: "a" });
        await codemode.cmd.count_rows({ query: "b" });
      `,
    );
    expect(vi.mocked(ctx.deps.prisma.codeCommand.findMany)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.deps.prisma.codeCommand.findUnique)).not.toHaveBeenCalled();
  });

  it("invalidates cached commands when command_save runs inside a script", async () => {
    const { ctx } = context(undefined, commands);
    const saveTool = {
      name: "command_save",
      description: "Save command.",
      inputSchema: { type: "object" },
    };
    ctx.tools.offered.push(saveTool as never);
    (ctx.deps.prisma.codeCommand as Record<string, unknown>).count = vi.fn(async () => 1);
    (ctx.deps.prisma.codeCommand as Record<string, unknown>).upsert = vi.fn(async ({ create }) => {
      commands[create.name as keyof typeof commands] = {
        description: create.description,
        code: create.code,
      };
      return create;
    });
    await run(
      ctx,
      `
        await codemode.search({ query: "count" });
        await codemode.command_save({ name: "fresh_cmd", description: "Fresh one.", code: "return 42;" });
        const hits = await codemode.search({ query: "fresh_cmd" });
        console.log(hits.map((h) => h.name).join(","));
      `,
    );
    expect(vi.mocked(ctx.deps.prisma.codeCommand.findMany)).toHaveBeenCalledTimes(2);
  });

  it("shares the 32-call limit across outer script and nested saved commands", async () => {
    const { ctx, execute } = context(undefined, {
      many_reads: {
        description: "Reads many times.",
        code: `
          for (let i = 0; i < args.n; i++) await codemode.demo_search({ query: String(i) });
          return "ok";
        `,
      },
    });
    const result = await run(
      ctx,
      `
        await codemode.cmd.many_reads({ n: 20 });
        for (let i = 0; i < 15; i++) await codemode.demo_search({ query: String(i) });
      `,
    );
    expect(result.error).toMatch(/at most 32 tool calls/);
    expect(execute).toHaveBeenCalledTimes(32);
  });

  it("rejects command_save when code fails lint or syntax check without writing", async () => {
    const { ctx } = context(undefined, commands);
    const upsert = vi.fn();
    (ctx.deps.prisma.codeCommand as Record<string, unknown>).upsert = upsert;
    const saveTool = {
      name: "command_save",
      description: "Save command.",
      inputSchema: { type: "object" },
    };
    ctx.tools.offered.push(saveTool as never);

    const lintRejected = (await applyTool(
      ctx as never,
      "command_save",
      {
        name: "bad_fetch",
        description: "Tries fetch.",
        code: 'return await fetch("https://example.com");',
      },
      "outer-1",
    )) as { error?: string };
    expect(lintRejected.error).toContain("no-fetch");

    const nestedRejected = (await applyTool(
      ctx as never,
      "command_save",
      {
        name: "bad_nested",
        description: "Tries nesting.",
        code: "return await codemode.cmd.count_rows({});",
      },
      "outer-2",
    )) as { error?: string };
    expect(nestedRejected.error).toContain("cannot call another command");

    const syntaxRejected = (await applyTool(
      ctx as never,
      "command_save",
      {
        name: "bad_syntax",
        description: "Broken syntax.",
        code: "const x = ;",
      },
      "outer-3",
    )) as { error?: string };
    expect(syntaxRejected.error).toContain("SyntaxError");
    expect(upsert).not.toHaveBeenCalled();
  });
});
