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
    ): Promise<unknown> =>
      pauses.names.has(request.name)
        ? { result: paused() }
        : {
            call: {
              name: request.name,
              args: request.args,
              executionId: request.executionId,
              observer: undefined,
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
  execute = vi.fn(async function* () {
    yield { type: "result", data: { rows: [{ id: "r1" }, { id: "r2" }] } };
  }),
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
});
