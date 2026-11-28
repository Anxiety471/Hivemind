import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { resolveJobCommitUrl } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { httpsUrl } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { typeScale } from "@rakazo/ui-tokens";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useChatReferences } from "../../lib/board/chat-references";

type JobBlock = Extract<MessageBlock, { kind: "job" }>;

/** Seconds as `1:04`, matching the web card's clock. */
function clock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A job card is live while the job runs: its elapsed time counts up from when it started. */
function liveJob(block: JobBlock): boolean {
  return block.state === "starting" || block.state === "working";
}

/**
 * A job a tool started somewhere else, drawn from that tool's own result. The web card says the
 * same thing with the same rules; this one is the native row, opened as a link.
 */
export function JobCard({ block }: { block: JobBlock }) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const live = liveJob(block);
  const now = useNow(live && block.startedAt !== undefined ? 1_000 : null);
  const elapsedMs = live && block.startedAt !== undefined ? now - block.startedAt : undefined;
  const label =
    block.state === "starting"
      ? t`Starting`
      : block.state === "working"
        ? t`Working`
        : block.state === "finished"
          ? t`Finished`
          : block.state === "needs_input"
            ? t`Needs input`
            : block.state === "timed_out"
              ? t`Timed out`
              : t`Exited`;
  const tone =
    block.state === "finished"
      ? tokens.success
      : block.state === "exited" || block.state === "timed_out"
        ? tokens.mutedForeground
        : tokens.warning;
  const reply = block.reply?.trim();
  const href = httpsUrl(block.url);
  const { referenceContext } = useChatReferences();
  const prHref = httpsUrl(block.prUrl);
  const commitHref = resolveJobCommitUrl(
    { repo: block.repo, prUrl: block.prUrl, url: block.url, commit: block.commit },
    referenceContext?.repositories,
  );
  return (
    <Pressable
      onPress={() => {
        if (href) void bestEffort("open job", Linking.openURL(href));
      }}
      disabled={!href}
      testID="job-card"
      accessibilityRole={href ? "link" : "text"}
      accessibilityLabel={`${block.title}: ${label}${elapsedMs === undefined ? "" : `, ${clock(elapsedMs)}`}`}
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}
        >
          {block.title}
        </Text>
        <Text style={{ color: tone, ...typeScale.caption }}>
          {elapsedMs === undefined ? label : `${label} ${clock(elapsedMs)}`}
        </Text>
      </View>
      {block.agent || block.branch ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {block.agent ? (
            <Text
              numberOfLines={1}
              style={{ flexShrink: 0, color: tokens.mutedForeground, ...typeScale.secondary }}
            >
              {block.agent}
            </Text>
          ) : null}
          {block.branch ? (
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, color: tokens.mutedForeground, ...typeScale.secondary }}
            >
              {block.branch}
            </Text>
          ) : null}
        </View>
      ) : null}
      {block.commit || prHref ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {block.commit ? (
            <Pressable
              disabled={!commitHref}
              onPress={() => {
                if (commitHref) void bestEffort("open commit", Linking.openURL(commitHref));
              }}
              accessibilityRole={commitHref ? "link" : "text"}
              accessibilityLabel={t`Commit ${block.commit.slice(0, 7)}`}
            >
              <Text
                style={{
                  color: commitHref ? tokens.foreground : tokens.mutedForeground,
                  fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
                  ...typeScale.caption,
                }}
              >
                {block.commit.slice(0, 7)}
              </Text>
            </Pressable>
          ) : null}
          {prHref ? (
            <Pressable
              onPress={() => void bestEffort("open pull request", Linking.openURL(prHref))}
              accessibilityRole="link"
              accessibilityLabel={block.prLabel || t`Pull request`}
            >
              <Text style={{ color: tokens.foreground, ...typeScale.caption }}>
                {block.prLabel || t`Pull request`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {reply && !live ? (
        <Text numberOfLines={3} style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {reply}
        </Text>
      ) : null}
      {href ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{t`Open`}</Text>
      ) : null}
    </Pressable>
  );
}
