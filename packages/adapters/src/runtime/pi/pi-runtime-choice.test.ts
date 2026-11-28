import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  options: ["Berlin", "Seoul", "Toronto"] as string[] | undefined,
  recommended: undefined as string | undefined,
  detail: undefined as string | undefined,
  ticketRef: undefined as string | undefined,
  items: undefined as unknown[] | undefined,
  tools: [] as Array<{
    name: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      const askUser = this.tools.find((tool) => tool.name === "ask_user");
      if (!askUser) throw new Error("ask_user tool missing");
      // The real agent prepares the model's arguments before executing them.
      const raw = {
        question: "Which city should I use?",
        options: fakeAgentState.options,
        ...(fakeAgentState.recommended === undefined
          ? {}
          : { recommended: fakeAgentState.recommended }),
        ...(fakeAgentState.detail === undefined ? {} : { detail: fakeAgentState.detail }),
        ...(fakeAgentState.ticketRef === undefined ? {} : { ticketRef: fakeAgentState.ticketRef }),
        ...(fakeAgentState.items === undefined ? {} : { items: fakeAgentState.items }),
      };
      const args = askUser.prepareArguments?.(raw) ?? raw;
      await askUser.execute("call-choice-1", args);
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "choice-pi-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
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

const choiceTool: ConnectorTool = {
  name: "ask_user",
  description: "Ask a short multiple-choice question",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      items: { type: "array", items: { type: "object" } },
    },
    required: ["question"],
  },
};

const runContext = {
  operationId: "choice-pi",
  traceId: "choice-pi",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const runRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "ask me which city to use",
  instructions: "Use ask_user for a short list of options.",
  history: [],
  tools: [choiceTool],
  model: { provider: "test", id: "choice-pi-model" },
};

describe("Pi choice asks", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.options = ["Berlin", "Seoul", "Toronto"];
    fakeAgentState.recommended = undefined;
    fakeAgentState.detail = undefined;
    fakeAgentState.items = undefined;
    fakeAgentState.ticketRef = undefined;
  });

  it("emits a tappable ask and stops without a finished-work fallback", async () => {
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
        { id: "choice-3", label: "Toronto" },
      ],
    });
    expect(
      events.some((event) => event.type === "text" && event.text.includes("I finished the work.")),
    ).toBe(false);
  });

  it("carries the content the user is deciding on as the ask's detail", async () => {
    fakeAgentState.detail = "To: person@example.test\nSubject: Hello\n\nThe draft body.";
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      detail: "To: person@example.test\nSubject: Hello\n\nThe draft body.",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
        { id: "choice-3", label: "Toronto" },
      ],
    });
  });

  it("rejects an empty choice set before emitting an ask", async () => {
    fakeAgentState.options = [];
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    await expect(async () => {
      for await (const event of runtime.run(runRequest, runContext)) events.push(event);
    }).rejects.toThrow("ask_user requires two to four unique, non-empty options");
    expect(events.some((event) => event.type === "ask")).toBe(false);
  });

  it("marks the matching ask_user option as recommended and rejects an unknown recommendation", async () => {
    fakeAgentState.recommended = "Seoul";
    const runtime = new PiAgentRuntime();
    const events: AgentRuntimeEvent[] = [];

    for await (const event of runtime.run(runRequest, runContext)) events.push(event);

    expect(events).toContainEqual({
      type: "ask",
      text: "Which city should I use?",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul", recommended: true },
        { id: "choice-3", label: "Toronto" },
      ],
    });

    fakeAgentState.recommended = "Tokyo";
    await expect(async () => {
      for await (const _event of runtime.run(runRequest, runContext)) {
        // exhaust generator
      }
    }).rejects.toThrow("ask_user recommended option must match one of the provided options");
  });

  describe("single ask ticket ref", () => {
    it("forwards a trimmed ticketRef on the single ask event", async () => {
      fakeAgentState.ticketRef = "  OPS-12 ";
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];

      for await (const event of runtime.run(runRequest, runContext)) events.push(event);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "ask",
          text: "Which city should I use?",
          ticketRef: "OPS-12",
        }),
      );
    });

    it("omits ticketRef when the call names no ticket", async () => {
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];

      for await (const event of runtime.run(runRequest, runContext)) events.push(event);

      const ask = events.find((event) => event.type === "ask");
      expect(ask).toBeDefined();
      expect(ask).not.toHaveProperty("ticketRef");
    });
  });

  describe("batch triage items", () => {
    const actionItem = {
      question: "Ship the release notes?",
      detail: "Draft is in the thread.",
      ticketRef: "OPS-12",
      options: ["Ship", "Hold"],
      recommended: "hold",
    };
    const fyiItem = { question: "Nightly build passed", ticketRef: "CI-4" };

    beforeEach(() => {
      fakeAgentState.options = undefined;
    });

    it("emits one ask with actionable and FYI items and a deterministic id per item", async () => {
      fakeAgentState.items = [actionItem, fyiItem];
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];

      for await (const event of runtime.run(runRequest, runContext)) events.push(event);

      expect(events).toContainEqual({
        type: "ask",
        text: "Which city should I use?",
        items: [
          {
            id: "item-1",
            question: "Ship the release notes?",
            detail: "Draft is in the thread.",
            ticketRef: "OPS-12",
            actions: [
              { id: "choice-1", label: "Ship" },
              { id: "choice-2", label: "Hold", recommended: true },
            ],
          },
          { id: "item-2", question: "Nightly build passed", ticketRef: "CI-4" },
        ],
      });
    });

    it("rejects options and items together", async () => {
      fakeAgentState.options = ["Berlin", "Seoul"];
      fakeAgentState.items = [actionItem];
      const runtime = new PiAgentRuntime();

      await expect(async () => {
        for await (const _event of runtime.run(runRequest, runContext)) {
          // exhaust generator
        }
      }).rejects.toThrow("ask_user takes either options or items, not both");
    });

    it("rejects a batch with no actionable item", async () => {
      fakeAgentState.items = [fyiItem];
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];

      await expect(async () => {
        for await (const event of runtime.run(runRequest, runContext)) events.push(event);
      }).rejects.toThrow("ask_user items need at least one item with options");
      expect(events.some((event) => event.type === "ask")).toBe(false);
    });

    it("rejects an unknown recommendation on an item", async () => {
      fakeAgentState.items = [{ ...actionItem, recommended: "Tokyo" }, fyiItem];
      const runtime = new PiAgentRuntime();

      await expect(async () => {
        for await (const _event of runtime.run(runRequest, runContext)) {
          // exhaust generator
        }
      }).rejects.toThrow("ask_user item recommended must match one of its options");
    });

    it("rejects more than eight items", async () => {
      fakeAgentState.items = Array.from({ length: 9 }, (_, index) => ({
        question: `Item ${index + 1}`,
        options: ["Yes", "No"],
      }));
      const runtime = new PiAgentRuntime();

      await expect(async () => {
        for await (const _event of runtime.run(runRequest, runContext)) {
          // exhaust generator
        }
      }).rejects.toThrow("ask_user items takes one to 8 items");
    });
  });
});
