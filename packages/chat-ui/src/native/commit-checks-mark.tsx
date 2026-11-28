import type { ReactNode } from "react";
import { useContext } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { CommitCheckTarget } from "../commit-checks";
import { CommitChecksContext, summarizeCommitChecks } from "../commit-checks";
import { useMarkdownCopy } from "../markdown-copy";
import { InlineChipsContext } from "./chips";

/**
 * The CI status beside a commit or pull request link in a message, drawn inline with the text.
 * Tapping it hands the checks to the app, which shows them in a native sheet. Nothing shows
 * without data.
 */
export function CommitChecksMark({ target }: { target: CommitCheckTarget }): ReactNode {
  const source = useContext(CommitChecksContext);
  const { palette } = useContext(InlineChipsContext);
  const copy = useMarkdownCopy();
  const checks = source.use(target);
  const summary = summarizeCommitChecks(checks);
  if (!summary || !checks || !source.open) return null;
  const label =
    summary.tone === "failed"
      ? copy.checksFailed
      : summary.tone === "passed"
        ? copy.checksPassed
        : copy.checksProgress(summary.passed, summary.total);
  const color =
    summary.tone === "failed"
      ? palette.destructive
      : summary.tone === "passed"
        ? palette.success
        : palette.mutedForeground;
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => source.open?.(target, checks, label)}
    >
      <View style={markStyle}>
        {summary.tone === "running" ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <Text style={[glyphStyle, { color }]}>{summary.tone === "passed" ? "✓" : "✕"}</Text>
        )}
      </View>
    </Text>
  );
}

// A 16pt mark that sits on the line like the page chip's icon.
const markStyle = {
  width: 16,
  height: 16,
  marginStart: 4,
  transform: [{ translateY: 3 }],
} as const;
const glyphStyle = {
  fontSize: 13,
  fontWeight: "700",
  lineHeight: 16,
  textAlign: "center",
} as const;
