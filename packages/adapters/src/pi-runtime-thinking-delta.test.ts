import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => model(provider, id),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

function model(provider: string, id: string): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

const target = model("provider-a", "reasoning-model");

function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Answer the question",
    instructions: "Answer briefly.",
    history: [],
    tools: [],
    model: { provider: target.provider, id: target.id, apiKey: "fake-key" },
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest): Promise<AgentRuntimeEvent[]> {
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

/** A provider stream with reasoning before the answer, as a pi-ai reasoning model sends it. */
function thinkingStream() {
  const content: AssistantMessage["content"] = [];
  const assistant: AssistantMessage = {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const partial = () => ({ ...assistant, content: [...content] });
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: partial() });
  const thinking = { type: "thinking" as const, thinking: "" };
  content.push(thinking);
  stream.push({ type: "thinking_start", contentIndex: 0, partial: partial() });
  const deltas = ["plan the", " answer"];
  for (const delta of deltas) {
    thinking.thinking += delta;
    content[0] = { ...thinking };
    stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: partial() });
  }
  stream.push({
    type: "thinking_end",
    contentIndex: 0,
    content: thinking.thinking,
    partial: partial(),
  });
  const text = { type: "text" as const, text: "" };
  content.push(text);
  stream.push({ type: "text_start", contentIndex: 1, partial: partial() });
  text.text = "Hi";
  content[1] = { ...text };
  stream.push({ type: "text_delta", contentIndex: 1, delta: "Hi", partial: partial() });
  stream.push({ type: "text_end", contentIndex: 1, content: "Hi", partial: partial() });
  stream.push({ type: "done", reason: "stop", message: partial() });
  stream.end(partial());
  return stream;
}

beforeEach(() => {
  providerState.stream.mockReset();
  providerState.stream.mockImplementation(() => thinkingStream());
});

describe("Pi runtime provider reasoning", () => {
  it("streams reasoning as its own deltas between the thinking lifecycle markers", async () => {
    const events = await run(request());
    expect(events).toContainEqual({ type: "thinking", active: true });
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "plan the" },
      { type: "thinking_delta", text: " answer" },
    ]);
    // The provider lifecycle marks the stream, and reasoning never joins text.
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", active: true },
      { type: "thinking", active: false },
    ]);
  });

  it("never mixes reasoning into the reply's text events", async () => {
    const events = await run(request());
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "Hi" }]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Hi" });
  });
});
