import { t } from "@lingui/core/macro";
import type { CommitChecksSource, CommitCheckTarget } from "@rakazo/chat-ui/native";
import { commitCheckSeconds } from "@rakazo/chat-ui/native";
import type { CommitCheck } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Alert, Linking, Platform } from "react-native";
import { useSpaceChanges } from "../api/roster-signals";
import { showIOSActionSheet } from "../native/ios-action-sheet";
import { queryClient, rpcQuery } from "../query/query";

function stateName(check: CommitCheck): string {
  switch (check.state) {
    case "queued":
      return t`Queued`;
    case "running":
      return t`Running`;
    case "passed":
      return t`Passed`;
    case "failed":
      return t`Failed`;
    case "skipped":
      return t`Skipped`;
  }
}

/** One check as a row of the sheet: its name, state and how long it took. */
function checkRow(check: CommitCheck): string {
  const seconds = commitCheckSeconds(check);
  const parts = [check.name, stateName(check)];
  if (seconds !== undefined)
    parts.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
  return parts.join(", ");
}

function openCheck(check: CommitCheck | undefined) {
  if (!check?.url) return;
  try {
    if (new URL(check.url).protocol !== "https:") return;
  } catch {
    return;
  }
  void Linking.openURL(check.url);
}

/**
 * Lists a commit's or pull request's checks in a native sheet. Tapping a check opens its page.
 * Android alerts hold few buttons, so there it opens the first failed check, or the first one.
 */
function openChecks(checks: readonly CommitCheck[], label: string) {
  const rows = checks.map(checkRow);
  if (Platform.OS === "ios") {
    showIOSActionSheet(
      { title: label, options: [...rows, t`Cancel`], cancelButtonIndex: rows.length },
      (index) => openCheck(checks[index]),
    );
    return;
  }
  const first = checks.find((check) => check.state === "failed") ?? checks[0];
  Alert.alert(label, rows.join("\n"), [
    { text: t`Cancel`, style: "cancel" },
    { text: t`Open`, onPress: () => openCheck(first) },
  ]);
}

/** Reads the checks a message link names, through the Space's own read. */
function useCommitChecks(target: CommitCheckTarget): readonly CommitCheck[] | undefined {
  const input =
    target.kind === "commit"
      ? { commits: [{ repository: target.repository, sha: target.sha }], pullRequests: [] }
      : { commits: [], pullRequests: [{ repository: target.repository, number: target.number }] };
  const { data } = useQuery(rpcQuery("commitChecks/list", input));
  if (!data) return undefined;
  return target.kind === "commit" ? data.commits[0]?.checks : data.pullRequests[0]?.checks;
}

export const commitChecksSource: CommitChecksSource = {
  use: useCommitChecks,
  open: (_target, checks, label) => openChecks(checks, label),
};

/** Re-reads the checks in view when the Space says one changed; the live stream is held while mounted. */
export function CommitChecksLive({ enabled }: { enabled: boolean }) {
  useSpaceChanges(
    "checks",
    () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes("commitChecks/list"),
      }),
    enabled,
  );
  return null;
}
