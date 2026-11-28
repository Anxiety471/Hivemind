import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelState = vi.hoisted(() => ({
  primary: null as null | { provider: string; modelId: string; credentialId?: string },
  resolved: vi.fn(),
}));

vi.mock("../../models/model-roles.js", () => ({
  effectiveModelRole: async () => ({ primary: modelState.primary, backups: [] }),
}));

vi.mock("./run-model.js", () => ({
  resolveConnectedRunModel: (...args: unknown[]) => modelState.resolved(...args),
}));

import {
  finalReplyDecisionJudge,
  judgeFinalReplyDecision,
  parseFinalReplyDecision,
} from "./final-reply-judge.js";

const mainModel = { provider: "main-provider", id: "main-model", apiKey: "main-key" };
const checkerModel = { provider: "checker-provider", id: "checker-model", apiKey: "checker-key" };

function fakeRuntime(text: string) {
  const run = vi.fn(async function* () {
    yield { type: "done" as const, text };
  });
  return { run, runtime: { run } as unknown as AgentRuntime };
}

describe("parseFinalReplyDecision", () => {
  it("reads only an explicit needsDecision true", () => {
    expect(parseFinalReplyDecision('{"needsDecision":true}')).toBe(true);
    expect(parseFinalReplyDecision('Sure: {"needsDecision": true} done')).toBe(true);
    expect(parseFinalReplyDecision('{"needsDecision":false}')).toBe(false);
    expect(parseFinalReplyDecision('{"needsDecision":"true"}')).toBe(false);
    expect(parseFinalReplyDecision("yes")).toBe(false);
    expect(parseFinalReplyDecision('{"needsDecision":')).toBe(false);
  });
});

describe("judgeFinalReplyDecision", () => {
  it("asks one tool-less question on the given model and reads the verdict", async () => {
    const { run, runtime } = fakeRuntime('{"needsDecision":true}');

    const verdict = await judgeFinalReplyDecision({
      runtime,
      prisma: {} as never,
      model: checkerModel as AgentRunRequest["model"],
      reply: "Either raise the guard or exclude the folder?",
      ids: { spaceId: "space", userId: "user", botId: "bot" },
    });

    expect(verdict).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const [request] = run.mock.calls[0] as unknown as [AgentRunRequest];
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.model).toBe(checkerModel);
    expect(request.prompt).toContain("Either raise the guard");
  });

  it("rejects when the judge call fails, so the caller can let the reply through", async () => {
    const runtime = {
      run: () => {
        throw new Error("judge unavailable");
      },
    } as unknown as AgentRuntime;

    await expect(
      judgeFinalReplyDecision({
        runtime,
        prisma: {} as never,
        model: checkerModel as AgentRunRequest["model"],
        reply: "Either A or B?",
        ids: { spaceId: "space", userId: "user", botId: "bot" },
      }),
    ).rejects.toThrow("judge unavailable");
  });
});

describe("finalReplyDecisionJudge model choice", () => {
  beforeEach(() => {
    modelState.resolved.mockReset().mockResolvedValue(checkerModel);
    modelState.primary = null;
  });

  it("uses the approval checker when one is configured", async () => {
    modelState.primary = {
      provider: "checker-provider",
      modelId: "checker-model",
      credentialId: "cred",
    };
    const { run, runtime } = fakeRuntime('{"needsDecision":false}');
    const judge = finalReplyDecisionJudge({
      deps: { prisma: {}, runtime } as never,
      scope: { userId: "user", spaceId: "space", botId: "bot" },
      fallbackModel: mainModel as AgentRunRequest["model"],
      secrets: [],
      registerSecrets: () => {},
    });

    expect(await judge("Either A or B?")).toBe(false);
    expect(modelState.resolved).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "user", spaceId: "space", botId: "bot" },
      "checker-provider",
      "checker-model",
      expect.any(Function),
      false,
      undefined,
      "cred",
    );
    expect((run.mock.calls[0] as unknown as [AgentRunRequest])[0].model).toBe(checkerModel);
  });

  it("falls back to the run's own model when no checker is configured", async () => {
    const { run, runtime } = fakeRuntime('{"needsDecision":true}');
    const judge = finalReplyDecisionJudge({
      deps: { prisma: {}, runtime } as never,
      scope: { userId: "user", spaceId: "space", botId: "bot" },
      fallbackModel: mainModel as AgentRunRequest["model"],
      secrets: [],
      registerSecrets: () => {},
    });

    expect(await judge("Either A or B?")).toBe(true);
    expect(modelState.resolved).not.toHaveBeenCalled();
    expect((run.mock.calls[0] as unknown as [AgentRunRequest])[0].model).toBe(mainModel);
  });
});
