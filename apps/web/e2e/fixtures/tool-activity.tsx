import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { toolActivityPreference } from "../../src/lib/chat/tool-activity-preference";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { queryClient } from "../../src/lib/query/query";
import { rpc } from "../../src/lib/query/rpc";
import { SettingsOverlay } from "../../src/pages/settings/SettingsOverlay";
import type { TranscriptRunSummary } from "../../src/pages/shell/chat/transcript";
import "../../src/styles.css";
import { BOT, FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const phaseParam = params.get("phase");
const phase: "live" | "done" | "approval" | "rewound" =
  phaseParam === "live" || phaseParam === "approval" || phaseParam === "rewound"
    ? phaseParam
    : "done";

if (params.get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

const USER_TEXT = "Find a free slot on Tuesday.";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const NOTE_TEXT = "Anna is free all Tuesday afternoon.";
const MODEL_ID = "claude-opus-5-5";
const BASE_MS = Date.parse("2026-08-16T00:00:01.000Z");

const STEP_LABELS = [
  "Open calendar",
  "Read events",
  "Search inbox",
  "Read message",
  "Check time zones",
  "Compare calendars",
  "Draft invite",
  "Check conflicts",
];

const thinkingBlock: MessageBlock = {
  kind: "thinking",
  durationMs: phase === "live" ? 1_200 : 2_400,
  lines: ["The person needs a free slot on Tuesday.", "Checking Tuesday afternoon first."],
};

function buildStepsBlock(): Extract<MessageBlock, { kind: "steps" }> {
  if (phase === "approval") {
    return {
      kind: "steps",
      modelId: MODEL_ID,
      costUsd: 0.055,
      steps: [
        {
          label: "Built the preview in 41s",
          count: 1,
          startedAtMs: BASE_MS,
          durationMs: 2_600,
          status: "done",
          detail: "pnpm --filter @rakazo/web build",
        },
        {
          label: "Drafted the release notes",
          count: 1,
          startedAtMs: BASE_MS + 2_700,
          durationMs: 2_800,
          status: "done",
          detail: "RELEASE.md",
        },
        {
          label: "Compared 38 commits",
          count: 1,
          startedAtMs: BASE_MS + 5_600,
          durationMs: 2_300,
          status: "done",
          detail: "git log v3.1..main",
        },
      ],
    };
  }

  if (phase === "rewound") {
    return {
      kind: "steps",
      modelId: MODEL_ID,
      costUsd: 0.064,
      attempts: 2,
      durationMs: 9_800,
      status: "completed",
      steps: [
        {
          label: "Open calendar",
          count: 1,
          attempt: 1,
          startedAtMs: BASE_MS,
          durationMs: 1_200,
          status: "done",
        },
        {
          label: "Read events",
          count: 1,
          attempt: 1,
          startedAtMs: BASE_MS + 1_300,
          durationMs: 900,
          status: "stopped",
        },
        {
          label: "Draft invite",
          count: 1,
          attempt: 1,
          startedAtMs: BASE_MS + 2_300,
          durationMs: 700,
          status: "stopped",
        },
        {
          label: "Compare calendars",
          count: 1,
          attempt: 2,
          forkedFromStep: 0,
          startedAtMs: BASE_MS + 3_200,
          durationMs: 2_400,
          status: "done",
        },
        {
          label: "Check conflicts",
          count: 1,
          attempt: 2,
          startedAtMs: BASE_MS + 5_700,
          durationMs: 1_900,
          status: "done",
          note: NOTE_TEXT,
        },
      ],
    };
  }

  return {
    kind: "steps",
    modelId: MODEL_ID,
    costUsd: phase === "live" ? 0.039 : 0.055,
    status: phase === "live" ? undefined : "completed",
    ...(phase === "live" ? {} : { durationMs: 12_400 }),
    steps: STEP_LABELS.map((label, index) => {
      const isLast = index === STEP_LABELS.length - 1;
      const isLiveLast = phase === "live" && isLast;
      return {
        label,
        count: 1,
        startedAtMs: BASE_MS + index * 1_500,
        ...(isLiveLast ? {} : { durationMs: 1_400 + index * 50 }),
        status: isLiveLast ? "running" : "done",
        ...(label === "Check conflicts"
          ? {
              detail: "calendar.freeBusy({ day: 'Tuesday' })",
              ...(phase === "live" ? {} : { note: NOTE_TEXT }),
            }
          : {}),
      };
    }),
  };
}

const approvalAskBlock: MessageBlock = {
  kind: "ask",
  approvalEffectId: "effect-release",
  text: "Ready to ship",
  detail: "gh release create v3.2.0",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Decline" },
  ],
};

const createdAt = "2026-08-16T00:00:01.000Z";
const liveStartedAt = new Date(Date.now() - 8_000).toISOString();

function buildInitialMessages(): ThreadMessage[] {
  const userMsg: ThreadMessage = {
    id: "user-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
    createdAt,
  };

  const stepsBlock = buildStepsBlock();
  if (phase === "live") {
    return [
      userMsg,
      {
        id: "progress:run-1",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [thinkingBlock, stepsBlock],
        botId: BOT.botId,
        runId: "run-1",
        createdAt,
      },
    ];
  }

  if (phase === "approval") {
    return [
      userMsg,
      {
        id: "bot-approval",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [stepsBlock, approvalAskBlock],
        botId: BOT.botId,
        runId: "run-1",
        createdAt,
      },
    ];
  }

  return [
    userMsg,
    {
      id: "bot-reply",
      threadId: "thread-1",
      seq: 2,
      role: "bot",
      blocks: [thinkingBlock, stepsBlock, { kind: "text", text: REPLY_TEXT }],
      botId: BOT.botId,
      runId: "run-1",
      createdAt,
    },
  ];
}

const initialRunSummary: TranscriptRunSummary = {
  id: "run-1",
  botId: BOT.botId,
  modelId: MODEL_ID,
  costUsd: phase === "live" ? 0.039 : phase === "rewound" ? 0.064 : 0.055,
  startedAt: phase === "live" ? liveStartedAt : createdAt,
  status: phase === "live" ? "running" : phase === "approval" ? "waiting_input" : "completed",
};

function ThreadFixture() {
  const showToolActivity = toolActivityPreference.use();
  const [messages, setMessages] = useState<ThreadMessage[]>(buildInitialMessages);
  const [answerableAskIds, setAnswerableAskIds] = useState<Set<string>>(() =>
    phase === "approval" ? new Set(["bot-approval"]) : new Set(),
  );
  const [running, setRunning] = useState(phase === "live");
  const [runSummary, setRunSummary] = useState<TranscriptRunSummary>(initialRunSummary);

  return (
    <FixtureTranscript
      messages={messages}
      running={running}
      showToolActivity={showToolActivity}
      answerableAskIds={answerableAskIds}
      activeRun={phase === "live" || phase === "approval" ? runSummary : null}
      threadRuns={[runSummary]}
      onStop={() => {
        setRunning(false);
        setRunSummary((prev) => ({ ...prev, status: "cancelled" }));
      }}
      onAnswer={async (_message, choice) => {
        setAnswerableAskIds(new Set());
        setRunSummary((prev) => ({
          ...prev,
          status: choice === "allow" ? "completed" : "cancelled",
        }));
        setMessages((prev) =>
          prev.map((msg) => ({
            ...msg,
            blocks: msg.blocks.map((block) =>
              block.kind === "ask" ? { ...block, status: "answered", answer: choice } : block,
            ),
          })),
        );
      }}
      onRewind={async ({ stepIndex }) => {
        setMessages((prev) =>
          prev.map((msg) => ({
            ...msg,
            blocks: msg.blocks.map((block) => {
              if (block.kind !== "steps") return block;
              return {
                ...block,
                attempts: (block.attempts ?? 1) + 1,
                steps: [
                  ...block.steps.map((step, idx) =>
                    idx > stepIndex
                      ? { ...step, attempt: 1, status: "stopped" as const }
                      : { ...step, attempt: 1 },
                  ),
                  {
                    label: `Retry from ${block.steps[stepIndex]?.label ?? "step"}`,
                    count: 1,
                    attempt: (block.attempts ?? 1) + 1,
                    forkedFromStep: stepIndex,
                    status: "done" as const,
                    durationMs: 1_200,
                  },
                ],
              };
            }),
          })),
        );
      }}
    />
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SettingsOverlay
        shellRpc={rpc}
        email="owner@example.test"
        name="Owner"
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        timezone="UTC"
        onTimezoneChange={async () => {}}
        labs={[]}
        labsAvailable={[]}
        onLabsChange={async () => {}}
        onClose={() => {}}
        section="general"
        onSectionChange={() => {}}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        {view === "settings" ? <SettingsFixture /> : <ThreadFixture />}
      </I18nProvider>
    </QueryClientProvider>,
  );
});
