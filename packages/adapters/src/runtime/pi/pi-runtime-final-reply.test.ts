import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNFINISHED_WORK_CONTINUATION_PROMPT } from "../../runs/assembly/continuation.prompt.js";
import { UNDECIDED_ASK_CORRECTION_PROMPT } from "../../runs/assembly/final-reply-decision.prompt.js";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  return importOriginal<typeof AgentCore>();
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./models/pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("./models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const primary = model("provider-a", "primary");

function model(provider: string, id: string): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function reply(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
) {
  return {
    role: "assistant",
    content,
    api: primary.api,
    provider: primary.provider,
    model: primary.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

const prose = (text: string) => reply([{ type: "text", text }]);
const askCall = () =>
  reply(
    [
      {
        type: "toolCall",
        id: "ask-1",
        name: "ask_user",
        arguments: {
          question: "Which guard should win?",
          options: ["Raise the guard", "Exclude the folder"],
          recommended: "Raise the guard",
        },
      },
    ],
    "toolUse",
  );

/** A provider response: a stream of one completed assistant message. */
function stream(response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

const askUserTool = {
  name: "ask_user",
  description: "Ask the user and wait.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      recommended: { type: "string" },
    },
    required: ["question", "options"],
  },
  readOnly: true,
};

function request(finalReplyJudge?: AgentRunRequest["finalReplyJudge"]): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Snapshot guard: what should happen?",
    instructions: "Decide with the owner when a choice is needed.",
    history: [],
    tools: [askUserTool],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-key" },
    fallbackModels: [],
    executeTool: vi.fn(async () => ({ ok: true })),
    finalReplyJudge,
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

/** Text the model saw in a request, serialized, to tell the corrective turn apart. */
function sentTo(call: number): string {
  return JSON.stringify(providerState.stream.mock.calls[call]?.[1]?.messages ?? []);
}

const textOf = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(
    `${primary.provider}/${primary.id}`,
    primary as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("final reply decision hook", () => {
  it("turns a prose decision into one corrective turn that ends in an ask_user pause", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(prose("Decision for Joshua: either raise the guard, or exclude the folder.")),
      )
      .mockImplementationOnce(() => stream(askCall()));
    const judge = vi.fn(async (_reply: string) => true);

    const events = await run(request(judge));

    expect(judge).toHaveBeenCalledOnce();
    expect(judge.mock.calls[0]?.[0]).toContain("either raise the guard");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(sentTo(1)).toContain(UNDECIDED_ASK_CORRECTION_PROMPT);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "ask", text: "Which guard should win?" }),
    );
  });

  it("lets the reply through unchanged when the judge finds no decision", async () => {
    providerState.stream.mockImplementationOnce(() =>
      stream(prose("The snapshot is 310 MB, under the guard.")),
    );
    const judge = vi.fn(async (_reply: string) => false);

    const events = await run(request(judge));

    expect(judge).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(textOf(events)).toContain("The snapshot is 310 MB");
  });

  it("lets the reply through unchanged when the judge fails", async () => {
    providerState.stream.mockImplementationOnce(() =>
      stream(prose("Either raise the guard or exclude the folder?")),
    );
    const judge = vi.fn(async () => {
      throw new Error("judge unavailable");
    });

    const events = await run(request(judge));

    expect(judge).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(textOf(events)).toContain("Either raise the guard");
  });

  it("skips the judge when no judge is offered, the reply is silent, or ask_user already paused the turn", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(prose("Either raise the guard or exclude the folder?")))
      .mockImplementationOnce(() => stream(prose("NO_RESPONSE")))
      .mockImplementationOnce(() => stream(askCall()));
    const judge = vi.fn(async (_reply: string) => true);

    await run(request(undefined));
    await run(request(judge));
    expect(judge).not.toHaveBeenCalled();
    expect(providerState.stream).toHaveBeenCalledTimes(2);

    await run(request(judge));
    expect(judge).not.toHaveBeenCalled();
  });

  it("finishes unfinished checks before judging the completed reply, then pauses on ask_user", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(prose("Not checked yet:\n- commits\nNext I'll check the remaining files.")),
      )
      .mockImplementationOnce(() =>
        stream(prose("Checked all commits. Decision for owner: either option A or option B?")),
      )
      .mockImplementationOnce(() => stream(askCall()));
    const judge = vi.fn(async (_reply: string) => true);

    const events = await run(request(judge));

    // Turn 1 is an incomplete draft: unfinished-work nudge only, no judge call.
    expect(judge).toHaveBeenCalledOnce();
    expect(judge.mock.calls[0]?.[0]).toContain("Checked all commits");
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(sentTo(1)).toContain(UNFINISHED_WORK_CONTINUATION_PROMPT);
    expect(sentTo(1)).not.toContain(UNDECIDED_ASK_CORRECTION_PROMPT);
    expect(sentTo(2)).toContain(UNDECIDED_ASK_CORRECTION_PROMPT);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "ask", text: "Which guard should win?" }),
    );
  });

  it("does not correct a second time when the bot ignores the first correction", async () => {
    providerState.stream
      .mockImplementationOnce(() => stream(prose("Decision for Joshua: either A or B?")))
      .mockImplementationOnce(() => stream(prose("Still either A or B, your call.")));
    const judge = vi.fn(async (_reply: string) => true);

    const events = await run(request(judge));

    expect(judge).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(textOf(events)).toContain("Still either A or B");
  });
});
