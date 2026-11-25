import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "../../approvals/approval-effect.js";
import { ROUTINE_PREPARE_NOTE_START } from "../../routines/routine-prepare.prompt.js";
import type * as GateModule from "../tools/run-tool-gate.js";

const refused = vi.hoisted(() => ({ names: new Set<string>() }));

vi.mock("../tools/run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GateModule>()),
  // Approval rules get their own tests; here a call either runs or is refused as the gate
  // refuses one that would ask while preparing.
  gateToolCall: vi.fn(
    async (_ctx: unknown, request: { name: string; args: unknown; executionId: string }) =>
      refused.names.has(request.name)
        ? { result: { error: `${request.name} needs approval` } }
        : {
            call: {
              name: request.name,
              args: request.args,
              executionId: request.executionId,
              connectorCall: {
                tool: request.name,
                args: request.args,
                executionId: request.executionId,
              },
              effectKey: `effect-${request.name}`,
              applied: undefined,
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

vi.mock("../lifecycle/run-complete.js", () => ({ completeRun: vi.fn(async () => undefined) }));

import { completeRun } from "../lifecycle/run-complete.js";
import { prepareRoutineRun, runRoutinePrepare } from "./run-routine-prepare.js";

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

function context(
  commands: Record<string, { code: string; parameters?: Record<string, unknown> }>,
  prepare: unknown = { command: "inbox", args: {} },
) {
  const execute = vi.fn(async function* () {
    yield { type: "result", data: { rows: [{ id: "r1" }] } };
  });
  const taskUpdate = vi.fn(async () => ({}));
  const ctx = {
    deps: {
      prisma: {
        bot: { findUnique: async () => null },
        steeringMessage: { findFirst: async () => null },
        routine: { findUnique: vi.fn(async () => ({ id: "routine-1", prepare })) },
        task: { update: taskUpdate },
        codeCommand: {
          findUnique: vi.fn(
            async ({ where }: { where: { spaceId_name: { spaceId: string; name: string } } }) => {
              const name = where.spaceId_name.name;
              const row = commands[name];
              return row
                ? {
                    name,
                    description: "d",
                    icon: null,
                    parameters: row.parameters ?? null,
                    code: row.code,
                  }
                : null;
            },
          ),
        },
      },
      connector: { execute },
    },
    run: { userId: "user-1", spaceId: "space-1", trigger: "routine", routineId: "routine-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    source: { ownerStartedRun: false },
    runId: "run-1",
    state: {
      tainted: false,
      handedOff: false,
      ownerSettingsRefused: false,
      preparing: false,
      reply: { assembled: "", currentTextSegment: "", textSinceLastStep: "" },
    },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      receivedOutsideMessage: async () => false,
    },
    tools: {
      offered: [demoSearch, demoWrite],
      builtins: [],
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
      connector: new Map<string, typeof demoSearch | typeof demoWrite>([
        ["demo_search", demoSearch],
        ["demo_write", demoWrite],
      ]),
      connectedPlugins: [],
    },
    context: { signal: new AbortController().signal },
    secrets: ["hunter2"] as string[],
  };
  return { ctx, execute, taskUpdate };
}

beforeEach(() => {
  refused.names.clear();
  vi.mocked(completeRun).mockClear();
});

describe("runRoutinePrepare", () => {
  it("hands what a read-only command returns to the model and taints the run", async () => {
    const { ctx, execute } = context({
      inbox: {
        code: "const { rows } = await codemode.demo_search({ query: args.q }); return { count: rows.length };",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    });
    const outcome = await runRoutinePrepare(ctx as never, { command: "inbox", args: { q: "new" } });
    expect(outcome).toEqual({
      kind: "note",
      note: expect.stringContaining('"count": 1'),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.state.tainted).toBe(true);
    expect(ctx.state.preparing).toBe(false);
  });
  it("does not offer tools that write, or other saved commands", async () => {
    const writes = context({
      inbox: {
        code: `try { await codemode.demo_write({ title: "x" }); } catch (e) { return { refused: true }; }`,
      },
    });
    expect(await runRoutinePrepare(writes.ctx as never, { command: "inbox", args: {} })).toEqual({
      kind: "note",
      note: expect.stringContaining('"refused": true'),
    });
    expect(writes.execute).not.toHaveBeenCalled();
    const nested = context({ inbox: { code: "return await codemode.cmd.other({});" } });
    expect(await runRoutinePrepare(nested.ctx as never, { command: "inbox", args: {} })).toEqual({
      kind: "note",
      note: expect.stringContaining("cannot call another command"),
    });
  });

  it("ends the run without the model on skip, and posts on post", async () => {
    const skip = context({ inbox: { code: "return { skip: true };" } });
    expect(await runRoutinePrepare(skip.ctx as never, { command: "inbox", args: {} })).toEqual({
      kind: "skip",
    });
    const post = context({ inbox: { code: 'return { post: "  Nothing new; key hunter2  " };' } });
    expect(await runRoutinePrepare(post.ctx as never, { command: "inbox", args: {} })).toEqual({
      kind: "post",
      text: expect.not.stringContaining("hunter2"),
    });
  });

  it("tells the model why the command failed instead of failing the run", async () => {
    const missing = context({});
    expect(await runRoutinePrepare(missing.ctx as never, { command: "gone", args: {} })).toEqual({
      kind: "note",
      note: expect.stringContaining("There is no saved command named gone."),
    });
    refused.names.add("demo_search");
    const asks = context({ inbox: { code: "return await codemode.demo_search({});" } });
    expect(await runRoutinePrepare(asks.ctx as never, { command: "inbox", args: {} })).toEqual({
      kind: "note",
      note: expect.stringContaining("demo_search needs approval"),
    });
  });
});

describe("prepareRoutineRun", () => {
  it("saves the note in the task's prompt so a resumed run does not run the command again", async () => {
    const { ctx, taskUpdate } = context({ inbox: { code: "return { ok: true };" } });
    const task = { id: "task-1", prompt: "Summarize my inbox." };
    expect(await prepareRoutineRun(ctx as never, task, false)).toBe(false);
    expect(task.prompt).toContain(`${ROUTINE_PREPARE_NOTE_START}cmd.inbox`);
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { prompt: task.prompt },
    });
    expect(await prepareRoutineRun(ctx as never, task, false)).toBe(false);
    expect(taskUpdate).toHaveBeenCalledTimes(1);
  });

  it("completes the run with the posted text and no model turn", async () => {
    const { ctx } = context({ inbox: { code: 'return { post: "All clear." };' } });
    expect(await prepareRoutineRun(ctx as never, { id: "task-1", prompt: "Check." }, false)).toBe(
      true,
    );
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(ctx.state.reply.assembled).toBe("All clear.");
  });

  it("leaves other runs, runs without a prepare command and resumed turns alone", async () => {
    const none = context({}, null);
    expect(await prepareRoutineRun(none.ctx as never, { id: "t", prompt: "p" }, false)).toBe(false);
    const resumed = context({ inbox: { code: 'return { post: "x" };' } });
    expect(await prepareRoutineRun(resumed.ctx as never, { id: "t", prompt: "p" }, true)).toBe(
      false,
    );
    const chat = context({ inbox: { code: 'return { post: "x" };' } });
    chat.ctx.run.trigger = "user";
    expect(await prepareRoutineRun(chat.ctx as never, { id: "t", prompt: "p" }, false)).toBe(false);
    expect(completeRun).not.toHaveBeenCalled();
  });
});
