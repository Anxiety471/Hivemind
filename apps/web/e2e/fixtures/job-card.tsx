import { I18nProvider } from "@lingui/react";
import type { ProductEvent } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import "../../src/styles.css";
import { FixtureTranscript, reduceThreadEvents } from "./thread-fixture";

// A coding job that finished: its output, changed files and steps, on placeholder names only.
const events: Partial<ProductEvent>[] = [
  {
    type: "thread.message.created",
    payload: {
      messageId: "user-1",
      role: "user",
      blocks: [{ kind: "text", text: "Upgrade the billing worker and report back." }],
    },
  },
  {
    type: "thread.message.created",
    payload: {
      messageId: "bot-job",
      role: "bot",
      blocks: [
        {
          kind: "job",
          jobId: "job-1",
          title: "billing-worker",
          state: "finished",
          reply: "Upgraded the worker and added a retry test for the invoice path.",
          agent: "pi",
          model: "example-model",
          effort: "high",
          branch: "example-org/billing-worker",
          commit: "fakesha0000",
          prUrl: "https://github.com/example-org/example-repo/pull/1",
          prLabel: "#1",
          repo: "example-org/example-repo",
          workspacePath: "/work/orca/worktrees/billing-worker",
          turn: 2,
          startedAt: 1_770_000_000_000,
          finishedAt: 1_770_000_065_000,
          stats: {
            filesChanged: 2,
            insertions: 42,
            deletions: 7,
            inputTokens: 41_200,
            outputTokens: 7_000,
            costUsd: 0.04,
          },
          files: [
            {
              path: "apps/api/src/billing/retry.ts",
              status: "modified",
              insertions: 30,
              deletions: 5,
            },
            {
              path: "apps/api/src/billing/retry.test.ts",
              status: "added",
              insertions: 12,
              deletions: 2,
            },
          ],
          steps: [
            { name: "pnpm test billing", kind: "command", status: "ok", durationMs: 4200 },
            { name: "Edit retry.ts", kind: "edit", status: "ok", durationMs: 900 },
          ],
        },
      ],
    },
  },
  { type: "run.completed" },
];
const snapshot = reduceThreadEvents(events);

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript
        messages={snapshot.messages}
        running={snapshot.run?.status === "running"}
        showToolActivity={false}
      />
    </I18nProvider>,
  );
});
