import type { AgentRuntime } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectRunTasks,
  loadGoTaskDetectContext,
  shouldEnqueueTaskDetect,
  syncTasksViaGoOrLocal,
} from "./task-detect.js";

describe("shouldEnqueueTaskDetect", () => {
  it("enqueues only for board-enabled conversational owner turns", () => {
    const base = {
      ticketBoardEnabled: true,
      trigger: "user",
      sourceMessageId: "msg-1",
      runBotId: "bot-1",
      threadBotId: "bot-1",
      threadGroupId: null,
      nonOwnerChatRun: false,
    };
    expect(shouldEnqueueTaskDetect(base)).toBe(true);
    expect(shouldEnqueueTaskDetect({ ...base, ticketBoardEnabled: false })).toBe(false);
    expect(shouldEnqueueTaskDetect({ ...base, trigger: "routine" })).toBe(false);
    expect(shouldEnqueueTaskDetect({ ...base, trigger: "tickets" })).toBe(false);
    expect(shouldEnqueueTaskDetect({ ...base, nonOwnerChatRun: true })).toBe(false);
    expect(shouldEnqueueTaskDetect({ ...base, sourceMessageId: null })).toBe(false);
    expect(shouldEnqueueTaskDetect({ ...base, threadBotId: null, threadGroupId: "group-1" })).toBe(
      true,
    );
  });
});

describe("loadGoTaskDetectContext", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns undefined when neither TASK_DETECT_URL nor MODEL_RETRY_RULES_URL is configured", async () => {
    vi.stubEnv("TASK_DETECT_URL", "");
    vi.stubEnv("MODEL_RETRY_RULES_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      loadGoTaskDetectContext({
        spaceId: "s1",
        userId: "u1",
        botId: "b1",
        promptText: "hello",
      }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives the Go gateway origin from MODEL_RETRY_RULES_URL when TASK_DETECT_URL is unset", async () => {
    vi.stubEnv("TASK_DETECT_URL", "");
    vi.stubEnv("MODEL_RETRY_RULES_URL", "http://127.0.0.1:3200/internal/model-retry/decide");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, openTickets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await loadGoTaskDetectContext({
      spaceId: "s1",
      userId: "u1",
      botId: "b1",
      promptText: "hi",
    });
    expect(result?.enabled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/internal/task-detect/context",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("calls the Go backend context endpoint and returns rendered blocks", async () => {
    vi.stubEnv("TASK_DETECT_URL", "http://127.0.0.1:3200/");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: true,
          assignedContext:
            "<assigned_tickets>\n- RAK-1 [doing/normal] Ship sync\n</assigned_tickets>",
          referencedContext: "<tickets_referenced>\n- RAK-2 [todo] Fix bug\n</tickets_referenced>",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await loadGoTaskDetectContext({
      spaceId: "s1",
      userId: "u1",
      botId: "b1",
      promptText: "Check RAK-2",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/internal/task-detect/context",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result?.enabled).toBe(true);
    expect(result?.assignedContext).toContain("RAK-1");
    expect(result?.referencedContext).toContain("RAK-2");
  });
});

describe("detectRunTasks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prepares via Go, runs the configured model, and applies results through Go", async () => {
    vi.stubEnv("TASK_DETECT_URL", "http://127.0.0.1:3200");
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/prepare")) {
        return new Response(
          JSON.stringify({
            inspect: true,
            systemPrompt: "Extract JSON",
            userPrompt: "User asked to deploy Go backend",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          created: [{ id: "t1", ref: "RAK-1", title: "Deploy Go backend", status: "doing" }],
          updated: [],
          skipped: 0,
        }),
        { status: 200 },
      );
    });

    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          threadId: "thread-1",
        })),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as never;

    const runtime = {
      run: vi.fn(async function* () {
        yield {
          type: "done",
          text: '{"actions":[{"op":"create","title":"Deploy Go backend","status":"doing"}]}',
        };
      }),
    } as unknown as AgentRuntime;

    const applied = await detectRunTasks(
      {
        prisma,
        runtime,
        resolveModel: async () => ({ provider: "test-provider", id: "test-model", apiKey: "k" }),
      },
      "run-1",
      ["msg-2"],
    );

    expect(applied?.created).toHaveLength(1);
    expect(applied?.created[0]?.ref).toBe("RAK-1");
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:3200/internal/task-detect/prepare",
      "http://127.0.0.1:3200/internal/task-detect/apply",
    ]);
    expect(calls[0]?.body.answeredMessageIds).toEqual(["msg-2"]);
    expect(calls[1]?.body.rawOutput).toContain("Deploy Go backend");
  });

  it("stops before invoking the model when Go marks the turn ineligible", async () => {
    vi.stubEnv("TASK_DETECT_URL", "http://127.0.0.1:3200");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ inspect: false, reason: "trivial_message" }), { status: 200 }),
    );
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-2",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          threadId: "thread-1",
        })),
      },
    } as never;
    const runSpy = vi.fn();
    const runtime = { run: runSpy } as unknown as AgentRuntime;

    await expect(detectRunTasks({ prisma, runtime }, "run-2")).resolves.toBeUndefined();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("syncTasksViaGoOrLocal", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts structured actions directly to the Go backend apply endpoint", async () => {
    vi.stubEnv("TASK_DETECT_URL", "http://127.0.0.1:3200");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          created: [{ id: "t-1", ref: "RAK-1", title: "Ship UI", status: "doing" }],
          updated: [],
          skipped: 0,
        }),
        { status: 200 },
      ),
    );
    const prisma = {} as never;
    const result = await syncTasksViaGoOrLocal(
      { prisma },
      {
        runId: "run-9",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        actions: [{ op: "create", title: "Ship UI", status: "doing" }],
      },
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/internal/task-detect/apply",
      expect.objectContaining({ method: "POST" }),
    );
    expect("created" in result && result.created[0]?.ref).toBe("RAK-1");
  });
});
